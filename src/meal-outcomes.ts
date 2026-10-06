import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, asc, eq } from 'drizzle-orm'
import { requireAuth, type AuthedUser } from './auth.js'
import type { Db } from './db.js'
import { assertMembership } from './membership.js'
import { withRls } from './rls.js'
import { householdMealOutcomes, householdRecipeRecommendations } from './schema.js'

type AppEnv = { Variables: { user: AuthedUser; accessToken: string } }

const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
const MealOutcomeStatusSchema = z.enum(['cooked', 'changed_plan', 'skipped']).openapi('MealOutcomeStatus')
const mealPortionOutcomeValues = ['too_little', 'right_amount', 'too_much'] as const
const mealOutcomeReasonValues = [
  'easy_weeknight',
  'family_approved',
  'good_leftovers',
  'too_much_effort',
  'family_pushback',
  'poor_leftovers',
] as const
const MealPortionOutcomeSchema = z.enum(mealPortionOutcomeValues).openapi('MealPortionOutcome')
const MealOutcomeReasonSchema = z.enum(mealOutcomeReasonValues).openapi('MealOutcomeReason')

const MealOutcomeRecordSchema = z.object({
  householdId: z.string().uuid(),
  weekStartDate: IsoDateSchema,
  date: IsoDateSchema,
  plannedRecipeId: z.string().uuid(),
  status: MealOutcomeStatusSchema,
  portionOutcome: z.enum(mealPortionOutcomeValues).nullable(),
  intentionalLeftovers: z.boolean(),
  reason: z.enum(mealOutcomeReasonValues).nullable(),
  actualRecipeId: z.string().uuid().nullable(),
  actualMealLabel: z.string().nullable(),
  updatedBy: z.string().uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).openapi('MealOutcomeRecord')

const UpsertMealOutcomeSchema = z.object({
  weekStartDate: IsoDateSchema,
  plannedRecipeId: z.string().uuid(),
  status: MealOutcomeStatusSchema,
  portionOutcome: MealPortionOutcomeSchema.optional(),
  intentionalLeftovers: z.boolean().optional().default(false),
  reason: MealOutcomeReasonSchema.optional(),
  // These describe what was eaten instead. Both are optional because
  // `changed_plan` may be recorded before the replacement is known.
  actualRecipeId: z.string().uuid().optional(),
  actualMealLabel: z.string().trim().min(1).max(120).optional(),
}).superRefine((value, context) => {
  if (value.status !== 'changed_plan' && (value.actualRecipeId || value.actualMealLabel)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['actualRecipeId'],
      message: 'Actual meal details are only valid when status is changed_plan',
    })
  }
  if (value.status === 'skipped' && value.portionOutcome) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['portionOutcome'],
      message: 'A skipped meal cannot have a portion outcome',
    })
  }
  if (value.intentionalLeftovers && value.portionOutcome !== 'too_much') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['intentionalLeftovers'],
      message: 'Intentional leftovers only apply when the portion outcome is too_much',
    })
  }
}).openapi('UpsertMealOutcome')

const HouseholdParamsSchema = z.object({ householdId: z.string().uuid() })
const MealOutcomeParamsSchema = z.object({
  householdId: z.string().uuid(),
  date: IsoDateSchema,
})
const MealOutcomesQuerySchema = z.object({ weekStartDate: IsoDateSchema })
const ErrorResponseSchema = z.object({ error: z.string() })

function toMealOutcomeRecord(row: typeof householdMealOutcomes.$inferSelect) {
  return {
    householdId: row.householdId,
    weekStartDate: row.weekStartDate,
    date: row.date,
    plannedRecipeId: row.plannedRecipeId,
    status: row.status,
    portionOutcome: row.portionOutcome,
    intentionalLeftovers: row.intentionalLeftovers,
    reason: row.reason,
    actualRecipeId: row.actualRecipeId,
    actualMealLabel: row.actualMealLabel,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function isMonday(date: string) {
  return new Date(`${date}T00:00:00Z`).getUTCDay() === 1
}

function isDateInWeek(date: string, weekStartDate: string) {
  const day = new Date(`${date}T00:00:00Z`)
  const start = new Date(`${weekStartDate}T00:00:00Z`)
  const end = new Date(start)
  end.setUTCDate(end.getUTCDate() + 6)
  return day >= start && day <= end
}

export async function listMealOutcomes(db: Db, accessToken: string, householdId: string, weekStartDate: string) {
  return withRls(db, accessToken, async (tx) => {
    const rows = await tx
      .select()
      .from(householdMealOutcomes)
      .where(and(
        eq(householdMealOutcomes.householdId, householdId),
        eq(householdMealOutcomes.weekStartDate, weekStartDate),
      ))
      .orderBy(asc(householdMealOutcomes.date))
    return rows.map(toMealOutcomeRecord)
  })
}

export async function upsertMealOutcome(
  db: Db,
  accessToken: string,
  userId: string,
  householdId: string,
  date: string,
  input: z.input<typeof UpsertMealOutcomeSchema>,
) {
  return withRls(db, accessToken, async (tx) => {
    const now = new Date()
    const [row] = await tx
      .insert(householdMealOutcomes)
      .values({
        householdId,
        weekStartDate: input.weekStartDate,
        date,
        plannedRecipeId: input.plannedRecipeId,
        status: input.status,
        portionOutcome: input.portionOutcome ?? null,
        intentionalLeftovers: input.intentionalLeftovers ?? false,
        reason: input.reason ?? null,
        actualRecipeId: input.actualRecipeId ?? null,
        actualMealLabel: input.actualMealLabel ?? null,
        updatedBy: userId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          householdMealOutcomes.householdId,
          householdMealOutcomes.weekStartDate,
          householdMealOutcomes.date,
        ],
        set: {
          plannedRecipeId: input.plannedRecipeId,
          status: input.status,
          portionOutcome: input.portionOutcome ?? null,
          intentionalLeftovers: input.intentionalLeftovers ?? false,
          reason: input.reason ?? null,
          actualRecipeId: input.actualRecipeId ?? null,
          actualMealLabel: input.actualMealLabel ?? null,
          updatedBy: userId,
          updatedAt: now,
        },
      })
      .returning()
    if (!row) throw new Error('Upsert did not return the persisted meal outcome')
    // Recommendation responses include recent-meal context. A corrected
    // outcome changes that context immediately, so the week-long cache must
    // not preserve advice based on the old history.
    await tx
      .delete(householdRecipeRecommendations)
      .where(eq(householdRecipeRecommendations.householdId, householdId))
    return toMealOutcomeRecord(row)
  })
}

const listMealOutcomesRoute = createRoute({
  method: 'get',
  path: '/households/{householdId}/meal-outcomes',
  operationId: 'listMealOutcomes',
  summary: "List a household's actual dinner outcomes for one week",
  security: [{ bearerAuth: [] }],
  request: { params: HouseholdParamsSchema, query: MealOutcomesQuerySchema },
  responses: {
    200: {
      description: 'Shared dinner outcomes ordered by date',
      content: { 'application/json': { schema: z.object({ outcomes: z.array(MealOutcomeRecordSchema) }) } },
    },
    400: { description: 'Invalid week start date', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Missing or invalid session', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Household not found or caller is not a member', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
})

const upsertMealOutcomeRoute = createRoute({
  method: 'put',
  path: '/households/{householdId}/meal-outcomes/{date}',
  operationId: 'upsertMealOutcome',
  summary: 'Create or replace the shared actual dinner outcome for a date',
  description: 'Idempotently records what happened to a planned dinner. For changed_plan, actualRecipeId and actualMealLabel optionally describe what the household ate instead.',
  security: [{ bearerAuth: [] }],
  request: {
    params: MealOutcomeParamsSchema,
    body: { content: { 'application/json': { schema: UpsertMealOutcomeSchema } } },
  },
  responses: {
    200: { description: 'Dinner outcome saved', content: { 'application/json': { schema: MealOutcomeRecordSchema } } },
    400: { description: 'Invalid outcome or date outside the selected week', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Missing or invalid session', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Household not found or caller is not a member', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
})

export function buildMealOutcomesRoutes(db: Db) {
  const app = new OpenAPIHono<AppEnv>()

  app.use('/households/*', requireAuth)

  app.openapi(listMealOutcomesRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId } = c.req.valid('param')
    const { weekStartDate } = c.req.valid('query')
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' }, 404)
    if (!isMonday(weekStartDate)) return c.json({ error: 'INVALID_WEEK_START_DATE' }, 400)

    const outcomes = await listMealOutcomes(db, accessToken, householdId, weekStartDate)
    return c.json({ outcomes }, 200)
  })

  app.openapi(upsertMealOutcomeRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId, date } = c.req.valid('param')
    const input = c.req.valid('json')
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' }, 404)
    if (!isMonday(input.weekStartDate) || !isDateInWeek(date, input.weekStartDate)) {
      return c.json({ error: 'INVALID_MEAL_OUTCOME_DATE' }, 400)
    }

    const outcome = await upsertMealOutcome(db, accessToken, user.id, householdId, date, input)
    return c.json(outcome, 200)
  })

  return app
}
