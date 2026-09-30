import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, desc, eq, gte, inArray, lte, or } from 'drizzle-orm'
import { requireAuth, type AuthedUser } from './auth.js'
import { appendStreamEvent, getStreamProjection } from './event-stream.js'
import { assertMembership } from './membership.js'
import { withRls } from './rls.js'
import { releaseWeeklyGenerationBestEffort, reserveWeeklyGeneration, serverWeeklyUsagePeriodStart } from './ai-usage.js'
import { resolveEntitlementForHousehold } from './entitlements.js'
import { observePremiumGate, PremiumRequiredResponseSchema } from './premium-gates.js'
import { detectConfirmedFatiguedMeals, recipeIdsFromRecords, resolveMealHistory } from './meal-history.js'
import { householdMealOutcomes, householdMealSignals, householdPrepBatchAssignments, householdPrepBatches, householdProfiles, householdSavedRecipes, householdWeekPlans, households, mealFeedback, recipes, weekPlanEvents, weekPlanProjections } from './schema.js'
import { readRecipeIngredients } from './ingredient-categories.js'
import { upsertMealOutcome } from './meal-outcomes.js'
import {
  DayPlanningContextSchema,
  HouseholdDaySelectionSchema,
  WeekContextOverrideSchema,
  WeekdaySchema,
  mergeDayPlanningContext,
  type TWeekContextOverride,
} from './planning-context.js'
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
  type THouseholdMealSignalState,
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

const dayOfWeek = WeekdaySchema
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
  'week_context_override_upserted',
  'week_context_override_cleared',
  'week_rescued',
  'week_plan_cleared',
])

const PrioritySchema = z.enum(['quick', 'budget', 'child-friendly', 'meal-prep', 'varied'])
const PlanningDaySelectionSchema = HouseholdDaySelectionSchema
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
const AssignmentReasonSchema = z.enum(['family-recipe', 'liked-before', 'back-after-break', 'based-on-feedback', 'new-for-variety', 'quick-weekday', 'week-override'])
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
  servings: z.number().int().min(1).optional(),
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

const WeekContextOverrideUpsertedPayloadSchema = z.object({
  eventType: z.literal('week_context_override_upserted'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'),
  override: WeekContextOverrideSchema,
})

const WeekContextOverrideClearedPayloadSchema = z.object({
  eventType: z.literal('week_context_override_cleared'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'),
})

const RescueIntentSchema = z.enum(['quick', 'no-energy', 'missing-ingredient', 'extra-guest', 'swap-day']).openapi('WeekRescueIntent')
const RescueChangeSchema = z.object({
  date: z.string(),
  dayOfWeek,
  beforeRecipeRef: z.string().uuid().nullable(),
  beforeRecipeTitle: z.string().nullable(),
  afterRecipeRef: z.string().uuid().nullable(),
  afterRecipeTitle: z.string().nullable(),
  beforeServings: z.number().int().min(1).nullable(),
  afterServings: z.number().int().min(1).nullable(),
}).openapi('WeekRescueChange')

const WeekRescuedPayloadSchema = z.object({
  eventType: z.literal('week_rescued'),
  rescueId: z.string().uuid(),
  rescueReason: RescueIntentSchema,
  changes: z.array(RescueChangeSchema).min(1),
  shoppingDiff: z.object({ added: z.array(z.string()), removed: z.array(z.string()) }),
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
  WeekContextOverrideUpsertedPayloadSchema,
  WeekContextOverrideClearedPayloadSchema,
  WeekRescuedPayloadSchema,
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
const ContextOverrideParamsSchema = ParamsSchema.extend({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'),
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

const WeekPlanExplanationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('week-context'),
    date: z.string(),
    recipeTitle: z.string(),
  }),
  z.object({
    kind: z.literal('leftover-chain'),
    recipeTitle: z.string(),
    cookDate: z.string(),
    coveredDates: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('shared-ingredient'),
    ingredient: z.string(),
    dinnerCount: z.number().int().min(2),
  }),
]).openapi('WeekPlanExplanation')

const WeekPlanSummarySchema = z.object({
  household: z.object({ id: z.string().uuid(), name: z.string() }),
  weekStartDate: z.string(),
  updatedAt: z.string().nullable(),
  explanations: z.array(WeekPlanExplanationSchema).max(2),
  days: z.array(WeekPlanSummaryDaySchema),
}).openapi('WeekPlanSummary')

const WeekRescueRequestSchema = z.object({
  rescueId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  intent: RescueIntentSchema,
  missingIngredient: z.string().trim().min(1).max(80).optional(),
  expectedUpdatedAt: z.string().nullable(),
}).superRefine((value, context) => {
  if (value.intent === 'missing-ingredient' && !value.missingIngredient) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['missingIngredient'], message: 'Required for missing-ingredient rescue' })
  }
}).openapi('WeekRescueRequest')

const WeekRescuePreviewSchema = z.object({
  rescueId: z.string().uuid(),
  intent: RescueIntentSchema,
  reason: z.enum(['faster', 'less-effort', 'avoids-ingredient', 'more-portions', 'swaps-days']),
  primaryChange: RescueChangeSchema,
  followUpChanges: z.array(RescueChangeSchema),
  shoppingDiff: z.object({ added: z.array(z.string()), removed: z.array(z.string()) }),
  expectedUpdatedAt: z.string().nullable(),
}).openapi('WeekRescuePreview')

const WeekRescueApplyResponseSchema = z.object({
  ok: z.literal(true),
  alreadyApplied: z.boolean(),
  preview: WeekRescuePreviewSchema,
}).openapi('WeekRescueApplyResponse')

const WeekRescueErrorSchema = z.object({
  error: z.enum(['NO_PLAN', 'LOCKED_DAY', 'NO_RESCUE_FOUND', 'STALE_WEEK_PLAN']),
}).openapi('WeekRescueError')

const WeekContextOverrideItemSchema = DayPlanningContextSchema.extend({
  date: z.string(),
}).openapi('WeekContextOverride')

const WeekContextOverridesResponseSchema = z.object({
  overrides: z.array(WeekContextOverrideItemSchema),
}).openapi('WeekContextOverridesResponse')

const ClearWeekContextOverrideResponseSchema = z.object({
  ok: z.literal(true),
}).openapi('ClearWeekContextOverrideResponse')

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
  // Optional for projections written before AVL-007. New folds always write
  // the field, while readers treat its absence as an empty override layer.
  contextOverrides?: Record<string, TWeekContextOverride>
}

const emptyProjectionState = (): TWeekPlanProjectionState => ({
  weekStarted: false,
  request: null,
  meals: {},
  lockedDays: [],
  skippedDays: [],
  contextOverrides: {},
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
            servings: payload.servings ?? state.meals[payload.dayOfWeek]?.servings,
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
    case 'week_context_override_upserted':
      return {
        ...state,
        contextOverrides: {
          ...(state.contextOverrides ?? {}),
          [payload.date]: payload.override,
        },
      }
    case 'week_context_override_cleared': {
      const contextOverrides = { ...(state.contextOverrides ?? {}) }
      delete contextOverrides[payload.date]
      return { ...state, contextOverrides }
    }
    case 'week_rescued': {
      const meals = { ...state.meals }
      const skippedDays = [...state.skippedDays]
      for (const change of payload.changes) {
        if (change.afterRecipeRef) {
          meals[change.dayOfWeek] = {
            recipeRef: change.afterRecipeRef,
            servings: change.afterServings ?? undefined,
          }
        } else {
          delete meals[change.dayOfWeek]
        }
        const skippedIndex = skippedDays.indexOf(change.dayOfWeek)
        if (skippedIndex >= 0) skippedDays.splice(skippedIndex, 1)
      }
      return { ...state, meals, skippedDays }
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

const previewWeekRescueRoute = createRoute({
  method: 'post',
  path: '/households/{householdId}/week-plans/{weekStartDate}/rescue/preview',
  operationId: 'previewWeekRescue',
  summary: 'Preview one concrete rescue for a disrupted dinner plan',
  security: [{ bearerAuth: [] }],
  request: {
    params: ParamsSchema,
    body: { content: { 'application/json': { schema: WeekRescueRequestSchema } } },
  },
  responses: {
    200: { description: 'A non-mutating rescue preview', content: { 'application/json': { schema: WeekRescuePreviewSchema } } },
    409: { description: 'The plan changed since the request was created', content: { 'application/json': { schema: WeekRescueErrorSchema } } },
    422: { description: 'No safe rescue is available', content: { 'application/json': { schema: WeekRescueErrorSchema } } },
    401: { description: 'Missing or invalid session' },
    404: { description: 'Household not found or caller is not a member' },
  },
})

const applyWeekRescueRoute = createRoute({
  method: 'post',
  path: '/households/{householdId}/week-plans/{weekStartDate}/rescue/apply',
  operationId: 'applyWeekRescue',
  summary: 'Apply a previously previewed rescue idempotently',
  security: [{ bearerAuth: [] }],
  request: {
    params: ParamsSchema,
    body: { content: { 'application/json': { schema: WeekRescueRequestSchema } } },
  },
  responses: {
    200: { description: 'The rescue was applied or had already been applied', content: { 'application/json': { schema: WeekRescueApplyResponseSchema } } },
    409: { description: 'The plan changed since preview', content: { 'application/json': { schema: WeekRescueErrorSchema } } },
    422: { description: 'No safe rescue is available', content: { 'application/json': { schema: WeekRescueErrorSchema } } },
    401: { description: 'Missing or invalid session' },
    404: { description: 'Household not found or caller is not a member' },
  },
})

const getWeekContextOverridesRoute = createRoute({
  method: 'get',
  path: '/households/{householdId}/week-plans/{weekStartDate}/context-overrides',
  operationId: 'getWeekContextOverrides',
  summary: 'Read date-specific planning context for one week',
  security: [{ bearerAuth: [] }],
  request: { params: ParamsSchema },
  responses: {
    200: {
      description: 'The explicit overrides saved for this week',
      content: { 'application/json': { schema: WeekContextOverridesResponseSchema } },
    },
    400: { description: 'Invalid week start date' },
    401: { description: 'Missing or invalid session' },
    404: { description: 'Household not found or caller is not a member' },
  },
})

const upsertWeekContextOverrideRoute = createRoute({
  method: 'put',
  path: '/households/{householdId}/week-plans/{weekStartDate}/context-overrides/{date}',
  operationId: 'upsertWeekContextOverride',
  summary: 'Create or replace date-specific planning context for one week',
  security: [{ bearerAuth: [] }],
  request: {
    params: ContextOverrideParamsSchema,
    body: { content: { 'application/json': { schema: WeekContextOverrideSchema } } },
  },
  responses: {
    200: {
      description: 'The saved override',
      content: { 'application/json': { schema: WeekContextOverrideItemSchema } },
    },
    400: { description: 'Invalid week or date' },
    401: { description: 'Missing or invalid session' },
    404: { description: 'Household not found or caller is not a member' },
  },
})

const clearWeekContextOverrideRoute = createRoute({
  method: 'delete',
  path: '/households/{householdId}/week-plans/{weekStartDate}/context-overrides/{date}',
  operationId: 'clearWeekContextOverride',
  summary: 'Clear date-specific planning context for one week',
  security: [{ bearerAuth: [] }],
  request: { params: ContextOverrideParamsSchema },
  responses: {
    200: {
      description: 'The override was cleared',
      content: { 'application/json': { schema: ClearWeekContextOverrideResponseSchema } },
    },
    400: { description: 'Invalid week or date' },
    401: { description: 'Missing or invalid session' },
    404: { description: 'Household not found or caller is not a member' },
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
    403: { description: 'Premium is required for older history', content: { 'application/json': { schema: PremiumRequiredResponseSchema } } },
    404: { description: 'Household not found or caller is not a member' },
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
    403: { description: 'Premium generation quota reached', content: { 'application/json': { schema: PremiumRequiredResponseSchema } } },
    401: { description: 'Missing or invalid session' },
    404: { description: 'Household not found or caller is not a member' },
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

export function addDays(yyyyMmDd: string, offset: number) {
  const date = new Date(`${yyyyMmDd}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

export function isMonday(yyyyMmDd: string) {
  return new Date(`${yyyyMmDd}T00:00:00.000Z`).getUTCDay() === 1
}

function isDateInWeek(weekStartDate: string, date: string) {
  return date >= weekStartDate && date <= addDays(weekStartDate, 6)
}

function isValidISODateString(value: string | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function requestToday(value: string | undefined) {
  return isValidISODateString(value) ? value : new Date().toISOString().slice(0, 10)
}

function defaultTodayForWeek(weekStartDate: string) {
  const currentDate = requestToday(undefined)
  return currentDate >= weekStartDate && currentDate <= addDays(weekStartDate, 6)
    ? currentDate
    : weekStartDate
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
    contextOverrides: candidate?.contextOverrides && typeof candidate.contextOverrides === 'object'
      ? candidate.contextOverrides
      : {},
  }
}

function contextOverrideItems(state: TWeekPlanProjectionState, weekStartDate: string) {
  return Object.entries(state.contextOverrides ?? {})
    .filter(([date]) => isDateInWeek(weekStartDate, date))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, override]) => ({ date, ...override }))
}

export async function getWeekContextOverrides(
  db: Db,
  accessToken: string,
  householdId: string,
  weekStartDate: string,
) {
  const projection = await getStreamProjection(
    db,
    accessToken,
    weekPlanProjections,
    { householdId, weekStartDate },
  )
  return contextOverrideItems(readProjectionState(projection?.state), weekStartDate)
}

export async function upsertWeekContextOverride(
  db: Db,
  accessToken: string,
  userId: string,
  householdId: string,
  weekStartDate: string,
  date: string,
  override: TWeekContextOverride,
) {
  await appendStreamEvent(
    db,
    accessToken,
    { events: weekPlanEvents, projections: weekPlanProjections },
    { fold: foldEventIntoProjection, emptyState: emptyProjectionState },
    {
      householdId,
      weekStartDate,
      causedBy: { source: 'user', userId },
      payload: { eventType: 'week_context_override_upserted', date, override },
    },
  )
  return { date, ...override }
}

export async function clearWeekContextOverride(
  db: Db,
  accessToken: string,
  userId: string,
  householdId: string,
  weekStartDate: string,
  date: string,
) {
  await appendStreamEvent(
    db,
    accessToken,
    { events: weekPlanEvents, projections: weekPlanProjections },
    { fold: foldEventIntoProjection, emptyState: emptyProjectionState },
    {
      householdId,
      weekStartDate,
      causedBy: { source: 'user', userId },
      payload: { eventType: 'week_context_override_cleared', date },
    },
  )
}

function readJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function readStringArray(value: unknown): string[] {
  return readJsonArray(value).filter((item): item is string => typeof item === 'string')
}

function readIngredientArray(value: unknown): Array<{ item: string }> {
  return readJsonArray(value).filter((item): item is { item: string } =>
    Boolean(item && typeof item === 'object' && 'item' in item && typeof item.item === 'string'),
  )
}

// Avoid-matching, in order of signal quality:
//   - Itemized ingredients + tags are matched *always*. Ingredients are the
//     strongest signal; tags are short curated labels (e.g. a "peanut" tag on
//     "Peanut Noodles") and carry genuine allergen intent, so dropping them
//     would turn a real exclusion into a false negative — worse than the bug
//     we're fixing.
//   - The free-prose *title* is matched *only* when the recipe has fewer than
//     two itemized ingredients. The title is the false-positive-prone signal:
//     `avoid="ost"` matched "Rostad kyckling" because "ost" is a substring of
//     "Rostad". A properly itemized recipe should be judged on its ingredients
//     and tags, not on substrings of its name. But a title-only or
//     partially-itemized recipe (e.g. a URL import that only captured one
//     ingredient) still needs the title as a safety net — onboarding's
//     go-to-dish creates a title-only recipe when AI fill-in doesn't
//     complete, and a title-only "Fiskgratäng" must stay filtered for a
//     "fisk" avoid. Two itemized ingredients is the threshold for trusting
//     the ingredient list over the title.
// Substring matching is still crude on compound-word languages (see
// PLAN-ingrediens-taxonomi.md) — this only removes the *title* false positives
// for the common case where the recipe is properly itemized.
export function recipeMatchesAvoided(
  recipe: { title: string; tags: unknown; ingredients: unknown },
  avoidIngredients: string[],
): boolean {
  const avoided = avoidIngredients.map((a) => a.trim().toLowerCase()).filter((a) => a !== '')
  if (avoided.length === 0) return false
  const ingredientItems = readIngredientArray(recipe.ingredients)
    .map((i) => i.item.trim().toLowerCase())
    .filter((item) => item !== '')
  const haystacks = [...readStringArray(recipe.tags).map((t) => t.trim().toLowerCase())]
  haystacks.push(...ingredientItems)
  if (ingredientItems.length < 2) {
    haystacks.push(recipe.title.toLowerCase())
  }
  return avoided.some((lower) => haystacks.some((h) => h.includes(lower)))
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

type TWeekExplanation = z.infer<typeof WeekPlanExplanationSchema>

const EXCLUDED_SHARED_INGREDIENTS = new Set([
  'salt', 'salt and pepper', 'pepper', 'black pepper', 'water', 'oil', 'olive oil',
  'salt och peppar', 'svartpeppar', 'vatten', 'olja', 'olivolja',
])

function normalizedIngredientName(value: string) {
  return value.trim().toLocaleLowerCase('sv-SE').replace(/\s+/g, ' ')
}

export function deriveWeekExplanations(input: {
  days: Array<{ date: string; reason: string | null; recipe: { id: string; title: string } | null }>
  recipeIngredients: Map<string, Array<{ item: string }>>
  prepLinks: Array<{ recipeId: string | null; recipeTitle: string | null; cookDate: string; coveredDates: string[] }>
}): TWeekExplanation[] {
  const explanations: TWeekExplanation[] = []

  const contextDay = input.days.find((day) => day.reason === 'week-override' && day.recipe)
  if (contextDay?.recipe) {
    explanations.push({ kind: 'week-context', date: contextDay.date, recipeTitle: contextDay.recipe.title })
  }

  const prepLink = input.prepLinks
    .filter((link) => link.recipeTitle && link.coveredDates.some((date) => date > link.cookDate))
    .sort((left, right) => left.cookDate.localeCompare(right.cookDate))[0]
  if (prepLink?.recipeTitle) {
    explanations.push({
      kind: 'leftover-chain',
      recipeTitle: prepLink.recipeTitle,
      cookDate: prepLink.cookDate,
      coveredDates: [...new Set(prepLink.coveredDates.filter((date) => date > prepLink.cookDate))].sort(),
    })
  }

  const ingredientUsage = new Map<string, { label: string; recipeIds: Set<string> }>()
  for (const day of input.days) {
    if (!day.recipe) continue
    for (const ingredient of input.recipeIngredients.get(day.recipe.id) ?? []) {
      const normalized = normalizedIngredientName(ingredient.item)
      if (!normalized || EXCLUDED_SHARED_INGREDIENTS.has(normalized)) continue
      const usage = ingredientUsage.get(normalized) ?? { label: ingredient.item.trim(), recipeIds: new Set<string>() }
      usage.recipeIds.add(day.recipe.id)
      ingredientUsage.set(normalized, usage)
    }
  }
  const sharedIngredient = [...ingredientUsage.entries()]
    .filter(([, usage]) => usage.recipeIds.size >= 2)
    .sort(([leftKey, left], [rightKey, right]) => right.recipeIds.size - left.recipeIds.size || leftKey.localeCompare(rightKey))[0]?.[1]
  if (sharedIngredient) {
    explanations.push({ kind: 'shared-ingredient', ingredient: sharedIngredient.label, dinnerCount: sharedIngredient.recipeIds.size })
  }

  return explanations.slice(0, 2)
}

type TWeekRescueRequest = z.infer<typeof WeekRescueRequestSchema>
type TWeekRescuePreview = z.infer<typeof WeekRescuePreviewSchema>
type TWeekRescueFailure = 'NO_PLAN' | 'LOCKED_DAY' | 'NO_RESCUE_FOUND' | 'STALE_WEEK_PLAN'

type TRescueRecipe = {
  id: string
  title: string
  servings: number
  prepTimeMinutes: number | null
  cookTimeMinutes: number | null
  ingredients: unknown
  tags: unknown
}

function ingredientNames(recipe: TRescueRecipe | undefined) {
  return readRecipeIngredients(recipe?.ingredients).map((ingredient) => ingredient.item.trim()).filter(Boolean)
}

function normalizedIngredientSet(recipe: TRescueRecipe | undefined) {
  return new Set(ingredientNames(recipe).map(normalizedIngredientName))
}

function rescueChange(
  date: string,
  weekday: z.infer<typeof dayOfWeek>,
  before: TRescueRecipe | undefined,
  after: TRescueRecipe | undefined,
  beforeServings: number | null,
  afterServings: number | null,
) {
  return {
    date,
    dayOfWeek: weekday,
    beforeRecipeRef: before?.id ?? null,
    beforeRecipeTitle: before?.title ?? null,
    afterRecipeRef: after?.id ?? null,
    afterRecipeTitle: after?.title ?? null,
    beforeServings,
    afterServings,
  }
}

export function deriveWeekRescuePreview(input: {
  request: TWeekRescueRequest
  weekStartDate: string
  updatedAt: string | null
  projection: TWeekPlanProjectionState
  recipes: TRescueRecipe[]
  preferredLeftoverRecipeIds?: Set<string>
}): TWeekRescuePreview | { error: TWeekRescueFailure } {
  if (input.request.expectedUpdatedAt !== input.updatedAt) return { error: 'STALE_WEEK_PLAN' }
  const dayIndex = Math.round((Date.parse(`${input.request.date}T00:00:00Z`) - Date.parse(`${input.weekStartDate}T00:00:00Z`)) / 86400000)
  const targetDay = orderedDays[dayIndex]
  if (!targetDay) return { error: 'NO_PLAN' }
  if (input.projection.lockedDays.includes(targetDay)) return { error: 'LOCKED_DAY' }
  const targetMeal = input.projection.meals[targetDay]
  if (!targetMeal) return { error: 'NO_PLAN' }
  const recipesById = new Map(input.recipes.map((recipe) => [recipe.id, recipe]))
  const before = recipesById.get(targetMeal.recipeRef)
  if (!before) return { error: 'NO_PLAN' }

  if (input.request.intent === 'extra-guest') {
    return {
      rescueId: input.request.rescueId,
      intent: input.request.intent,
      reason: 'more-portions',
      primaryChange: rescueChange(input.request.date, targetDay, before, before, targetMeal.servings ?? before.servings, (targetMeal.servings ?? before.servings) + 1),
      followUpChanges: [],
      shoppingDiff: { added: [], removed: [] },
      expectedUpdatedAt: input.updatedAt,
    }
  }

  if (input.request.intent === 'swap-day') {
    const swapIndex = orderedDays.findIndex((day, index) => index > dayIndex
      && !input.projection.lockedDays.includes(day)
      && Boolean(input.projection.meals[day]))
    if (swapIndex < 0) return { error: 'NO_RESCUE_FOUND' }
    const swapDay = orderedDays[swapIndex]!
    const swapMeal = input.projection.meals[swapDay]!
    const swapRecipe = recipesById.get(swapMeal.recipeRef)
    if (!swapRecipe) return { error: 'NO_RESCUE_FOUND' }
    return {
      rescueId: input.request.rescueId,
      intent: input.request.intent,
      reason: 'swaps-days',
      primaryChange: rescueChange(input.request.date, targetDay, before, swapRecipe, targetMeal.servings ?? before.servings, swapMeal.servings ?? swapRecipe.servings),
      followUpChanges: [rescueChange(addDays(input.weekStartDate, swapIndex), swapDay, swapRecipe, before, swapMeal.servings ?? swapRecipe.servings, targetMeal.servings ?? before.servings)],
      shoppingDiff: { added: [], removed: [] },
      expectedUpdatedAt: input.updatedAt,
    }
  }

  const missing = normalizedIngredientName(input.request.missingIngredient ?? '')
  const weekIngredientNames = new Set<string>()
  for (const meal of Object.values(input.projection.meals)) {
    for (const name of normalizedIngredientSet(recipesById.get(meal.recipeRef))) weekIngredientNames.add(name)
  }
  const candidates = input.recipes
    .filter((recipe) => recipe.id !== before.id)
    .filter((recipe) => input.request.intent !== 'missing-ingredient'
      || ![...normalizedIngredientSet(recipe)].some((name) => name.includes(missing) || missing.includes(name)))
    .map((recipe) => {
      const totalMinutes = (recipe.prepTimeMinutes ?? 0) + (recipe.cookTimeMinutes ?? 0)
      const overlap = [...normalizedIngredientSet(recipe)].filter((name) => weekIngredientNames.has(name)).length
      const ingredientCount = ingredientNames(recipe).length
      let score = overlap * 4 - ingredientCount
      if (input.preferredLeftoverRecipeIds?.has(recipe.id)) score += 100
      if (totalMinutes > 0 && totalMinutes <= 20) score += 30
      else if (totalMinutes > 0 && totalMinutes <= 30) score += 15
      if (input.request.intent === 'quick' && (totalMinutes <= 0 || totalMinutes > 20)) score -= 100
      if (input.request.intent === 'no-energy' && (totalMinutes <= 0 || totalMinutes > 30 || ingredientCount > 8)) score -= 100
      return { recipe, score }
    })
    .filter(({ score }) => score > -90)
    .sort((left, right) => right.score - left.score || left.recipe.title.localeCompare(right.recipe.title))
  const replacement = candidates[0]?.recipe
  if (!replacement) return { error: 'NO_RESCUE_FOUND' }

  const beforePlan = new Map(Object.entries(input.projection.meals).map(([day, meal]) => [day, meal.recipeRef]))
  const afterPlan = new Map(beforePlan)
  afterPlan.set(targetDay, replacement.id)
  const union = (plan: Map<string, string>) => {
    const labels = new Map<string, string>()
    for (const recipeId of plan.values()) {
      for (const label of ingredientNames(recipesById.get(recipeId))) labels.set(normalizedIngredientName(label), label)
    }
    return labels
  }
  const beforeIngredients = union(beforePlan)
  const afterIngredients = union(afterPlan)
  const added = [...afterIngredients].filter(([key]) => !beforeIngredients.has(key)).map(([, label]) => label).sort()
  const removed = [...beforeIngredients].filter(([key]) => !afterIngredients.has(key)).map(([, label]) => label).sort()

  return {
    rescueId: input.request.rescueId,
    intent: input.request.intent,
    reason: input.request.intent === 'quick' ? 'faster' : input.request.intent === 'no-energy' ? 'less-effort' : 'avoids-ingredient',
    primaryChange: rescueChange(input.request.date, targetDay, before, replacement, targetMeal.servings ?? before.servings, targetMeal.servings ?? replacement.servings),
    followUpChanges: [],
    shoppingDiff: { added, removed },
    expectedUpdatedAt: input.updatedAt,
  }
}

export async function previewWeekRescue(db: Db, accessToken: string, householdId: string, weekStartDate: string, request: TWeekRescueRequest) {
  return withRls(db, accessToken, async (tx) => {
    const [[projection], recipeRows, prepBatches] = await Promise.all([
      tx.select({ state: weekPlanProjections.state, updatedAt: weekPlanProjections.updatedAt })
        .from(weekPlanProjections)
        .where(and(eq(weekPlanProjections.householdId, householdId), eq(weekPlanProjections.weekStartDate, weekStartDate)))
        .limit(1),
      tx.select({
        id: recipes.id,
        title: recipes.title,
        servings: recipes.servings,
        prepTimeMinutes: recipes.prepTimeMinutes,
        cookTimeMinutes: recipes.cookTimeMinutes,
        ingredients: recipes.ingredients,
        tags: recipes.tags,
      }).from(recipes).where(and(
        or(eq(recipes.householdId, householdId), eq(recipes.isPublic, true)),
        eq(recipes.isArchived, false),
      )),
      tx.select({ id: householdPrepBatches.id, recipeId: householdPrepBatches.recipeId })
        .from(householdPrepBatches)
        .where(and(eq(householdPrepBatches.householdId, householdId), lte(householdPrepBatches.cookDate, request.date))),
    ])
    if (!projection) return { error: 'NO_PLAN' as const }
    const assignments = prepBatches.length
      ? await tx.select({ batchId: householdPrepBatchAssignments.batchId })
        .from(householdPrepBatchAssignments)
        .where(and(
          inArray(householdPrepBatchAssignments.batchId, prepBatches.map((batch) => batch.id)),
          eq(householdPrepBatchAssignments.date, request.date),
        ))
      : []
    const assignedBatchIds = new Set(assignments.map((assignment) => assignment.batchId))
    const preferredLeftoverRecipeIds = new Set(prepBatches
      .filter((batch) => assignedBatchIds.has(batch.id) && batch.recipeId)
      .map((batch) => batch.recipeId!))
    return deriveWeekRescuePreview({
      request,
      weekStartDate,
      updatedAt: projection.updatedAt.toISOString(),
      projection: readProjectionState(projection.state),
      recipes: recipeRows,
      preferredLeftoverRecipeIds,
    })
  })
}

export async function applyWeekRescue(db: Db, accessToken: string, userId: string, householdId: string, weekStartDate: string, request: TWeekRescueRequest) {
  const existing = await withRls(db, accessToken, async (tx) => tx
    .select({ eventType: weekPlanEvents.eventType, payload: weekPlanEvents.payload })
    .from(weekPlanEvents)
    .where(and(eq(weekPlanEvents.householdId, householdId), eq(weekPlanEvents.weekStartDate, weekStartDate))))
  const existingPayload = existing
    .filter((row) => row.eventType === 'week_rescued')
    .map((row) => row.payload as Omit<z.infer<typeof WeekRescuedPayloadSchema>, 'eventType'>)
    .find((payload) => payload.rescueId === request.rescueId)
  if (existingPayload) {
    const changes = existingPayload.changes
    return { ok: true as const, alreadyApplied: true, preview: {
      rescueId: request.rescueId,
      intent: existingPayload.rescueReason,
      reason: existingPayload.rescueReason === 'extra-guest' ? 'more-portions' as const : existingPayload.rescueReason === 'swap-day' ? 'swaps-days' as const : existingPayload.rescueReason === 'quick' ? 'faster' as const : existingPayload.rescueReason === 'no-energy' ? 'less-effort' as const : 'avoids-ingredient' as const,
      primaryChange: changes[0]!, followUpChanges: changes.slice(1), shoppingDiff: existingPayload.shoppingDiff, expectedUpdatedAt: request.expectedUpdatedAt,
    } }
  }

  const preview = await previewWeekRescue(db, accessToken, householdId, weekStartDate, request)
  if ('error' in preview) return preview
  try {
    await appendStreamEvent(
      db,
      accessToken,
      { events: weekPlanEvents, projections: weekPlanProjections },
      { fold: foldEventIntoProjection, emptyState: emptyProjectionState },
      { householdId, weekStartDate, causedBy: { source: 'user', userId }, payload: {
        eventType: 'week_rescued', rescueId: request.rescueId, rescueReason: request.intent,
        changes: [preview.primaryChange, ...preview.followUpChanges],
        shoppingDiff: preview.shoppingDiff,
      } },
    )
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      return applyWeekRescue(db, accessToken, userId, householdId, weekStartDate, request)
    }
    throw error
  }
  if (preview.primaryChange.beforeRecipeRef && preview.primaryChange.afterRecipeRef
    && preview.primaryChange.beforeRecipeRef !== preview.primaryChange.afterRecipeRef) {
    // The rescue event is the source of truth for the plan mutation. Outcome
    // attribution is secondary memory; never report a failed rescue after the
    // plan has committed, since the client would correctly assume no change.
    try {
      await upsertMealOutcome(db, accessToken, userId, householdId, preview.primaryChange.date, {
        weekStartDate,
        plannedRecipeId: preview.primaryChange.beforeRecipeRef,
        status: 'changed_plan',
        actualRecipeId: preview.primaryChange.afterRecipeRef,
      })
    } catch (error) {
      console.error('[week-rescue] failed to record changed_plan outcome', error)
    }
  }
  return { ok: true as const, alreadyApplied: false, preview }
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

    const allWeekStartDates = [weekStartDate, ...priorWeekStartDates]
    const [[projection], priorWeekProjections, outcomeRows] = await Promise.all([
      tx
        .select({ state: weekPlanProjections.state, updatedAt: weekPlanProjections.updatedAt })
        .from(weekPlanProjections)
        .where(and(eq(weekPlanProjections.householdId, householdId), eq(weekPlanProjections.weekStartDate, weekStartDate)))
        .limit(1),
      tx
        .select({ weekStartDate: weekPlanProjections.weekStartDate, state: weekPlanProjections.state })
        .from(weekPlanProjections)
        .where(and(eq(weekPlanProjections.householdId, householdId), inArray(weekPlanProjections.weekStartDate, priorWeekStartDates))),
      tx
        .select({
          weekStartDate: householdMealOutcomes.weekStartDate,
          plannedRecipeId: householdMealOutcomes.plannedRecipeId,
          status: householdMealOutcomes.status,
          actualRecipeId: householdMealOutcomes.actualRecipeId,
        })
        .from(householdMealOutcomes)
        .where(and(
          eq(householdMealOutcomes.householdId, householdId),
          inArray(householdMealOutcomes.weekStartDate, allWeekStartDates),
        )),
    ])

    const projectionState = readProjectionState(projection?.state)
    const recipeIds = orderedDays
      .map((day) => projectionState.meals[day]?.recipeRef)
      .filter((id): id is string => Boolean(id))

    const priorPlansByDate = new Map(
      priorWeekProjections.map((row) => [row.weekStartDate, Object.values(readProjectionState(row.state).meals).map((m) => m.recipeRef)]),
    )
    const resolvedHistory = resolveMealHistory(
      allWeekStartDates.map((date) => ({
        weekStartDate: date,
        mealIds: date === weekStartDate ? recipeIds : priorPlansByDate.get(date) ?? [],
      })),
      outcomeRows,
    )
    const confirmedWeeksByDate = new Map(
      resolvedHistory.confirmedRecords.map((record) => [record.weekStartDate, record.mealIds]),
    )
    const weeksMostRecentFirst = [
      confirmedWeeksByDate.get(weekStartDate) ?? [],
      ...priorWeekStartDates.map((date) => confirmedWeeksByDate.get(date) ?? []),
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
          ingredients: recipes.ingredients,
        })
        .from(recipes)
        .where(and(or(eq(recipes.householdId, householdId), eq(recipes.isPublic, true)), inArray(recipes.id, recipeIds)))
      : []

    const recipesById = new Map(recipeRows.map((recipe) => [recipe.id, recipe]))

    const prepBatches = await tx
      .select({ id: householdPrepBatches.id, recipeId: householdPrepBatches.recipeId, cookDate: householdPrepBatches.cookDate })
      .from(householdPrepBatches)
      .where(and(
        eq(householdPrepBatches.householdId, householdId),
        gte(householdPrepBatches.cookDate, weekStartDate),
        lte(householdPrepBatches.cookDate, addDays(weekStartDate, 6)),
      ))
    const prepAssignments = prepBatches.length
      ? await tx
        .select({ batchId: householdPrepBatchAssignments.batchId, date: householdPrepBatchAssignments.date })
        .from(householdPrepBatchAssignments)
        .where(inArray(householdPrepBatchAssignments.batchId, prepBatches.map((batch) => batch.id)))
      : []
    const assignmentsByBatch = new Map<string, string[]>()
    for (const assignment of prepAssignments) {
      assignmentsByBatch.set(assignment.batchId, [...(assignmentsByBatch.get(assignment.batchId) ?? []), assignment.date])
    }

    const days = orderedDays.map((dayOfWeek, index) => {
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
          servings: meal?.servings ?? recipe.servings,
          prepTimeMinutes: recipe.prepTimeMinutes ?? null,
          cookTimeMinutes: recipe.cookTimeMinutes ?? null,
          tags: readStringArray(recipe.tags),
        } : null,
      }
    })

    return {
      household,
      weekStartDate,
      updatedAt: projection?.updatedAt.toISOString() ?? null,
      explanations: deriveWeekExplanations({
        days,
        recipeIngredients: new Map(recipeRows.map((recipe) => [recipe.id, readRecipeIngredients(recipe.ingredients)])),
        prepLinks: prepBatches.map((batch) => ({
          recipeId: batch.recipeId,
          recipeTitle: batch.recipeId ? recipesById.get(batch.recipeId)?.title ?? null : null,
          cookDate: batch.cookDate,
          coveredDates: assignmentsByBatch.get(batch.id) ?? [],
        })),
      }),
      days,
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
  today = defaultTodayForWeek(weekStartDate),
): Promise<{ ok: true; generated: boolean } | { error: 'NO_RECIPES' } | { error: 'ALL_RECIPES_EXCLUDED' } | { error: 'NOT_MEMBER' }> {
  const member = await assertMembership(db, accessToken, householdId, userId)
  if (!member) return { error: 'NOT_MEMBER' as const }

  // Up to 6 prior Monday-start weeks — feeds both recency (last 1-2 weeks)
  // and fatigue detection (needs ≥4 weeks of history; see week-scoring.ts).
  const priorWeekStartDates = Array.from({ length: 6 }, (_, i) => addDays(weekStartDate, -7 * (i + 1)))

  const [profileRows, projection, poolRecipes, feedbackRows, householdSignalRows, priorWeekProjections, outcomeRows] = await Promise.all([
    withRls(db, accessToken, (tx) =>
      tx.select({ avoidIngredients: householdProfiles.avoidIngredients, selectedDays: householdProfiles.selectedDays })
        .from(householdProfiles).where(eq(householdProfiles.householdId, householdId)).limit(1)
    ),
    getStreamProjection(db, accessToken, weekPlanProjections, { householdId, weekStartDate }),
    withRls(db, accessToken, (tx) =>
      tx.select({
        id: recipes.id,
        title: recipes.title,
        servings: recipes.servings,
        prepTimeMinutes: recipes.prepTimeMinutes,
        tags: recipes.tags,
        ingredients: recipes.ingredients,
        cuisine: recipes.cuisine,
        proteinSource: recipes.proteinSource,
        mealWeight: recipes.mealWeight,
        householdId: recipes.householdId,
      })
        .from(recipes)
        .where(and(
          eq(recipes.isArchived, false),
          or(
            eq(recipes.householdId, householdId),
            eq(recipes.source, 'builtin'),
            inArray(
              recipes.id,
              tx.select({ id: householdSavedRecipes.recipeId }).from(householdSavedRecipes).where(eq(householdSavedRecipes.householdId, householdId)),
            ),
          ),
        ))
    ),
    withRls(db, accessToken, (tx) =>
      tx.select({ mealId: mealFeedback.mealId, vote: mealFeedback.vote, signal: mealFeedback.signal })
        .from(mealFeedback)
        .where(and(eq(mealFeedback.householdId, householdId), eq(mealFeedback.userId, userId)))
    ),
    withRls(db, accessToken, (tx) =>
      tx.select({ mealId: householdMealSignals.mealId, signal: householdMealSignals.signal })
        .from(householdMealSignals)
        .where(eq(householdMealSignals.householdId, householdId))
    ),
    withRls(db, accessToken, (tx) =>
      tx.select({ weekStartDate: weekPlanProjections.weekStartDate, state: weekPlanProjections.state })
        .from(weekPlanProjections)
        .where(and(eq(weekPlanProjections.householdId, householdId), inArray(weekPlanProjections.weekStartDate, priorWeekStartDates)))
    ),
    withRls(db, accessToken, (tx) =>
      tx.select({
        weekStartDate: householdMealOutcomes.weekStartDate,
        plannedRecipeId: householdMealOutcomes.plannedRecipeId,
        status: householdMealOutcomes.status,
        actualRecipeId: householdMealOutcomes.actualRecipeId,
      })
        .from(householdMealOutcomes)
        .where(and(
          eq(householdMealOutcomes.householdId, householdId),
          inArray(householdMealOutcomes.weekStartDate, priorWeekStartDates),
        ))
    ),
  ])

  const profile = profileRows[0] ?? null
  const selectedDayNames: z.infer<typeof dayOfWeek>[] = profile
    ? (profile.selectedDays as Array<{ day: string }>).map((d) => d.day as z.infer<typeof dayOfWeek>)
    : ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']
  const selectedDaysByName = new Map(
    profile
      ? (profile.selectedDays as Array<z.infer<typeof PlanningDaySelectionSchema>>).map((selection) => [selection.day, selection])
      : selectedDayNames.map((day) => [day, { day }]),
  )
  const avoidIngredients: string[] = profile ? (profile.avoidIngredients as string[]) : []

  const projState = readProjectionState(projection?.state)
  const daysToFill = orderedDays.filter((day) => {
    if (!selectedDayNames.includes(day)) return false
    if (addDays(weekStartDate, orderedDays.indexOf(day)) < today) return false
    if (projState.lockedDays.includes(day)) return false
    if (projState.skippedDays.includes(day)) return false
    return regenerate ? true : !projState.meals[day]
  })

  if (daysToFill.length === 0) return { ok: true, generated: false }
  if (poolRecipes.length === 0) return { error: 'NO_RECIPES' as const }

  const candidates: TScoringRecipe[] = (avoidIngredients.length > 0
    ? poolRecipes.filter((r) => !recipeMatchesAvoided(r, avoidIngredients))
    : poolRecipes
  ).map((r) => ({
    id: r.id,
    title: r.title,
    tags: readStringArray(r.tags),
    ingredients: readIngredientArray(r.ingredients),
    servings: r.servings,
    prepTimeMinutes: r.prepTimeMinutes,
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
  const householdSignals: THouseholdMealSignalState = Object.fromEntries(householdSignalRows.map((row) => [row.mealId, row.signal]))
  // Gap-filled over the full 6-week window, not just the weeks that happen
  // to have a projection row — `detectFatiguedMeals` walks this list
  // positionally (each entry = "the next week"), so a week the household
  // never opened must appear as an empty week, not be silently skipped
  // (which would make the two weeks on either side of the gap look
  // adjacent and corrupt the streak/break detection).
  const priorWeeksByDate = new Map(
    priorWeekProjections.map((row) => [row.weekStartDate, Object.values(readProjectionState(row.state).meals).map((m) => m.recipeRef)]),
  )
  const resolvedHistory = resolveMealHistory(
    priorWeekStartDates.map((date) => ({ weekStartDate: date, mealIds: priorWeeksByDate.get(date) ?? [] })),
    outcomeRows,
  )
  const recentMealIds = extractRecentMealIds(resolvedHistory.scoringRecords, weekStartDate)
  const fatiguedMealIds = detectFatiguedMeals(resolvedHistory.scoringRecords)
  const confirmedFatiguedMealIds = detectConfirmedFatiguedMeals(priorWeekStartDates, resolvedHistory.confirmedRecords)
  const everCookedRecipeIds = recipeIdsFromRecords(resolvedHistory.confirmedRecords)
  const legacyPlannedRecipeIds = recipeIdsFromRecords(resolvedHistory.legacyPlannedRecords)

  // Only meals staying put (not in `daysToFill`) should inform exclusion/
  // variety scoring — on a regenerate, a day's current meal is about to be
  // discarded, so seeding from it would wrongly exclude that recipe from
  // being re-picked (even onto the day it's leaving) and pollute cuisine/
  // protein/hearty-adjacency scoring with data that won't exist in the
  // final week.
  const daysToFillSet = new Set(daysToFill)
  const keptMeals = Object.entries(projState.meals)
    .filter(([day]) => !daysToFillSet.has(day as z.infer<typeof dayOfWeek>))
    .map(([, meal]) => meal)

  const alreadyUsed = new Set(keptMeals.map((m) => m.recipeRef))
  const weekCtx = createWeekContext()
  // Seed week-context with this week's already-placed (locked/existing)
  // meals so cuisine/protein-variety and hearty-adjacency scoring account
  // for the whole week, not just the days being filled right now.
  for (const meal of keptMeals) {
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
    const date = addDays(weekStartDate, orderedDays.indexOf(day))
    const weekOverride = projState.contextOverrides?.[date]
    const selection = mergeDayPlanningContext(selectedDaysByName.get(day), weekOverride)
    const ranked = rankCandidates(scoringPool, { householdId, feedback, householdSignals, allRecipes: candidates, weekCtx, selection, recentMealIds, fatiguedMealIds })
    const next = ranked[0]
    if (!next) continue

    // Evaluated against `weekCtx` as it stood *before* this pick — same
    // order as the web engine (evaluateConfidence, then updateWeekContext).
    const reason = deriveAssignmentReason(next, {
      householdId,
      feedback,
      allRecipes: candidates,
      selection,
      fatiguedMealIds: confirmedFatiguedMealIds,
      everCookedRecipeIds,
      legacyPlannedRecipeIds,
      selectionSource: weekOverride ? 'week-override' : 'household-default',
    })
    const confidence = evaluateAssignmentConfidence(next, weekCtx, selection)

    alreadyUsed.add(next.id)
    updateWeekContext(weekCtx, next)
    await appendStreamEvent(
      db, accessToken,
      { events: weekPlanEvents, projections: weekPlanProjections },
      { fold: foldEventIntoProjection, emptyState: emptyProjectionState },
      {
        householdId,
        weekStartDate,
        causedBy,
        payload: {
          eventType: 'meal_assigned',
          dayOfWeek: day,
          recipeRef: next.id,
          reason,
          confidence,
          servings: selection?.servingsOverride ?? next.servings,
        },
      },
    )
  }

  return { ok: true, generated: true }
}

export function buildWeekPlanRoutes(db: Db) {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()

  // Hono middleware doesn't cross OpenAPIHono sub-app boundaries — the
  // households module registers its own `requireAuth` on `/households/*`,
  // and so must this one (it doesn't inherit the registration when mounted
  // into the parent app via `.route('/', ...)`).
  app.use('/households/*', requireAuth)

  app.openapi(getWeekContextOverridesRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId, weekStartDate } = c.req.valid('param')
    if (!isMonday(weekStartDate)) return c.json({ error: 'INVALID_WEEK_START_DATE' } as never, 400)
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' }, 404)

    const overrides = await getWeekContextOverrides(db, accessToken, householdId, weekStartDate)
    return c.json({ overrides }, 200)
  })

  app.openapi(upsertWeekContextOverrideRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId, weekStartDate, date } = c.req.valid('param')
    if (!isMonday(weekStartDate) || !isDateInWeek(weekStartDate, date)) {
      return c.json({ error: 'INVALID_WEEK_CONTEXT_DATE' } as never, 400)
    }
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' }, 404)
    const override = c.req.valid('json')

    const saved = await upsertWeekContextOverride(db, accessToken, user.id, householdId, weekStartDate, date, override)
    return c.json(saved, 200)
  })

  app.openapi(clearWeekContextOverrideRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId, weekStartDate, date } = c.req.valid('param')
    if (!isMonday(weekStartDate) || !isDateInWeek(weekStartDate, date)) {
      return c.json({ error: 'INVALID_WEEK_CONTEXT_DATE' } as never, 400)
    }
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' }, 404)

    await clearWeekContextOverride(db, accessToken, user.id, householdId, weekStartDate, date)
    return c.json({ ok: true }, 200)
  })

  app.openapi(generateWeekPlanRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId, weekStartDate } = c.req.valid('param')
    const { regenerate } = c.req.valid('json')
    if (!isMonday(weekStartDate)) return c.json({ error: 'INVALID_WEEK_START_DATE' } as never, 400)
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' }, 404)
    const today = requestToday(c.req.header('X-Veckly-Today'))
    // Product date behavior follows the device-local header, but billing usage
    // must never trust a caller-controlled date.
    const usagePeriodStart = serverWeeklyUsagePeriodStart()
    const entitlement = await resolveEntitlementForHousehold(db, user.id, householdId)
    let reservation: Awaited<ReturnType<typeof reserveWeeklyGeneration>> & { persisted: boolean }
    try {
      reservation = { ...await reserveWeeklyGeneration(db, householdId, usagePeriodStart, regenerate), persisted: true }
    } catch (error) {
      if (entitlement.gatesEnabled) throw error
      console.error('[premium-gate] failed to persist weekly AI usage in shadow mode', error)
      reservation = { recorded: true, current: 0, limit: 1, persisted: false }
    }
    if (!reservation.recorded) {
      const gate = await observePremiumGate(db, entitlement, { householdId, userId: user.id, reason: 'week_generation_limit', usage: reservation })
      if (gate) return c.json(gate as never, 403)
    }
    let result: Awaited<ReturnType<typeof doGenerateWeekPlan>>
    try {
      result = await doGenerateWeekPlan(
        db,
        accessToken,
        user.id,
        householdId,
        weekStartDate,
        regenerate,
        today,
      )
    } catch (error) {
      if (reservation.recorded && reservation.persisted) await releaseWeeklyGenerationBestEffort(db, householdId, usagePeriodStart, regenerate)
      throw error
    }
    if (reservation.recorded && reservation.persisted && ('error' in result || !result.generated)) {
      await releaseWeeklyGenerationBestEffort(db, householdId, usagePeriodStart, regenerate)
    }
    if ('error' in result && result.error === 'NOT_MEMBER') return c.json({ error: 'NOT_MEMBER' }, 404)
    if ('error' in result) return c.json(result, 422)
    return c.json({ ok: true }, 200)
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
    if (
      (payload.eventType === 'week_context_override_upserted' || payload.eventType === 'week_context_override_cleared')
      && !isDateInWeek(weekStartDate, payload.date)
    ) {
      return c.json({ error: 'INVALID_WEEK_CONTEXT_DATE' } as never, 400)
    }

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

  app.openapi(previewWeekRescueRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId, weekStartDate } = c.req.valid('param')
    const request = c.req.valid('json')
    if (!isMonday(weekStartDate) || !isDateInWeek(weekStartDate, request.date)) return c.json({ error: 'NO_PLAN' }, 422)
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' } as never, 404)
    const result = await previewWeekRescue(db, accessToken, householdId, weekStartDate, request)
    if ('error' in result) return c.json(result, result.error === 'STALE_WEEK_PLAN' ? 409 : 422)
    return c.json(result, 200)
  })

  app.openapi(applyWeekRescueRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId, weekStartDate } = c.req.valid('param')
    const request = c.req.valid('json')
    if (!isMonday(weekStartDate) || !isDateInWeek(weekStartDate, request.date)) return c.json({ error: 'NO_PLAN' }, 422)
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' } as never, 404)
    const result = await applyWeekRescue(db, accessToken, user.id, householdId, weekStartDate, request)
    if ('error' in result) return c.json(result, result.error === 'STALE_WEEK_PLAN' ? 409 : 422)
    return c.json(result, 200)
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
    // Four most recent calendar weeks remain free. Shadow only for now.
    const now = new Date()
    const mondayOffset = (now.getUTCDay() + 6) % 7
    const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - mondayOffset - 21)).toISOString().slice(0, 10)
    if (plans.some((plan) => plan.weekStartDate < cutoff)) {
      const entitlement = await resolveEntitlementForHousehold(db, user.id, householdId)
      const gate = await observePremiumGate(db, entitlement, { householdId, userId: user.id, reason: 'week_history' })
      if (gate) return c.json(gate as never, 403)
    }
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
