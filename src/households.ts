import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { eq } from 'drizzle-orm'
import { requireAuth, type AuthedUser } from './auth.js'
import { withRls } from './rls.js'
import { households, householdMemberships } from './schema.js'
import type { Db } from './db.js'

const HouseholdSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  role: z.enum(['owner', 'member']),
}).openapi('Household')

const MyHouseholdsResponseSchema = z.object({
  households: z.array(HouseholdSchema),
}).openapi('MyHouseholdsResponse')

const getMyHouseholds = createRoute({
  method: 'get',
  path: '/households/me',
  summary: "List the households the authenticated user belongs to",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Households the authenticated user has an active membership in',
      content: { 'application/json': { schema: MyHouseholdsResponseSchema } },
    },
    401: { description: 'Missing or invalid session' },
  },
})

export function buildHouseholdsRoutes(db: Db) {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()

  app.use('/households/*', requireAuth)

  app.openapi(getMyHouseholds, async (c) => {
    const accessToken = c.get('accessToken')

    // Plain selects scoped only by `auth.uid()` via RLS — no `where userId = ...`
    // here. That's the point: even if this query were written wrong (or a future
    // route forgot to scope it), the database would still only return rows this
    // user is allowed to see.
    const rows = await withRls(db, accessToken, (tx) =>
      tx
        .select({ id: households.id, name: households.name, role: householdMemberships.role })
        .from(householdMemberships)
        .innerJoin(households, eq(households.id, householdMemberships.householdId))
        .where(eq(householdMemberships.status, 'active')),
    )

    return c.json({ households: rows.map((row) => ({ id: row.id, name: row.name, role: row.role })) }, 200)
  })

  return app
}
