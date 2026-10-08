import { z } from '@hono/zod-openapi'
import type { ErrorCode } from '../../platform/http-errors.js'
import { PortionSuggestionSchema } from '../../portion-memory.js'
import {
  DayPlanningContextSchema,
  HouseholdDaySelectionSchema,
  WeekContextOverrideSchema,
  WeekdaySchema,
} from '../../planning-context.js'

// --- Wire shapes -----------------------------------------------------------
//
// Flat envelope — `{ causedBy, eventType, ...fields }` — matching the design
// doc's `TWeekPlanEvent = {...} & TWeekPlanEventPayload` intersection (not a
// nested `payload` object). `eventType` doubles as the discriminant for both
// the Zod union (HTTP boundary validation) and the `event_type` column
// (queryable without reaching into JSONB).

export const CausedBySchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('user'), userId: z.string().uuid() }),
  z.object({ source: z.literal('algorithm'), algorithmVersion: z.string(), triggeredByUserId: z.string().uuid() }),
  z.object({ source: z.literal('system'), reason: z.string() }),
]).openapi('CausedBy')

export const dayOfWeek = WeekdaySchema
export const WeekPlanEventTypeSchema = z.enum([
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
  'previous_week_reused',
  'week_plan_cleared',
])

const PrioritySchema = z.enum(['quick', 'budget', 'child-friendly', 'meal-prep', 'varied'])
export const PlanningDaySelectionSchema = HouseholdDaySelectionSchema
export const PlanningRequestSchema = z.object({
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
export const WeekHistoryStateSchema = z.object({
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
export const AssignmentReasonSchema = z.enum(['family-recipe', 'liked-before', 'back-after-break', 'based-on-feedback', 'new-for-variety', 'quick-weekday', 'week-override', 'pantry-coverage'])
export const AssignmentConfidenceSchema = z.enum(['ok', 'low'])

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

export const WeekRescuedPayloadSchema = z.object({
  eventType: z.literal('week_rescued'),
  rescueId: z.string().uuid(),
  rescueReason: RescueIntentSchema,
  changes: z.array(RescueChangeSchema).min(1),
  shoppingDiff: z.object({ added: z.array(z.string()), removed: z.array(z.string()) }),
})

export const PreviousWeekReuseReasonSchema = z.enum([
  'worked-last-week',
  'not-cooked',
  'family-veto',
  'disliked',
  'fatigued',
  'changed-plan-often',
  'week-context',
  'fills-selected-day',
]).openapi('PreviousWeekReuseReason')

export const PreviousWeekProposalDaySchema = z.object({
  dayOfWeek,
  date: z.string(),
  action: z.enum(['kept', 'replaced', 'added']),
  reason: PreviousWeekReuseReasonSchema,
  previousRecipeRef: z.string().uuid().nullable(),
  previousRecipeTitle: z.string().nullable(),
  recipeRef: z.string().uuid(),
  recipeTitle: z.string(),
  servings: z.number().int().min(1),
}).openapi('PreviousWeekProposalDay')

export const PreviousWeekReusedPayloadSchema = z.object({
  eventType: z.literal('previous_week_reused'),
  proposalId: z.string().uuid(),
  sourceWeekStartDate: z.string(),
  days: z.array(PreviousWeekProposalDaySchema).min(1),
})

const WeekPlanClearedPayloadSchema = z.object({
  eventType: z.literal('week_plan_cleared'),
})

export const WeekPlanEventPayloadSchema = z.discriminatedUnion('eventType', [
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
  PreviousWeekReusedPayloadSchema,
  WeekPlanClearedPayloadSchema,
])

export const AppendWeekPlanEventRequestSchema = z.object({
  causedBy: CausedBySchema,
}).and(WeekPlanEventPayloadSchema).openapi('AppendWeekPlanEventRequest')

export const WeekPlanEventSchema = z.object({
  id: z.string().uuid(),
  householdId: z.string().uuid(),
  weekStartDate: z.string(),
  sequenceNumber: z.number().int(),
  occurredAt: z.string(),
  causedBy: CausedBySchema,
  eventType: WeekPlanEventTypeSchema,
  payload: z.record(z.string(), z.unknown()),
}).openapi('WeekPlanEvent')

export const WeekPlanProjectionSchema = z.object({
  householdId: z.string().uuid(),
  weekStartDate: z.string(),
  state: z.record(z.string(), z.unknown()),
  updatedAt: z.string(),
}).openapi('WeekPlanProjection')

export const ParamsSchema = z.object({
  householdId: z.string().uuid(),
  weekStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'),
})
export const ContextOverrideParamsSchema = ParamsSchema.extend({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'),
})
export const HouseholdParamsSchema = z.object({ householdId: z.string().uuid() })
export const WeekHistoryQuerySchema = z.object({
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
  portionSuggestion: PortionSuggestionSchema.nullable(),
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
  z.object({
    kind: z.literal('pantry-coverage'),
    ingredients: z.array(z.string()).min(1).max(5),
  }),
]).openapi('WeekPlanExplanation')

export const WeekPlanSummarySchema = z.object({
  household: z.object({ id: z.string().uuid(), name: z.string() }),
  weekStartDate: z.string(),
  updatedAt: z.string().nullable(),
  explanations: z.array(WeekPlanExplanationSchema).max(2),
  economy: z.object({
    uniqueIngredientCount: z.number().int().min(0),
    uniquePurchaseCount: z.number().int().min(0),
    pantryCoveredIngredientCount: z.number().int().min(0),
    reusedIngredientCount: z.number().int().min(0),
  }),
  pulse: z.object({
    responseCount: z.number().int().min(0),
    memberCount: z.number().int().min(1),
    wishes: z.array(z.object({
      userId: z.string().uuid(),
      givenName: z.string().nullable(),
      wishedMeal: z.string(),
      status: z.enum(['fulfilled', 'unavailable', 'not-selected']),
    })),
  }),
  days: z.array(WeekPlanSummaryDaySchema),
}).openapi('WeekPlanSummary')

export const WeekRescueRequestSchema = z.object({
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

export const WeekRescuePreviewSchema = z.object({
  rescueId: z.string().uuid(),
  intent: RescueIntentSchema,
  reason: z.enum(['faster', 'less-effort', 'avoids-ingredient', 'more-portions', 'swaps-days']),
  primaryChange: RescueChangeSchema,
  followUpChanges: z.array(RescueChangeSchema),
  shoppingDiff: z.object({ added: z.array(z.string()), removed: z.array(z.string()) }),
  expectedUpdatedAt: z.string().nullable(),
}).openapi('WeekRescuePreview')

export const WeekRescueApplyResponseSchema = z.object({
  ok: z.literal(true),
  alreadyApplied: z.boolean(),
  preview: WeekRescuePreviewSchema,
}).openapi('WeekRescueApplyResponse')

export const WeekRescueErrorSchema = z.object({
  error: z.enum(['NO_PLAN', 'LOCKED_DAY', 'NO_RESCUE_FOUND', 'STALE_WEEK_PLAN'] as const satisfies readonly ErrorCode[]),
}).openapi('WeekRescueError')

export const PreviousWeekProposalRequestSchema = z.object({
  proposalId: z.string().uuid(),
  expectedUpdatedAt: z.string().nullable(),
}).openapi('PreviousWeekProposalRequest')

export const PreviousWeekProposalSchema = z.object({
  proposalId: z.string().uuid(),
  sourceWeekStartDate: z.string(),
  expectedUpdatedAt: z.string().nullable(),
  keptCount: z.number().int().min(0),
  changedCount: z.number().int().min(0),
  days: z.array(PreviousWeekProposalDaySchema),
}).openapi('PreviousWeekProposal')

export const PreviousWeekProposalApplyResponseSchema = z.object({
  ok: z.literal(true),
  alreadyApplied: z.boolean(),
  proposal: PreviousWeekProposalSchema,
}).openapi('PreviousWeekProposalApplyResponse')

export const PreviousWeekProposalErrorSchema = z.object({
  error: z.enum(['NO_COMPLETED_WEEK', 'NO_RECIPES', 'ALL_RECIPES_EXCLUDED', 'STALE_WEEK_PLAN'] as const satisfies readonly ErrorCode[]),
}).openapi('PreviousWeekProposalError')

export const WeekContextOverrideItemSchema = DayPlanningContextSchema.extend({
  date: z.string(),
}).openapi('WeekContextOverride')

export const WeekContextOverridesResponseSchema = z.object({
  overrides: z.array(WeekContextOverrideItemSchema),
}).openapi('WeekContextOverridesResponse')

export const ClearWeekContextOverrideResponseSchema = z.object({
  ok: z.literal(true),
}).openapi('ClearWeekContextOverrideResponse')

export const WeekHistoryPlanSchema = z.object({
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

export const WeekHistoryListItemSchema = z.object({
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

export const WeekHistoryDetailSchema = z.object({
  week: WeekHistoryPlanSchema.nullable(),
}).openapi('WeekHistoryDetail')

export const UpsertWeekHistoryPlanSchema = z.object({
  expectedUpdatedAt: z.string().nullable().optional(),
  timezone: z.string().min(1),
  state: WeekHistoryStateSchema,
  status: WeekHistoryStatusSchema.default('draft'),
  source: WeekHistorySourceSchema.default('manual'),
}).openapi('UpsertWeekHistoryPlan')

export const UpsertWeekHistoryPlanResponseSchema = z.object({
  ok: z.literal(true),
  weekStartDate: z.string(),
  weekNumber: z.number().int(),
  weekYear: z.number().int(),
  updatedAt: z.string(),
}).openapi('UpsertWeekHistoryPlanResponse')

export const FinalizeWeekHistoryPlanResponseSchema = z.object({
  ok: z.literal(true),
  weekStartDate: z.string(),
  status: z.literal('finalized'),
  updatedAt: z.string().nullable(),
}).openapi('FinalizeWeekHistoryPlanResponse')

export const StaleWeekHistoryPlanResponseSchema = z.object({
  error: z.literal('STALE_WEEK_PLAN_STATE' satisfies ErrorCode),
  updatedAt: z.string().nullable(),
}).openapi('StaleWeekHistoryPlanResponse')

export const GenerateWeekPlanRequestSchema = z.object({
  regenerate: z.boolean().default(false),
  pantryItemKeys: z.array(z.string().trim().min(1)).max(5).default([]),
}).openapi('GenerateWeekPlanRequest')

export const GenerateWeekPlanResponseSchema = z.object({
  ok: z.literal(true),
}).openapi('GenerateWeekPlanResponse')

export const GenerateWeekPlanErrorSchema = z.object({
  error: z.enum(['NO_RECIPES', 'ALL_RECIPES_EXCLUDED'] as const satisfies readonly ErrorCode[]),
}).openapi('GenerateWeekPlanError')

export type TWeekExplanation = z.infer<typeof WeekPlanExplanationSchema>
export type TWeekRescueRequest = z.infer<typeof WeekRescueRequestSchema>
export type TWeekRescuePreview = z.infer<typeof WeekRescuePreviewSchema>
export type TPreviousWeekProposalRequest = z.infer<typeof PreviousWeekProposalRequestSchema>
export type TPreviousWeekProposal = z.infer<typeof PreviousWeekProposalSchema>
