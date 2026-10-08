import type { z } from 'zod'
import type { TWeekContextOverride } from '../../planning-context.js'
import { isDateInWeek, orderedDays } from '../../shared/week-dates.js'
import type {
  AssignmentConfidenceSchema,
  AssignmentReasonSchema,
  dayOfWeek,
  PlanningRequestSchema,
  WeekPlanEventPayloadSchema,
} from './schemas.js'

// --- Projection fold --------------------------------------------------------
//
// The minimal shape needed to prove `meal_assigned` folds correctly. Explicitly
// provisional — the design doc itself flags the projection shape as an open
// implementation-time question; freezing it now, before the other ~13 event
// types are scoped, would be premature.
export type TWeekPlanProjectionState = {
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

export const emptyProjectionState = (): TWeekPlanProjectionState => ({
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

export function foldEventIntoProjection(
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
    case 'previous_week_reused': {
      const meals: TWeekPlanProjectionState['meals'] = { ...state.meals }
      let skippedDays = [...state.skippedDays]
      for (const day of payload.days) {
        meals[day.dayOfWeek] = { recipeRef: day.recipeRef, servings: day.servings }
        skippedDays = toggleSortedDay(skippedDays, day.dayOfWeek, false)
      }
      return { ...state, weekStarted: true, meals, skippedDays }
    }
    case 'week_plan_cleared':
      return emptyProjectionState()
  }
}

export function readProjectionState(state: unknown): TWeekPlanProjectionState {
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

export function contextOverrideItems(state: TWeekPlanProjectionState, weekStartDate: string) {
  return Object.entries(state.contextOverrides ?? {})
    .filter(([date]) => isDateInWeek(weekStartDate, date))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, override]) => ({ date, ...override }))
}

export function readPantryStock(state: unknown): Record<string, number> {
  const candidate = state as { pantryStock?: unknown } | null | undefined
  if (!candidate?.pantryStock || typeof candidate.pantryStock !== 'object') return {}
  return Object.fromEntries(Object.entries(candidate.pantryStock as Record<string, unknown>)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] > 0))
}
