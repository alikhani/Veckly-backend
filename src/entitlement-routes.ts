import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { requireAuth, type AuthedUser } from './auth.js'
import { resolveEntitlementForHousehold, resolveEntitlementForUser } from './entitlements.js'
import { assertMembership } from './membership.js'
import type { Db } from './db.js'

const EntitlementSchema = z.object({
  tier: z.enum(['free', 'premium']),
  // Present for the user aggregate only when a household currently has
  // Premium. Never exposes provider ids, billing metadata, or expiry dates.
  householdId: z.string().uuid().nullable(),
  source: z.enum(['subscription', 'manual', 'beta']).nullable(),
  gatesEnabled: z.boolean(),
}).openapi('Entitlement')

const EntitlementResponseSchema = z.object({ entitlement: EntitlementSchema }).openapi('EntitlementResponse')
const HouseholdParamsSchema = z.object({ householdId: z.string().uuid() })

const getMyEntitlementRoute = createRoute({
  method: 'get',
  path: '/users/me/entitlement',
  operationId: 'getMyEntitlement',
  summary: 'Resolve the authenticated user’s current household entitlement',
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: 'Safe entitlement state', content: { 'application/json': { schema: EntitlementResponseSchema } } },
    401: { description: 'Missing or invalid session' },
  },
})

const getHouseholdEntitlementRoute = createRoute({
  method: 'get',
  path: '/households/{householdId}/entitlement',
  operationId: 'getHouseholdEntitlement',
  summary: 'Resolve entitlement for one active household membership',
  security: [{ bearerAuth: [] }],
  request: { params: HouseholdParamsSchema },
  responses: {
    200: { description: 'Safe household entitlement state', content: { 'application/json': { schema: EntitlementResponseSchema } } },
    401: { description: 'Missing or invalid session' },
    404: { description: 'Household not found or caller is not a member' },
  },
})

export function buildEntitlementRoutes(db: Db) {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()

  app.use('/users/me/entitlement', requireAuth)
  app.openapi(getMyEntitlementRoute, async (c) => {
    const entitlement = await resolveEntitlementForUser(db, c.get('user').id)
    return c.json({ entitlement }, 200)
  })

  app.use('/households/*', requireAuth)
  app.openapi(getHouseholdEntitlementRoute, async (c) => {
    const { householdId } = c.req.valid('param')
    const user = c.get('user')
    const accessToken = c.get('accessToken')
    const membership = await assertMembership(db, accessToken, householdId, user.id)
    if (!membership) return c.json({ error: 'Household not found' }, 404)

    // Use the household-scoped resolver after membership authorization; never
    // substitute a premium result from another household the caller belongs to.
    const entitlement = await resolveEntitlementForHousehold(db, user.id, householdId)
    return c.json({ entitlement }, 200)
  })

  return app
}
