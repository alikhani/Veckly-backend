import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, desc, eq } from 'drizzle-orm'
import { requireAuth, type AuthedUser } from './auth.js'
import { assertMembership } from './membership.js'
import { withRls } from './rls.js'
import { householdMealSignals } from './schema.js'
import type { Db } from './db.js'

const HouseholdMealSignalSchema = z.enum(['works_for_family', 'not_for_us']).openapi('HouseholdMealSignal')

const HouseholdMealSignalRecordSchema = z.object({
  householdId: z.string().uuid(),
  mealId: z.string().min(1),
  signal: HouseholdMealSignalSchema,
  updatedAt: z.string(),
}).openapi('HouseholdMealSignalRecord')

const HouseholdMealSignalStateSchema = z.record(HouseholdMealSignalSchema).openapi('HouseholdMealSignalState')

const ListHouseholdMealSignalsResponseSchema = z.object({
  signals: HouseholdMealSignalStateSchema,
  items: z.array(HouseholdMealSignalRecordSchema),
}).openapi('ListHouseholdMealSignalsResponse')

const UpsertHouseholdMealSignalSchema = z.object({
  mealId: z.string().min(1),
  signal: HouseholdMealSignalSchema.nullable(),
}).openapi('UpsertHouseholdMealSignal')

const HouseholdParamsSchema = z.object({ householdId: z.string().uuid() })
const OkResponseSchema = z.object({ ok: z.literal(true) }).openapi('OkResponse')

function toHouseholdMealSignalRecord(row: typeof householdMealSignals.$inferSelect) {
  return {
    householdId: row.householdId,
    mealId: row.mealId,
    signal: row.signal,
    updatedAt: row.updatedAt.toISOString(),
  }
}

export async function listHouseholdMealSignals(db: Db, accessToken: string, householdId: string) {
  return withRls(db, accessToken, async (tx) => {
    const rows = await tx
      .select()
      .from(householdMealSignals)
      .where(eq(householdMealSignals.householdId, householdId))
      .orderBy(desc(householdMealSignals.updatedAt))

    const records = rows.map(toHouseholdMealSignalRecord)
    return {
      signals: Object.fromEntries(records.map((record) => [record.mealId, record.signal])),
      items: records,
    }
  })
}

export async function upsertHouseholdMealSignal(
  db: Db,
  accessToken: string,
  userId: string,
  householdId: string,
  mealId: string,
  signal: z.infer<typeof HouseholdMealSignalSchema>,
) {
  return withRls(db, accessToken, async (tx) => {
    const now = new Date()
    const [row] = await tx
      .insert(householdMealSignals)
      .values({
        householdId,
        mealId,
        signal,
        updatedBy: userId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [householdMealSignals.householdId, householdMealSignals.mealId],
        set: {
          signal,
          updatedBy: userId,
          updatedAt: now,
        },
      })
      .returning()
    if (!row) throw new Error('Upsert did not return the persisted household meal signal')
    return toHouseholdMealSignalRecord(row)
  })
}

export async function removeHouseholdMealSignal(db: Db, accessToken: string, householdId: string, mealId: string) {
  return withRls(db, accessToken, async (tx) => {
    await tx
      .delete(householdMealSignals)
      .where(and(eq(householdMealSignals.householdId, householdId), eq(householdMealSignals.mealId, mealId)))
  })
}

const listHouseholdMealSignalsRoute = createRoute({
  method: 'get',
  path: '/households/{householdId}/meal-signals',
  operationId: 'listHouseholdMealSignals',
  summary: "List the household's shared meal signals",
  security: [{ bearerAuth: [] }],
  request: { params: HouseholdParamsSchema },
  responses: {
    200: {
      description: 'Household meal signals keyed by meal id, plus ordered records',
      content: { 'application/json': { schema: ListHouseholdMealSignalsResponseSchema } },
    },
    404: { description: 'Household not found or caller is not a member' },
    401: { description: 'Missing or invalid session' },
  },
})

const upsertHouseholdMealSignalRoute = createRoute({
  method: 'put',
  path: '/households/{householdId}/meal-signals',
  operationId: 'upsertHouseholdMealSignal',
  summary: 'Upsert or remove a shared household meal signal',
  security: [{ bearerAuth: [] }],
  request: {
    params: HouseholdParamsSchema,
    body: { content: { 'application/json': { schema: UpsertHouseholdMealSignalSchema } } },
  },
  responses: {
    200: { description: 'Household signal saved or removed', content: { 'application/json': { schema: OkResponseSchema } } },
    404: { description: 'Household not found or caller is not a member' },
    401: { description: 'Missing or invalid session' },
  },
})

export function buildHouseholdMealSignalsRoutes(db: Db) {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()

  app.use('/households/*', requireAuth)

  app.openapi(listHouseholdMealSignalsRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId } = c.req.valid('param')
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' }, 404)
    const response = await listHouseholdMealSignals(db, accessToken, householdId)
    return c.json(response, 200)
  })

  app.openapi(upsertHouseholdMealSignalRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId } = c.req.valid('param')
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' }, 404)
    const { mealId, signal } = c.req.valid('json')
    if (signal === null) {
      await removeHouseholdMealSignal(db, accessToken, householdId, mealId)
    } else {
      await upsertHouseholdMealSignal(db, accessToken, user.id, householdId, mealId, signal)
    }
    return c.json({ ok: true }, 200)
  })

  return app
}
