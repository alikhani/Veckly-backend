import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, desc, eq } from 'drizzle-orm'
import { requireAuth, type AuthedUser } from './auth.js'
import { withRls } from './rls.js'
import { mealFeedback } from './schema.js'
import type { Db } from './db.js'

const MealFeedbackVoteSchema = z.enum(['up', 'down']).openapi('MealFeedbackVote')
const MealFeedbackSignalSchema = z.enum([
  'easy-weeknight',
  'family-approved',
  'good-leftovers',
  'too-much-effort',
  'family-pushback',
  'poor-leftovers',
]).openapi('MealFeedbackSignal')

const MealFeedbackEntrySchema = z.object({
  vote: MealFeedbackVoteSchema,
  signal: MealFeedbackSignalSchema.optional(),
}).openapi('MealFeedbackEntry')

const MealFeedbackRecordSchema = z.object({
  householdId: z.string().uuid(),
  userId: z.string().uuid(),
  mealId: z.string().min(1),
  feedback: MealFeedbackEntrySchema,
  updatedAt: z.string(),
}).openapi('MealFeedbackRecord')

const MealFeedbackStateSchema = z.record(MealFeedbackEntrySchema).openapi('MealFeedbackState')
const ListMealFeedbackResponseSchema = z.object({
  feedback: MealFeedbackStateSchema,
  items: z.array(MealFeedbackRecordSchema),
}).openapi('ListMealFeedbackResponse')

const UpsertMealFeedbackSchema = z.object({
  mealId: z.string().min(1),
  feedback: MealFeedbackEntrySchema.nullable(),
}).openapi('UpsertMealFeedback')

const HouseholdParamsSchema = z.object({ householdId: z.string().uuid() })
const OkResponseSchema = z.object({ ok: z.literal(true) }).openapi('OkResponse')

function toMealFeedbackRecord(row: typeof mealFeedback.$inferSelect) {
  return {
    householdId: row.householdId,
    userId: row.userId,
    mealId: row.mealId,
    feedback: {
      vote: row.vote,
      ...(row.signal ? { signal: row.signal } : {}),
    },
    updatedAt: row.updatedAt.toISOString(),
  }
}

export async function listMealFeedback(db: Db, accessToken: string, userId: string, householdId: string) {
  return withRls(db, accessToken, async (tx) => {
    const rows = await tx
      .select()
      .from(mealFeedback)
      .where(and(eq(mealFeedback.householdId, householdId), eq(mealFeedback.userId, userId)))
      .orderBy(desc(mealFeedback.updatedAt))

    const records = rows.map(toMealFeedbackRecord)
    return {
      feedback: Object.fromEntries(records.map((record) => [record.mealId, record.feedback])),
      items: records,
    }
  })
}

export async function upsertMealFeedback(
  db: Db,
  accessToken: string,
  userId: string,
  householdId: string,
  mealId: string,
  feedback: z.infer<typeof MealFeedbackEntrySchema>,
) {
  return withRls(db, accessToken, async (tx) => {
    const now = new Date()
    const [row] = await tx
      .insert(mealFeedback)
      .values({
        householdId,
        userId,
        mealId,
        vote: feedback.vote,
        signal: feedback.signal ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [mealFeedback.householdId, mealFeedback.userId, mealFeedback.mealId],
        set: {
          vote: feedback.vote,
          signal: feedback.signal ?? null,
          updatedAt: now,
        },
      })
      .returning()
    if (!row) throw new Error('Upsert did not return the persisted meal feedback')
    return toMealFeedbackRecord(row)
  })
}

export async function removeMealFeedback(db: Db, accessToken: string, userId: string, householdId: string, mealId: string) {
  return withRls(db, accessToken, async (tx) => {
    await tx
      .delete(mealFeedback)
      .where(and(eq(mealFeedback.householdId, householdId), eq(mealFeedback.userId, userId), eq(mealFeedback.mealId, mealId)))
  })
}

const listMealFeedbackRoute = createRoute({
  method: 'get',
  path: '/households/{householdId}/meal-feedback',
  operationId: 'listMealFeedback',
  summary: "List the current user's meal feedback in a household",
  security: [{ bearerAuth: [] }],
  request: { params: HouseholdParamsSchema },
  responses: {
    200: { description: 'Meal feedback keyed by meal id, plus ordered records', content: { 'application/json': { schema: ListMealFeedbackResponseSchema } } },
    401: { description: 'Missing or invalid session' },
  },
})

const upsertMealFeedbackRoute = createRoute({
  method: 'put',
  path: '/households/{householdId}/meal-feedback',
  operationId: 'upsertMealFeedback',
  summary: 'Upsert or remove meal feedback for the current user',
  security: [{ bearerAuth: [] }],
  request: {
    params: HouseholdParamsSchema,
    body: { content: { 'application/json': { schema: UpsertMealFeedbackSchema } } },
  },
  responses: {
    200: { description: 'Feedback saved or removed', content: { 'application/json': { schema: OkResponseSchema } } },
    401: { description: 'Missing or invalid session' },
  },
})

export function buildMealFeedbackRoutes(db: Db) {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()

  app.use('/households/*', requireAuth)

  app.openapi(listMealFeedbackRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId } = c.req.valid('param')
    const response = await listMealFeedback(db, accessToken, user.id, householdId)
    return c.json(response, 200)
  })

  app.openapi(upsertMealFeedbackRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId } = c.req.valid('param')
    const { mealId, feedback } = c.req.valid('json')
    if (feedback === null) {
      await removeMealFeedback(db, accessToken, user.id, householdId, mealId)
    } else {
      await upsertMealFeedback(db, accessToken, user.id, householdId, mealId, feedback)
    }
    return c.json({ ok: true }, 200)
  })

  return app
}
