import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, eq, inArray } from 'drizzle-orm'
import { requireAuth, type AuthedUser } from './auth.js'
import { appendStreamEvent, getStreamProjection } from './event-stream.js'
import { withRls } from './rls.js'
import { households, recipes, weekPlanEvents, weekPlanProjections } from './schema.js'
import type { Db } from './db.js'

// --- Wire shapes -----------------------------------------------------------
//
// Flat envelope — `{ causedBy, eventType, ...fields }` — matching the design
// doc's `TWeekPlanEvent = {...} & TWeekPlanEventPayload` intersection (not a
// nested `payload` object). `eventType` doubles as the discriminant for both
// the Zod union (HTTP boundary validation) and the `event_type` column
// (queryable without reaching into JSONB).

const CausedBySchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('user'), userId: z.string().uuid() }),
  z.object({ source: z.literal('algorithm'), algorithmVersion: z.string(), triggeredByUserId: z.string().uuid() }),
  z.object({ source: z.literal('system'), reason: z.string() }),
]).openapi('CausedBy')

const dayOfWeek = z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'])

// Minimal lifecycle marker — this slice proves the append/fold/read mechanism,
// not WeekStarted's eventual real shape (the design doc lists ~15 event types;
// these two are enough to prove the pattern earns its keep).
const WeekStartedPayloadSchema = z.object({
  eventType: z.literal('week_started'),
})

// `recipeRef` is the UUID of a recipe in the `recipes` table. Validated here
// as a UUID; the FK relationship is intentionally not enforced at the database
// level (no FK constraint on a JSONB payload column) — the application is the
// enforcement point, via `getRecipe` returning null for unknown IDs.
const MealAssignedPayloadSchema = z.object({
  eventType: z.literal('meal_assigned'),
  dayOfWeek,
  recipeRef: z.string().uuid(),
})

const WeekPlanEventPayloadSchema = z.discriminatedUnion('eventType', [
  WeekStartedPayloadSchema,
  MealAssignedPayloadSchema,
])

const AppendWeekPlanEventRequestSchema = z.object({
  causedBy: CausedBySchema,
}).and(WeekPlanEventPayloadSchema).openapi('AppendWeekPlanEventRequest')

const WeekPlanEventSchema = z.object({
  id: z.string().uuid(),
  householdId: z.string().uuid(),
  weekStartDate: z.string(),
  sequenceNumber: z.number().int(),
  occurredAt: z.string(),
  causedBy: CausedBySchema,
  eventType: z.enum(['week_started', 'meal_assigned']),
  payload: z.record(z.string(), z.unknown()),
}).openapi('WeekPlanEvent')

const WeekPlanProjectionSchema = z.object({
  householdId: z.string().uuid(),
  weekStartDate: z.string(),
  state: z.record(z.string(), z.unknown()),
  updatedAt: z.string(),
}).openapi('WeekPlanProjection')

const ParamsSchema = z.object({
  householdId: z.string().uuid(),
  weekStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'),
})

const WeekPlanSummaryRecipeSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  description: z.string(),
  servings: z.number().int(),
  prepTimeMinutes: z.number().int().nullable(),
  cookTimeMinutes: z.number().int().nullable(),
  tags: z.array(z.string()),
}).openapi('WeekPlanSummaryRecipe')

const WeekPlanSummaryDaySchema = z.object({
  dayOfWeek,
  date: z.string(),
  state: z.enum(['empty', 'planned', 'skipped']),
  recipe: WeekPlanSummaryRecipeSchema.nullable(),
}).openapi('WeekPlanSummaryDay')

const WeekPlanSummarySchema = z.object({
  household: z.object({ id: z.string().uuid(), name: z.string() }),
  weekStartDate: z.string(),
  updatedAt: z.string().nullable(),
  days: z.array(WeekPlanSummaryDaySchema),
}).openapi('WeekPlanSummary')

// --- Projection fold --------------------------------------------------------
//
// The minimal shape needed to prove `meal_assigned` folds correctly. Explicitly
// provisional — the design doc itself flags the projection shape as an open
// implementation-time question; freezing it now, before the other ~13 event
// types are scoped, would be premature.
type TWeekPlanProjectionState = {
  weekStarted: boolean
  meals: Partial<Record<z.infer<typeof dayOfWeek>, { recipeRef: string }>>
}

const emptyProjectionState = (): TWeekPlanProjectionState => ({ weekStarted: false, meals: {} })

function foldEventIntoProjection(
  state: TWeekPlanProjectionState,
  payload: z.infer<typeof WeekPlanEventPayloadSchema>,
): TWeekPlanProjectionState {
  switch (payload.eventType) {
    case 'week_started':
      return { ...state, weekStarted: true }
    case 'meal_assigned':
      return { ...state, meals: { ...state.meals, [payload.dayOfWeek]: { recipeRef: payload.recipeRef } } }
  }
}

// --- Routes ------------------------------------------------------------------
//
// The transactional append-and-fold mechanism (read latest sequence number,
// insert the event, fold it into the projection, upsert — all in one `withRls`
// transaction) now lives in `event-stream.ts` as `appendStreamEvent`.
// Shopping-list's stream is the second instance that proved it's genuinely
// shared: the two were byte-identical in shape, differing only in their
// tables and fold function. See that module's comment for why the table
// arguments are duck-typed rather than fought into Drizzle's generics.

const appendWeekPlanEventRoute = createRoute({
  method: 'post',
  path: '/households/{householdId}/week-plans/{weekStartDate}/events',
  summary: 'Append an event to a household week plan',
  security: [{ bearerAuth: [] }],
  request: {
    params: ParamsSchema,
    body: { content: { 'application/json': { schema: AppendWeekPlanEventRequestSchema } } },
  },
  responses: {
    201: {
      description: 'The persisted event',
      content: { 'application/json': { schema: WeekPlanEventSchema } },
    },
    401: { description: 'Missing or invalid session' },
  },
})

const getWeekPlanRoute = createRoute({
  method: 'get',
  path: '/households/{householdId}/week-plans/{weekStartDate}',
  summary: "Read a household week plan's current state",
  security: [{ bearerAuth: [] }],
  request: { params: ParamsSchema },
  responses: {
    200: {
      description: 'The current materialized projection for this week',
      content: { 'application/json': { schema: WeekPlanProjectionSchema } },
    },
    404: { description: "The week hasn't started yet — no projection exists" },
    401: { description: 'Missing or invalid session' },
  },
})

const getWeekPlanSummaryRoute = createRoute({
  method: 'get',
  path: '/households/{householdId}/week-plans/{weekStartDate}/summary',
  summary: "Read a household week plan as an iOS-friendly hydrated summary",
  security: [{ bearerAuth: [] }],
  request: { params: ParamsSchema },
  responses: {
    200: {
      description: 'The current week plan summary. Missing projections return an empty week.',
      content: { 'application/json': { schema: WeekPlanSummarySchema } },
    },
    404: { description: 'Household not found or caller is not a member' },
    401: { description: 'Missing or invalid session' },
  },
})

const orderedDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const

function addDays(yyyyMmDd: string, offset: number) {
  const date = new Date(`${yyyyMmDd}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

function readProjectionState(state: unknown): TWeekPlanProjectionState {
  const candidate = state as Partial<TWeekPlanProjectionState> | null | undefined
  return {
    weekStarted: candidate?.weekStarted === true,
    meals: candidate?.meals && typeof candidate.meals === 'object' ? candidate.meals : {},
  }
}

export async function getWeekPlanSummary(db: Db, accessToken: string, householdId: string, weekStartDate: string) {
  return withRls(db, accessToken, async (tx) => {
    const [household] = await tx
      .select({ id: households.id, name: households.name })
      .from(households)
      .where(eq(households.id, householdId))
      .limit(1)

    if (!household) return null

    const [projection] = await tx
      .select({ state: weekPlanProjections.state, updatedAt: weekPlanProjections.updatedAt })
      .from(weekPlanProjections)
      .where(and(eq(weekPlanProjections.householdId, householdId), eq(weekPlanProjections.weekStartDate, weekStartDate)))
      .limit(1)

    const projectionState = readProjectionState(projection?.state)
    const recipeIds = orderedDays
      .map((day) => projectionState.meals[day]?.recipeRef)
      .filter((id): id is string => Boolean(id))

    const recipeRows = recipeIds.length
      ? await tx
        .select({
          id: recipes.id,
          title: recipes.title,
          description: recipes.description,
          servings: recipes.servings,
          prepTimeMinutes: recipes.prepTimeMinutes,
          cookTimeMinutes: recipes.cookTimeMinutes,
          tags: recipes.tags,
        })
        .from(recipes)
        .where(and(eq(recipes.householdId, householdId), inArray(recipes.id, recipeIds)))
      : []

    const recipesById = new Map(recipeRows.map((recipe) => [recipe.id, recipe]))

    return {
      household,
      weekStartDate,
      updatedAt: projection?.updatedAt.toISOString() ?? null,
      days: orderedDays.map((dayOfWeek, index) => {
        const meal = projectionState.meals[dayOfWeek]
        const recipe = meal ? recipesById.get(meal.recipeRef) : undefined

        return {
          dayOfWeek,
          date: addDays(weekStartDate, index),
          state: recipe ? 'planned' as const : 'empty' as const,
          recipe: recipe ? {
            id: recipe.id,
            title: recipe.title,
            description: recipe.description,
            servings: recipe.servings,
            prepTimeMinutes: recipe.prepTimeMinutes ?? null,
            cookTimeMinutes: recipe.cookTimeMinutes ?? null,
            tags: recipe.tags as string[],
          } : null,
        }
      }),
    }
  })
}

export function buildWeekPlanRoutes(db: Db) {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()

  // Hono middleware doesn't cross OpenAPIHono sub-app boundaries — the
  // households module registers its own `requireAuth` on `/households/*`,
  // and so must this one (it doesn't inherit the registration when mounted
  // into the parent app via `.route('/', ...)`).
  app.use('/households/*', requireAuth)

  app.openapi(appendWeekPlanEventRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const { householdId, weekStartDate } = c.req.valid('param')
    const body = c.req.valid('json')
    const { causedBy, ...payload } = body

    const event = await appendStreamEvent(
      db,
      accessToken,
      { events: weekPlanEvents, projections: weekPlanProjections },
      { fold: foldEventIntoProjection, emptyState: emptyProjectionState },
      { householdId, weekStartDate, causedBy, payload: payload as z.infer<typeof WeekPlanEventPayloadSchema> },
    )

    return c.json(
      {
        id: event.id,
        householdId: event.householdId,
        weekStartDate: event.weekStartDate,
        sequenceNumber: event.sequenceNumber,
        occurredAt: event.occurredAt.toISOString(),
        causedBy: event.causedBy as z.infer<typeof CausedBySchema>,
        eventType: event.eventType as 'week_started' | 'meal_assigned',
        payload: event.payload as Record<string, unknown>,
      },
      201,
    )
  })

  app.openapi(getWeekPlanRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const { householdId, weekStartDate } = c.req.valid('param')

    // Exactly one query, against the projection only — `getStreamProjection`
    // is what enforces the one rule the entire pattern hinges on (design doc
    // §2: "never replay the event log on the read path").
    const projection = await getStreamProjection(db, accessToken, weekPlanProjections, { householdId, weekStartDate })

    if (!projection) return c.json({ error: 'No week plan found for this week' }, 404)

    return c.json(
      {
        householdId: projection.householdId,
        weekStartDate: projection.weekStartDate,
        state: projection.state as Record<string, unknown>,
        updatedAt: projection.updatedAt.toISOString(),
      },
      200,
    )
  })

  app.openapi(getWeekPlanSummaryRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const { householdId, weekStartDate } = c.req.valid('param')
    const summary = await getWeekPlanSummary(db, accessToken, householdId, weekStartDate)

    if (!summary) return c.json({ error: 'Household not found.' } as never, 404)
    return c.json(summary, 200)
  })

  return app
}

// Exported for tests that need to seed projection rows directly (bypassing
// appendWeekPlanEvent) to prove the read path reflects the projection, never a
// replay of the log.
export { foldEventIntoProjection, emptyProjectionState }
export type { TWeekPlanProjectionState }
