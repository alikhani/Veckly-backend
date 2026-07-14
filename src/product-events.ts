import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { requireAuth, type AuthedUser } from './auth.js'
import { assertMembership } from './membership.js'
import { withRls } from './rls.js'
import { productEvents } from './schema.js'
import type { Db } from './db.js'

const ProductEventNameSchema = z.enum([
  'onboarding_completed',
  'first_week_generated',
  'week_completed',
  'shopping_opened_after_week_completed',
  'shopping_shared',
  'partner_invite_clicked',
  'shopping_main_list_completed',
  'retro_completed',
]).openapi('ProductEventName')

const ProductEventPropertiesSchema = z.record(z.unknown()).openapi('ProductEventProperties')

const ProductEventSchema = z.object({
  id: z.string().uuid(),
  householdId: z.string().uuid(),
  userId: z.string().uuid(),
  eventName: ProductEventNameSchema,
  weekStartDate: z.string().nullable(),
  properties: ProductEventPropertiesSchema,
  occurredAt: z.string(),
}).openapi('ProductEvent')

const CreateProductEventSchema = z.object({
  eventName: ProductEventNameSchema,
  weekStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD').optional(),
  properties: ProductEventPropertiesSchema.optional().default({}),
}).openapi('CreateProductEvent')

const HouseholdParamsSchema = z.object({ householdId: z.string().uuid() })

function toProductEvent(row: typeof productEvents.$inferSelect) {
  return {
    id: row.id,
    householdId: row.householdId,
    userId: row.userId,
    eventName: row.eventName,
    weekStartDate: row.weekStartDate,
    properties: row.properties as Record<string, unknown>,
    occurredAt: row.occurredAt.toISOString(),
  }
}

export async function createProductEvent(
  db: Db,
  accessToken: string,
  userId: string,
  householdId: string,
  input: z.infer<typeof CreateProductEventSchema>,
) {
  return withRls(db, accessToken, async (tx) => {
    const [row] = await tx
      .insert(productEvents)
      .values({
        householdId,
        userId,
        eventName: input.eventName,
        weekStartDate: input.weekStartDate ?? null,
        properties: input.properties,
      })
      .returning()
    if (!row) throw new Error('Insert did not return the persisted product event')
    return toProductEvent(row)
  })
}

const createProductEventRoute = createRoute({
  method: 'post',
  path: '/households/{householdId}/product-events',
  operationId: 'createProductEvent',
  summary: 'Record a beta product analytics event for a household',
  security: [{ bearerAuth: [] }],
  request: {
    params: HouseholdParamsSchema,
    body: { content: { 'application/json': { schema: CreateProductEventSchema } } },
  },
  responses: {
    201: {
      description: 'Product event recorded',
      content: { 'application/json': { schema: ProductEventSchema } },
    },
    404: { description: 'Household not found or caller is not a member' },
    401: { description: 'Missing or invalid session' },
  },
})

export function buildProductEventsRoutes(db: Db) {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()

  app.use('/households/*', requireAuth)

  app.openapi(createProductEventRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId } = c.req.valid('param')
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' }, 404)

    const event = await createProductEvent(db, accessToken, user.id, householdId, c.req.valid('json'))
    return c.json(event, 201)
  })

  return app
}
