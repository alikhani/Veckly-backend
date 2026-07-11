import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, desc, eq, gte, inArray, lte, or } from 'drizzle-orm'
import { requireAuth, type AuthedUser } from './auth.js'
import { appendStreamEvent, getStreamProjection } from './event-stream.js'
import { assertMembership } from './membership.js'
import { withRls } from './rls.js'
import { householdProfiles, householdWeekPlans, households, mealFeedback, recipes, weekPlanEvents, weekPlanProjections } from './schema.js'
import type { Db } from './db.js'
import {
  computeCurrentStreak,
  createWeekContext,
  deriveAssignmentReason,
  detectFatiguedMeals,
  evaluateAssignmentConfidence,
  extractRecentMealIds,
  rankCandidates,
  updateWeekContext,
  type TFeedbackState,
  type TScoringRecipe,
} from './week-scoring.js'

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
const WeekPlanEventTypeSchema = z.enum([
  'week_started',
  'planning_request_updated',
  'meal_assigned',
  'meal_unassigned',
  'meal_locked',
  'meal_unlocked',
  'meal_moved',
  'day_skipped',
  'day_unskipped',
  'servings_changed',
  'week_plan_cleared',
])

const PrioritySchema = z.enum(['quick', 'budget', 'child-friendly', 'meal-prep', 'varied'])
const PlanningDaySelectionSchema = z.object({
  day: dayOfWeek,
  servingsOverride: z.number().int().min(1).optional(),
  occasion: z.enum(['standard', 'guests', 'treat']).optional(),
  effortLevel: z.enum(['standard', 'busy']).optional(),
  leftoversIntent: z.boolean().optional(),
  lateEvening: z.boolean().optional(),
  cookingTolerance: z.enum(['standard', 'relaxed']).optional(),
})
const PlanningRequestSchema = z.object({
  household: z.object({
    adults: z.number().int().min(1),
    children: z.number().int().min(0),
    priorities: z.array(PrioritySchema),
    avoidIngredients: z.array(z.string()),
  }),
  selectedDays: z.array(PlanningDaySelectionSchema),
})

const WeekHistoryStatusSchema = z.enum(['draft', 'finalized', 'archived'])
const WeekHistorySourceSchema = z.enum(['generated', 'copied_from_previous', 'template_applied', 'manual'])
const WeekHistoryStateSchema = z.object({
  lockedDays: z.array(dayOfWeek).default([]),
  skippedDays: z.array(dayOfWeek).default([]),
  replacements: z.record(z.string(), z.unknown()).default({}),
  request: PlanningRequestSchema,
}).openapi('WeekHistoryState')

// Minimal lifecycle marker — this slice proves the append/fold/read mechanism,
// not WeekStarted's eventual real shape (the design doc lists ~15 event types;
// these two are enough to prove the pattern earns its keep).
const WeekStartedPayloadSchema = z.object({
  eventType: z.literal('week_started'),
})

const PlanningRequestUpdatedPayloadSchema = z.object({
  eventType: z.literal('planning_request_updated'),
  request: PlanningRequestSchema,
})

// Populated only for algorithm-assigned meals (see `doGenerateWeekPlan`) —
// a manual pick via the meal picker has no algorithmic "why", so both are
// simply omitted for `source: 'user'` events.
const AssignmentReasonSchema = z.enum(['family-recipe', 'liked-before', 'back-after-break', 'based-on-feedback', 'new-for-variety'])
const AssignmentConfidenceSchema = z.enum(['ok', 'low'])

// `recipeRef` is the UUID of a recipe in the `recipes` table. Validated here
// as a UUID; the FK relationship is intentionally not enforced at the database
// level (no FK constraint on a JSONB payload column) — the application is the
// enforcement point, via `getRecipe` returning null for unknown IDs.
const MealAssignedPayloadSchema = z.object({
  eventType: z.literal('meal_assigned'),
  dayOfWeek,
  recipeRef: z.string().uuid(),
  reason: AssignmentReasonSchema.optional(),
  confidence: AssignmentConfidenceSchema.optional(),
})

const MealUnassignedPayloadSchema = z.object({
  eventType: z.literal('meal_unassigned'),
  dayOfWeek,
})

const MealLockedPayloadSchema = z.object({
  eventType: z.literal('meal_locked'),
  dayOfWeek,
})

const MealUnlockedPayloadSchema = z.object({
  eventType: z.literal('meal_unlocked'),
  dayOfWeek,
})

const MealMovedPayloadSchema = z.object({
  eventType: z.literal('meal_moved'),
  fromDayOfWeek: dayOfWeek,
  toDayOfWeek: dayOfWeek,
})

const DaySkippedPayloadSchema = z.object({
  eventType: z.literal('day_skipped'),
  dayOfWeek,
})

const DayUnskippedPayloadSchema = z.object({
  eventType: z.literal('day_unskipped'),
  dayOfWeek,
})

const ServingsChangedPayloadSchema = z.object({
  eventType: z.literal('servings_changed'),
  dayOfWeek,
  servings: z.number().int().min(1),
})

const WeekPlanClearedPayloadSchema = z.object({
  eventType: z.literal('week_plan_cleared'),
})

const WeekPlanEventPayloadSchema = z.discriminatedUnion('eventType', [
  WeekStartedPayloadSchema,
  PlanningRequestUpdatedPayloadSchema,
  MealAssignedPayloadSchema,
  MealUnassignedPayloadSchema,
  MealLockedPayloadSchema,
  MealUnlockedPayloadSchema,
  MealMovedPayloadSchema,
  DaySkippedPayloadSchema,
  DayUnskippedPayloadSchema,
  ServingsChangedPayloadSchema,
  WeekPlanClearedPayloadSchema,
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
  eventType: WeekPlanEventTypeSchema,
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
const HouseholdParamsSchema = z.object({ householdId: z.string().uuid() })
const WeekHistoryQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
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
  isLocked: z.boolean(),
  recipe: WeekPlanSummaryRecipeSchema.nullable(),
  reason: AssignmentReasonSchema.nullable(),
  confidence: AssignmentConfidenceSchema.nullable(),
  // Consecutive weeks (including this one) this recipe has been cooked, or
  // null below the satiation-hint threshold (3). Presentation-only — has no
  // bearing on generation/scoring (see `computeCurrentStreak`).
  streakWeeks: z.number().int().nullable(),
}).openapi('WeekPlanSummaryDay')

const WeekPlanSummarySchema = z.object({
  household: z.object({ id: z.string().uuid(), name: z.string() }),
  weekStartDate: z.string(),
  updatedAt: z.string().nullable(),
  days: z.array(WeekPlanSummaryDaySchema),
}).openapi('WeekPlanSummary')

const WeekHistoryPlanSchema = z.object({
  householdId: z.string().uuid(),
  weekStartDate: z.string(),
  weekNumber: z.number().int(),
  weekYear: z.number().int(),
  timezone: z.string(),
  state: WeekHistoryStateSchema,
  status: WeekHistoryStatusSchema,
  source: WeekHistorySourceSchema,
  updatedBy: z.string().uuid(),
  updatedAt: z.string(),
}).openapi('WeekHistoryPlan')

const WeekHistoryListItemSchema = z.object({
  weekStartDate: z.string(),
  weekNumber: z.number().int(),
  weekYear: z.number().int(),
  timezone: z.string(),
  status: WeekHistoryStatusSchema,
  source: WeekHistorySourceSchema,
  updatedAt: z.string(),
  updatedBy: z.string().uuid(),
  plannedDays: z.array(dayOfWeek),
  request: PlanningRequestSchema,
  replacements: z.record(z.string(), z.unknown()),
  skippedDays: z.array(dayOfWeek),
}).openapi('WeekHistoryListItem')

const WeekHistoryDetailSchema = z.object({
  week: WeekHistoryPlanSchema.nullable(),
}).openapi('WeekHistoryDetail')

const UpsertWeekHistoryPlanSchema = z.object({
  expectedUpdatedAt: z.string().nullable().optional(),
  timezone: z.string().min(1),
  state: WeekHistoryStateSchema,
  status: WeekHistoryStatusSchema.default('draft'),
  source: WeekHistorySourceSchema.default('manual'),
}).openapi('UpsertWeekHistoryPlan')

const UpsertWeekHistoryPlanResponseSchema = z.object({
  ok: z.literal(true),
  weekStartDate: z.string(),
  weekNumber: z.number().int(),
  weekYear: z.number().int(),
  updatedAt: z.string(),
}).openapi('UpsertWeekHistoryPlanResponse')

const FinalizeWeekHistoryPlanResponseSchema = z.object({
  ok: z.literal(true),
  weekStartDate: z.string(),
  status: z.literal('finalized'),
  updatedAt: z.string().nullable(),
}).openapi('FinalizeWeekHistoryPlanResponse')

const StaleWeekHistoryPlanResponseSchema = z.object({
  error: z.literal('STALE_WEEK_PLAN_STATE'),
  updatedAt: z.string().nullable(),
}).openapi('StaleWeekHistoryPlanResponse')

// --- Projection fold --------------------------------------------------------
//
// The minimal shape needed to prove `meal_assigned` folds correctly. Explicitly
// provisional — the design doc itself flags the projection shape as an open
// implementation-time question; freezing it now, before the other ~13 event
// types are scoped, would be premature.
type TWeekPlanProjectionState = {
  weekStarted: boolean
  request: z.infer<typeof PlanningRequestSchema> | null
  meals: Partial<Record<z.infer<typeof dayOfWeek>, {
    recipeRef: string
    servings?: number
    reason?: z.infer<typeof AssignmentReasonSchema>
    confidence?: z.infer<typeof AssignmentConfidenceSchema>
  }>>
  lockedDays: z.infer<typeof dayOfWeek>[]
  skippedDays: z.infer<typeof dayOfWeek>[]
}

const emptyProjectionState = (): TWeekPlanProjectionState => ({
  weekStarted: false,
  request: null,
  meals: {},
  lockedDays: [],
  skippedDays: [],
})

function toggleSortedDay(days: z.infer<typeof dayOfWeek>[], day: z.infer<typeof dayOfWeek>, enabled: boolean) {
  const next = enabled ? [...new Set([...days, day])] : days.filter((entry) => entry !== day)
  return orderedDays.filter((entry) => next.includes(entry))
}

function foldEventIntoProjection(
  state: TWeekPlanProjectionState,
  payload: z.infer<typeof WeekPlanEventPayloadSchema>,
): TWeekPlanProjectionState {
  switch (payload.eventType) {
    case 'week_started':
      return { ...state, weekStarted: true }
    case 'planning_request_updated':
      return { ...state, request: payload.request }
    case 'meal_assigned':
      // `reason`/`confidence` are set from this event's payload, not merged
      // with the previous assignment's — a manual re-pick (no algorithmic
      // reason) must clear a stale reason left over from a prior generated
      // pick, not inherit it.
      return {
        ...state,
        meals: {
          ...state.meals,
          [payload.dayOfWeek]: {
            servings: state.meals[payload.dayOfWeek]?.servings,
            recipeRef: payload.recipeRef,
            reason: payload.reason,
            confidence: payload.confidence,
          },
        },
        skippedDays: toggleSortedDay(state.skippedDays, payload.dayOfWeek, false),
      }
    case 'meal_unassigned': {
      const meals = { ...state.meals }
      delete meals[payload.dayOfWeek]
      return { ...state, meals, lockedDays: toggleSortedDay(state.lockedDays, payload.dayOfWeek, false) }
    }
    case 'meal_locked':
      return { ...state, lockedDays: toggleSortedDay(state.lockedDays, payload.dayOfWeek, true) }
    case 'meal_unlocked':
      return { ...state, lockedDays: toggleSortedDay(state.lockedDays, payload.dayOfWeek, false) }
    case 'meal_moved': {
      const meal = state.meals[payload.fromDayOfWeek]
      if (!meal) return state
      const meals = { ...state.meals, [payload.toDayOfWeek]: meal }
      delete meals[payload.fromDayOfWeek]
      return {
        ...state,
        meals,
        lockedDays: toggleSortedDay(toggleSortedDay(state.lockedDays, payload.fromDayOfWeek, false), payload.toDayOfWeek, state.lockedDays.includes(payload.fromDayOfWeek)),
        skippedDays: toggleSortedDay(toggleSortedDay(state.skippedDays, payload.toDayOfWeek, false), payload.fromDayOfWeek, false),
      }
    }
    case 'day_skipped':
      // Skip is a state layered on top of an existing assignment, not a
      // deletion — a skipped day keeps its `meals` entry (recipe, reason,
      // confidence) so `getWeekPlanSummary` can still return the recipe
      // alongside `state: 'skipped'`, and un-skipping restores it exactly.
      // (Matches the iOS client's local optimistic model — see
      // `WeekDayRowViewModel.withSkipped` — which already assumed this.)
      return {
        ...state,
        lockedDays: toggleSortedDay(state.lockedDays, payload.dayOfWeek, false),
        skippedDays: toggleSortedDay(state.skippedDays, payload.dayOfWeek, true),
      }
    case 'day_unskipped':
      return { ...state, skippedDays: toggleSortedDay(state.skippedDays, payload.dayOfWeek, false) }
    case 'servings_changed': {
      const existing = state.meals[payload.dayOfWeek]
      if (!existing) return state
      return { ...state, meals: { ...state.meals, [payload.dayOfWeek]: { ...existing, servings: payload.servings } } }
    }
    case 'week_plan_cleared':
      return emptyProjectionState()
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
  operationId: 'appendWeekPlanEvent',
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
  operationId: 'getWeekPlan',
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
  operationId: 'getWeekPlanSummary',
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

const listWeekHistoryPlansRoute = createRoute({
  method: 'get',
  path: '/households/{householdId}/week-plans',
  operationId: 'listWeekHistoryPlans',
  summary: "List a household's persisted week plans",
  security: [{ bearerAuth: [] }],
  request: { params: HouseholdParamsSchema, query: WeekHistoryQuerySchema },
  responses: {
    200: {
      description: 'Week plans ordered by week start date descending',
      content: { 'application/json': { schema: z.array(WeekHistoryListItemSchema) } },
    },
    400: { description: 'Invalid range' },
    401: { description: 'Missing or invalid session' },
  },
})

const getWeekHistoryPlanRoute = createRoute({
  method: 'get',
  path: '/households/{householdId}/week-plans/{weekStartDate}/history',
  operationId: 'getWeekHistoryPlan',
  summary: 'Get persisted week-plan history metadata and state',
  security: [{ bearerAuth: [] }],
  request: { params: ParamsSchema },
  responses: {
    200: {
      description: 'The persisted week plan, or null when absent',
      content: { 'application/json': { schema: WeekHistoryDetailSchema } },
    },
    400: { description: 'Invalid week start date' },
    401: { description: 'Missing or invalid session' },
  },
})

const upsertWeekHistoryPlanRoute = createRoute({
  method: 'patch',
  path: '/households/{householdId}/week-plans/{weekStartDate}/history',
  operationId: 'upsertWeekHistoryPlan',
  summary: 'Persist or update week-plan history state',
  security: [{ bearerAuth: [] }],
  request: {
    params: ParamsSchema,
    body: { content: { 'application/json': { schema: UpsertWeekHistoryPlanSchema } } },
  },
  responses: {
    200: {
      description: 'Week history plan persisted',
      content: { 'application/json': { schema: UpsertWeekHistoryPlanResponseSchema } },
    },
    400: { description: 'Invalid request' },
    409: {
      description: 'The supplied expectedUpdatedAt value is stale',
      content: { 'application/json': { schema: StaleWeekHistoryPlanResponseSchema } },
    },
    401: { description: 'Missing or invalid session' },
  },
})

const GenerateWeekPlanRequestSchema = z.object({
  regenerate: z.boolean().default(false),
}).openapi('GenerateWeekPlanRequest')

const GenerateWeekPlanResponseSchema = z.object({
  ok: z.literal(true),
}).openapi('GenerateWeekPlanResponse')

const GenerateWeekPlanErrorSchema = z.object({
  error: z.enum(['NO_RECIPES', 'ALL_RECIPES_EXCLUDED']),
}).openapi('GenerateWeekPlanError')

const generateWeekPlanRoute = createRoute({
  method: 'post',
  path: '/households/{householdId}/week-plans/{weekStartDate}/generate',
  operationId: 'generateWeekPlan',
  summary: 'Generate meals for a week from household profile and available recipes',
  security: [{ bearerAuth: [] }],
  request: {
    params: ParamsSchema,
    body: { content: { 'application/json': { schema: GenerateWeekPlanRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Week plan generated (or nothing to do — all days already filled)',
      content: { 'application/json': { schema: GenerateWeekPlanResponseSchema } },
    },
    422: {
      description: 'No recipes available to plan with',
      content: { 'application/json': { schema: GenerateWeekPlanErrorSchema } },
    },
    401: { description: 'Missing or invalid session' },
  },
})

const finalizeWeekHistoryPlanRoute = createRoute({
  method: 'post',
  path: '/households/{householdId}/week-plans/{weekStartDate}/finalize',
  operationId: 'finalizeWeekHistoryPlan',
  summary: 'Finalize a persisted week plan',
  security: [{ bearerAuth: [] }],
  request: { params: ParamsSchema },
  responses: {
    200: {
      description: 'Week plan finalized',
      content: { 'application/json': { schema: FinalizeWeekHistoryPlanResponseSchema } },
    },
    400: { description: 'Invalid week start date' },
    404: { description: 'Week plan not found' },
    401: { description: 'Missing or invalid session' },
  },
})

const orderedDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const

function addDays(yyyyMmDd: string, offset: number) {
  const date = new Date(`${yyyyMmDd}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

function isMonday(yyyyMmDd: string) {
  return new Date(`${yyyyMmDd}T00:00:00.000Z`).getUTCDay() === 1
}

function getIsoWeekIdentity(yyyyMmDd: string) {
  const date = new Date(`${yyyyMmDd}T00:00:00.000Z`)
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const weekYear = date.getUTCFullYear()
  const yearStart = new Date(Date.UTC(weekYear, 0, 1))
  const weekNumber = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
  return { weekNumber, weekYear }
}

const SATIATION_STREAK_THRESHOLD = 3

function streakWeeksOrNull(streak: number): number | null {
  return streak >= SATIATION_STREAK_THRESHOLD ? streak : null
}

function readProjectionState(state: unknown): TWeekPlanProjectionState {
  const candidate = state as Partial<TWeekPlanProjectionState> | null | undefined
  return {
    weekStarted: candidate?.weekStarted === true,
    request: candidate?.request ?? null,
    meals: candidate?.meals && typeof candidate.meals === 'object' ? candidate.meals : {},
    lockedDays: Array.isArray(candidate?.lockedDays) ? candidate.lockedDays : [],
    skippedDays: Array.isArray(candidate?.skippedDays) ? candidate.skippedDays : [],
  }
}

function toWeekHistoryPlanResponse(row: typeof householdWeekPlans.$inferSelect): z.infer<typeof WeekHistoryPlanSchema> {
  return {
    householdId: row.householdId,
    weekStartDate: row.weekStartDate,
    weekNumber: row.weekNumber,
    weekYear: row.weekYear,
    timezone: row.timezone,
    state: row.state as z.infer<typeof WeekHistoryStateSchema>,
    status: row.status,
    source: row.source,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  }
}

function toWeekHistoryListItem(row: typeof householdWeekPlans.$inferSelect): z.infer<typeof WeekHistoryListItemSchema> {
  const plan = toWeekHistoryPlanResponse(row)
  return {
    weekStartDate: plan.weekStartDate,
    weekNumber: plan.weekNumber,
    weekYear: plan.weekYear,
    timezone: plan.timezone,
    status: plan.status,
    source: plan.source,
    updatedAt: plan.updatedAt,
    updatedBy: plan.updatedBy,
    plannedDays: plan.state.request.selectedDays.map((day) => day.day),
    request: plan.state.request,
    replacements: plan.state.replacements,
    skippedDays: plan.state.skippedDays,
  }
}

export async function listWeekHistoryPlans(
  db: Db,
  accessToken: string,
  householdId: string,
  range: { from?: string; to?: string },
) {
  return withRls(db, accessToken, async (tx) => {
    const conditions = [eq(householdWeekPlans.householdId, householdId)]
    if (range.from) conditions.push(gte(householdWeekPlans.weekStartDate, range.from))
    if (range.to) conditions.push(lte(householdWeekPlans.weekStartDate, range.to))

    const rows = await tx
      .select()
      .from(householdWeekPlans)
      .where(and(...conditions))
      .orderBy(desc(householdWeekPlans.weekStartDate))

    return rows.map(toWeekHistoryListItem)
  })
}

export async function getWeekHistoryPlan(db: Db, accessToken: string, householdId: string, weekStartDate: string) {
  return withRls(db, accessToken, async (tx) => {
    const [row] = await tx
      .select()
      .from(householdWeekPlans)
      .where(and(eq(householdWeekPlans.householdId, householdId), eq(householdWeekPlans.weekStartDate, weekStartDate)))
      .limit(1)

    return row ? toWeekHistoryPlanResponse(row) : null
  })
}

type TUpsertWeekHistoryPlanResult =
  | { outcome: 'saved'; plan: z.infer<typeof WeekHistoryPlanSchema> }
  | { outcome: 'stale'; updatedAt: string | null }

export async function upsertWeekHistoryPlan(
  db: Db,
  accessToken: string,
  userId: string,
  householdId: string,
  weekStartDate: string,
  input: z.infer<typeof UpsertWeekHistoryPlanSchema>,
): Promise<TUpsertWeekHistoryPlanResult> {
  return withRls(db, accessToken, async (tx) => {
    const [existing] = await tx
      .select({ updatedAt: householdWeekPlans.updatedAt })
      .from(householdWeekPlans)
      .where(and(eq(householdWeekPlans.householdId, householdId), eq(householdWeekPlans.weekStartDate, weekStartDate)))
      .limit(1)

    const currentUpdatedAt = existing?.updatedAt.toISOString() ?? null
    if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== currentUpdatedAt) {
      return { outcome: 'stale', updatedAt: currentUpdatedAt }
    }

    const iso = getIsoWeekIdentity(weekStartDate)
    const now = new Date()
    const [row] = await tx
      .insert(householdWeekPlans)
      .values({
        householdId,
        weekStartDate,
        weekNumber: iso.weekNumber,
        weekYear: iso.weekYear,
        timezone: input.timezone,
        state: input.state,
        status: input.status,
        source: input.source,
        updatedBy: userId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [householdWeekPlans.householdId, householdWeekPlans.weekStartDate],
        set: {
          weekNumber: iso.weekNumber,
          weekYear: iso.weekYear,
          timezone: input.timezone,
          state: input.state,
          status: input.status,
          source: input.source,
          updatedBy: userId,
          updatedAt: now,
        },
      })
      .returning()

    if (!row) throw new Error('Upsert did not return the persisted week history plan')
    return { outcome: 'saved', plan: toWeekHistoryPlanResponse(row) }
  })
}

export async function finalizeWeekHistoryPlan(db: Db, accessToken: string, userId: string, householdId: string, weekStartDate: string) {
  return withRls(db, accessToken, async (tx) => {
    const [existing] = await tx
      .select({ householdId: householdWeekPlans.householdId })
      .from(householdWeekPlans)
      .where(and(eq(householdWeekPlans.householdId, householdId), eq(householdWeekPlans.weekStartDate, weekStartDate)))
      .limit(1)

    if (!existing) return null

    const [row] = await tx
      .update(householdWeekPlans)
      .set({ status: 'finalized', updatedBy: userId, updatedAt: new Date() })
      .where(and(eq(householdWeekPlans.householdId, householdId), eq(householdWeekPlans.weekStartDate, weekStartDate)))
      .returning()

    return row ? toWeekHistoryPlanResponse(row) : null
  })
}

export async function getWeekPlanSummary(db: Db, accessToken: string, householdId: string, weekStartDate: string) {
  return withRls(db, accessToken, async (tx) => {
    const [household] = await tx
      .select({ id: households.id, name: households.name })
      .from(households)
      .where(eq(households.id, householdId))
      .limit(1)

    if (!household) return null

    // 4 prior weeks is enough to surface a streak (threshold 3) without an
    // unbounded query — see `computeCurrentStreak` in week-scoring.ts.
    const priorWeekStartDates = Array.from({ length: 4 }, (_, i) => addDays(weekStartDate, -7 * (i + 1)))

    const [[projection], priorWeekProjections] = await Promise.all([
      tx
        .select({ state: weekPlanProjections.state, updatedAt: weekPlanProjections.updatedAt })
        .from(weekPlanProjections)
        .where(and(eq(weekPlanProjections.householdId, householdId), eq(weekPlanProjections.weekStartDate, weekStartDate)))
        .limit(1),
      tx
        .select({ weekStartDate: weekPlanProjections.weekStartDate, state: weekPlanProjections.state })
        .from(weekPlanProjections)
        .where(and(eq(weekPlanProjections.householdId, householdId), inArray(weekPlanProjections.weekStartDate, priorWeekStartDates)))
    ])

    const projectionState = readProjectionState(projection?.state)
    const recipeIds = orderedDays
      .map((day) => projectionState.meals[day]?.recipeRef)
      .filter((id): id is string => Boolean(id))

    const priorWeeksByDate = new Map(
      priorWeekProjections.map((row) => [row.weekStartDate, Object.values(readProjectionState(row.state).meals).map((m) => m.recipeRef)]),
    )
    const weeksMostRecentFirst = [
      recipeIds,
      ...priorWeekStartDates.map((date) => priorWeeksByDate.get(date) ?? []),
    ]

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
        .where(and(or(eq(recipes.householdId, householdId), eq(recipes.isPublic, true)), inArray(recipes.id, recipeIds)))
      : []

    const recipesById = new Map(recipeRows.map((recipe) => [recipe.id, recipe]))

    return {
      household,
      weekStartDate,
      updatedAt: projection?.updatedAt.toISOString() ?? null,
      days: orderedDays.map((dayOfWeek, index) => {
        const meal = projectionState.meals[dayOfWeek]
        const recipe = meal ? recipesById.get(meal.recipeRef) : undefined
        const state = projectionState.skippedDays.includes(dayOfWeek) ? 'skipped' as const : recipe ? 'planned' as const : 'empty' as const

        return {
          dayOfWeek,
          date: addDays(weekStartDate, index),
          state,
          isLocked: projectionState.lockedDays.includes(dayOfWeek),
          reason: meal?.reason ?? null,
          confidence: meal?.confidence ?? null,
          streakWeeks: recipe ? streakWeeksOrNull(computeCurrentStreak(recipe.id, weeksMostRecentFirst)) : null,
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

export async function doGenerateWeekPlan(
  db: Db,
  accessToken: string,
  userId: string,
  householdId: string,
  weekStartDate: string,
  regenerate: boolean,
): Promise<{ ok: true } | { error: 'NO_RECIPES' } | { error: 'ALL_RECIPES_EXCLUDED' } | { error: 'NOT_MEMBER' }> {
  const member = await assertMembership(db, accessToken, householdId, userId)
  if (!member) return { error: 'NOT_MEMBER' as const }

  // Up to 6 prior Monday-start weeks — feeds both recency (last 1-2 weeks)
  // and fatigue detection (needs ≥4 weeks of history; see week-scoring.ts).
  const priorWeekStartDates = Array.from({ length: 6 }, (_, i) => addDays(weekStartDate, -7 * (i + 1)))

  const [profileRows, projection, poolRecipes, feedbackRows, priorWeekProjections] = await Promise.all([
    withRls(db, accessToken, (tx) =>
      tx.select({ avoidIngredients: householdProfiles.avoidIngredients, selectedDays: householdProfiles.selectedDays })
        .from(householdProfiles).where(eq(householdProfiles.householdId, householdId)).limit(1)
    ),
    getStreamProjection(db, accessToken, weekPlanProjections, { householdId, weekStartDate }),
    withRls(db, accessToken, (tx) =>
      tx.select({
        id: recipes.id,
        title: recipes.title,
        tags: recipes.tags,
        ingredients: recipes.ingredients,
        cuisine: recipes.cuisine,
        proteinSource: recipes.proteinSource,
        mealWeight: recipes.mealWeight,
        householdId: recipes.householdId,
      })
        .from(recipes)
        .where(and(eq(recipes.isArchived, false), or(eq(recipes.householdId, householdId), eq(recipes.isPublic, true))))
    ),
    withRls(db, accessToken, (tx) =>
      tx.select({ mealId: mealFeedback.mealId, vote: mealFeedback.vote, signal: mealFeedback.signal })
        .from(mealFeedback)
        .where(and(eq(mealFeedback.householdId, householdId), eq(mealFeedback.userId, userId)))
    ),
    withRls(db, accessToken, (tx) =>
      tx.select({ weekStartDate: weekPlanProjections.weekStartDate, state: weekPlanProjections.state })
        .from(weekPlanProjections)
        .where(and(eq(weekPlanProjections.householdId, householdId), inArray(weekPlanProjections.weekStartDate, priorWeekStartDates)))
    ),
  ])

  const profile = profileRows[0] ?? null
  const selectedDayNames: z.infer<typeof dayOfWeek>[] = profile
    ? (profile.selectedDays as Array<{ day: string }>).map((d) => d.day as z.infer<typeof dayOfWeek>)
    : ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']
  const avoidIngredients: string[] = profile ? (profile.avoidIngredients as string[]) : []

  const projState = readProjectionState(projection?.state)
  const daysToFill = orderedDays.filter((day) => {
    if (!selectedDayNames.includes(day)) return false
    if (projState.lockedDays.includes(day)) return false
    if (projState.skippedDays.includes(day)) return false
    return regenerate ? true : !projState.meals[day]
  })

  if (daysToFill.length === 0) return { ok: true }
  if (poolRecipes.length === 0) return { error: 'NO_RECIPES' as const }

  const candidates: TScoringRecipe[] = (avoidIngredients.length > 0
    ? poolRecipes.filter((r) =>
      !avoidIngredients.some((a) => {
        const lower = a.toLowerCase()
        if (r.title.toLowerCase().includes(lower)) return true
        if ((r.tags as string[]).some((t) => t.toLowerCase().includes(lower))) return true
        const ings = r.ingredients as Array<{ item: string }> | null
        if (ings?.some((i) => i.item.toLowerCase().includes(lower))) return true
        return false
      })
    )
    : poolRecipes
  ).map((r) => ({
    id: r.id,
    title: r.title,
    tags: r.tags as string[],
    ingredients: r.ingredients as Array<{ item: string }> | null,
    cuisine: r.cuisine,
    proteinSource: r.proteinSource,
    mealWeight: r.mealWeight,
    householdId: r.householdId,
  }))

  // Fail closed: if every recipe was excluded by the household's avoid-list,
  // never silently fall back to the unfiltered pool — that would risk
  // serving an ingredient the household explicitly flagged (e.g. an allergen).
  if (candidates.length === 0) return { error: 'ALL_RECIPES_EXCLUDED' as const }

  const feedback: TFeedbackState = Object.fromEntries(
    feedbackRows.map((row) => [row.mealId, { vote: row.vote, ...(row.signal ? { signal: row.signal } : {}) }]),
  )
  const weekHistoryRecords = priorWeekProjections.map((row) => ({
    weekStartDate: row.weekStartDate,
    mealIds: Object.values(readProjectionState(row.state).meals).map((m) => m.recipeRef),
  }))
  const recentMealIds = extractRecentMealIds(weekHistoryRecords, weekStartDate)
  const fatiguedMealIds = detectFatiguedMeals(weekHistoryRecords)
  const everCookedRecipeIds = new Set(weekHistoryRecords.flatMap((record) => record.mealIds))

  const alreadyUsed = new Set(Object.values(projState.meals).map((m) => m.recipeRef))
  const weekCtx = createWeekContext()
  // Seed week-context with this week's already-placed (locked/existing)
  // meals so cuisine/protein-variety and hearty-adjacency scoring account
  // for the whole week, not just the days being filled right now.
  for (const meal of Object.values(projState.meals)) {
    const placed = candidates.find((c) => c.id === meal.recipeRef)
    if (placed) updateWeekContext(weekCtx, placed)
  }

  const causedBy = { source: 'algorithm' as const, algorithmVersion: '2.0', triggeredByUserId: userId }

  if (!projState.weekStarted) {
    await appendStreamEvent(
      db, accessToken,
      { events: weekPlanEvents, projections: weekPlanProjections },
      { fold: foldEventIntoProjection, emptyState: emptyProjectionState },
      { householdId, weekStartDate, causedBy, payload: { eventType: 'week_started' } },
    )
  }

  for (const day of daysToFill) {
    const unused = candidates.filter((c) => !alreadyUsed.has(c.id))
    const scoringPool = unused.length > 0 ? unused : candidates
    const ranked = rankCandidates(scoringPool, { householdId, feedback, allRecipes: candidates, weekCtx, recentMealIds, fatiguedMealIds })
    const next = ranked[0]
    if (!next) continue

    // Evaluated against `weekCtx` as it stood *before* this pick — same
    // order as the web engine (evaluateConfidence, then updateWeekContext).
    const reason = deriveAssignmentReason(next, { householdId, feedback, allRecipes: candidates, fatiguedMealIds, everCookedRecipeIds })
    const confidence = evaluateAssignmentConfidence(next, weekCtx)

    alreadyUsed.add(next.id)
    updateWeekContext(weekCtx, next)
    await appendStreamEvent(
      db, accessToken,
      { events: weekPlanEvents, projections: weekPlanProjections },
      { fold: foldEventIntoProjection, emptyState: emptyProjectionState },
      { householdId, weekStartDate, causedBy, payload: { eventType: 'meal_assigned', dayOfWeek: day, recipeRef: next.id, reason, confidence } },
    )
  }

  return { ok: true }
}

export function buildWeekPlanRoutes(db: Db) {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()

  // Hono middleware doesn't cross OpenAPIHono sub-app boundaries — the
  // households module registers its own `requireAuth` on `/households/*`,
  // and so must this one (it doesn't inherit the registration when mounted
  // into the parent app via `.route('/', ...)`).
  app.use('/households/*', requireAuth)

  app.openapi(generateWeekPlanRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId, weekStartDate } = c.req.valid('param')
    const { regenerate } = c.req.valid('json')
    if (!isMonday(weekStartDate)) return c.json({ error: 'INVALID_WEEK_START_DATE' } as never, 400)
    const result = await doGenerateWeekPlan(db, accessToken, user.id, householdId, weekStartDate, regenerate)
    if ('error' in result && result.error === 'NOT_MEMBER') return c.json({ error: 'NOT_MEMBER' }, 404)
    if ('error' in result) return c.json(result, 422)
    return c.json(result, 200)
  })

  app.openapi(appendWeekPlanEventRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId, weekStartDate } = c.req.valid('param')
    if (!isMonday(weekStartDate)) return c.json({ error: 'INVALID_WEEK_START_DATE' } as never, 400)
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' }, 404)
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
        eventType: event.eventType as z.infer<typeof WeekPlanEventTypeSchema>,
        payload: event.payload as Record<string, unknown>,
      },
      201,
    )
  })

  app.openapi(getWeekPlanRoute, async (c) => {
    const user = c.get('user')
    const accessToken = c.get('accessToken')
    const { householdId, weekStartDate } = c.req.valid('param')
    if (!isMonday(weekStartDate)) return c.json({ error: 'INVALID_WEEK_START_DATE' } as never, 400)
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' }, 404)

    // Exactly one query, against the projection only — `getStreamProjection`
    // is what enforces the one rule the entire pattern hinges on (design doc
    // §2: "never replay the event log on the read path").
    const projection = await getStreamProjection(db, accessToken, weekPlanProjections, { householdId, weekStartDate })

    if (!projection) return c.json({ error: 'No week plan found for this week' }, 404)

    c.header('Cache-Control', 'private, max-age=300')
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
    const user = c.get('user')
    const { householdId, weekStartDate } = c.req.valid('param')
    if (!isMonday(weekStartDate)) return c.json({ error: 'INVALID_WEEK_START_DATE' } as never, 400)
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' }, 404)
    const summary = await getWeekPlanSummary(db, accessToken, householdId, weekStartDate)

    if (!summary) return c.json({ error: 'Household not found.' } as never, 404)
    c.header('Cache-Control', 'private, max-age=300')
    return c.json(summary, 200)
  })

  app.openapi(listWeekHistoryPlansRoute, async (c) => {
    const user = c.get('user')
    const accessToken = c.get('accessToken')
    const { householdId } = c.req.valid('param')
    const { from, to } = c.req.valid('query')
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' } as never, 404)

    if ((from && !isMonday(from)) || (to && !isMonday(to))) return c.json({ error: 'INVALID_WEEK_RANGE' } as never, 400)

    const plans = await listWeekHistoryPlans(db, accessToken, householdId, { from, to })
    return c.json(plans, 200)
  })

  app.openapi(getWeekHistoryPlanRoute, async (c) => {
    const user = c.get('user')
    const accessToken = c.get('accessToken')
    const { householdId, weekStartDate } = c.req.valid('param')
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ week: null } as never, 200)

    if (!isMonday(weekStartDate)) return c.json({ error: 'INVALID_WEEK_START_DATE' } as never, 400)

    const week = await getWeekHistoryPlan(db, accessToken, householdId, weekStartDate)
    return c.json({ week }, 200)
  })

  app.openapi(upsertWeekHistoryPlanRoute, async (c) => {
    const user = c.get('user')
    const accessToken = c.get('accessToken')
    const { householdId, weekStartDate } = c.req.valid('param')
    const body = c.req.valid('json')
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' } as never, 404)

    if (!isMonday(weekStartDate)) return c.json({ error: 'INVALID_WEEK_START_DATE' } as never, 400)

    const result = await upsertWeekHistoryPlan(db, accessToken, user.id, householdId, weekStartDate, body)
    if (result.outcome === 'stale') return c.json({ error: 'STALE_WEEK_PLAN_STATE', updatedAt: result.updatedAt }, 409)

    return c.json({
      ok: true,
      weekStartDate: result.plan.weekStartDate,
      weekNumber: result.plan.weekNumber,
      weekYear: result.plan.weekYear,
      updatedAt: result.plan.updatedAt,
    }, 200)
  })

  app.openapi(finalizeWeekHistoryPlanRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId, weekStartDate } = c.req.valid('param')

    if (!isMonday(weekStartDate)) return c.json({ error: 'INVALID_WEEK_START_DATE' } as never, 400)

    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' }, 404)

    const plan = await finalizeWeekHistoryPlan(db, accessToken, user.id, householdId, weekStartDate)
    if (!plan) return c.json({ error: 'WEEK_PLAN_NOT_FOUND' } as never, 404)

    return c.json({ ok: true, weekStartDate, status: 'finalized', updatedAt: plan.updatedAt }, 200)
  })

  return app
}

// Exported for tests that need to seed projection rows directly (bypassing
// appendWeekPlanEvent) to prove the read path reflects the projection, never a
// replay of the log.
export { foldEventIntoProjection, emptyProjectionState }
export type { TWeekPlanProjectionState }
