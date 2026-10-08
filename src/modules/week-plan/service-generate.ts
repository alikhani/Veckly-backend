import { releaseWeeklyGenerationBestEffort, reserveWeeklyGeneration, serverWeeklyUsagePeriodStart } from '../../ai-usage.js'
import type { z } from 'zod'
import { resolveEntitlementForHousehold } from '../../entitlements.js'
import { pantryCoversIngredient } from '../../ingredient-identity.js'
import { detectConfirmedFatiguedMeals, recipeIdsFromRecords, resolveMealHistory } from '../../meal-history.js'
import { assertMembership } from '../../membership.js'
import { mergeDayPlanningContext } from '../../planning-context.js'
import type { RequestContext } from '../../platform/http-errors.js'
import { observePremiumGate } from '../../premium-gates.js'
import { readIngredientArray, readStringArray, recipeMatchesAvoided } from '../../shared/recipe-matching.js'
import { addDays, defaultTodayForWeek, orderedDays } from '../../shared/week-dates.js'
import {
  createWeekContext,
  deriveAssignmentReason,
  detectFatiguedMeals,
  evaluateAssignmentConfidence,
  extractRecentMealIds,
  rankCandidates,
  recipeMatchesWish,
  updateWeekContext,
  type TFeedbackState,
  type THouseholdMealSignalState,
  type TScoringRecipe,
} from '../../week-scoring.js'
import { readPantryStock, readProjectionState } from './projection.js'
import { appendWeekPlanEvent, loadGenerationInputs } from './repository.js'
import type { dayOfWeek, PlanningDaySelectionSchema } from './schemas.js'

export async function doGenerateWeekPlan(
  ctx: RequestContext,
  weekStartDate: string,
  regenerate: boolean,
  today = defaultTodayForWeek(weekStartDate),
  pantryItemKeys: string[] = [],
): Promise<{ ok: true; generated: boolean } | { error: 'NO_RECIPES' } | { error: 'ALL_RECIPES_EXCLUDED' } | { error: 'NOT_MEMBER' }> {
  const { db, accessToken, userId, householdId } = ctx
  const member = await assertMembership(db, accessToken, householdId, userId)
  if (!member) return { error: 'NOT_MEMBER' as const }

  // Up to 6 prior Monday-start weeks — feeds both recency (last 1-2 weeks)
  // and fatigue detection (needs ≥4 weeks of history; see week-scoring.ts).
  const priorWeekStartDates = Array.from({ length: 6 }, (_, i) => addDays(weekStartDate, -7 * (i + 1)))

  const [profileRows, projection, poolRecipes, feedbackRows, householdSignalRows, priorWeekProjections, outcomeRows, shoppingRows, prepAssignmentRows, pulseMemberRows] = await loadGenerationInputs(
    ctx,
    weekStartDate,
    priorWeekStartDates,
  )

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
  const respondedPulseRows = pulseMemberRows.filter((row) => row.updatedAt !== null)
  const memberCount = pulseMemberRows.length
  const unanimousAwayDates = new Set(orderedDays.map((_, index) => addDays(weekStartDate, index)).filter((date) =>
    memberCount > 0
      && respondedPulseRows.length === memberCount
      && respondedPulseRows.every((row) => Array.isArray(row.awayDates) && row.awayDates.includes(date)),
  ))
  const simpleDates = new Set(respondedPulseRows.map((row) => row.simpleDate).filter((date): date is string => Boolean(date)))
  const remainingWishedMeals = respondedPulseRows.map((row) => row.wishedMeal).filter((wish): wish is string => Boolean(wish))

  const projState = readProjectionState(projection?.state)
  const daysToFill = orderedDays.filter((day) => {
    if (!selectedDayNames.includes(day)) return false
    if (addDays(weekStartDate, orderedDays.indexOf(day)) < today) return false
    if (unanimousAwayDates.has(addDays(weekStartDate, orderedDays.indexOf(day)))) return false
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
  const pantryStock = readPantryStock(shoppingRows[0]?.state)
  const pantryFocusKeys = new Set(pantryItemKeys)
  const focusedPantryStock = Object.fromEntries(
    Object.entries(pantryStock).filter(([key, quantity]) => pantryFocusKeys.has(key) && quantity > 0),
  )
  const hasPantryFocus = Object.keys(focusedPantryStock).length > 0
  const weekCtx = createWeekContext(hasPantryFocus ? focusedPantryStock : pantryStock, hasPantryFocus ? 4 : 0.75)
  const prepRecipeIdsByDate = new Map<string, Set<string>>()
  for (const row of prepAssignmentRows) {
    if (!row.recipeId) continue
    const ids = prepRecipeIdsByDate.get(row.date) ?? new Set<string>()
    ids.add(row.recipeId)
    prepRecipeIdsByDate.set(row.date, ids)
  }
  // Seed week-context with this week's already-placed (locked/existing)
  // meals so cuisine/protein-variety and hearty-adjacency scoring account
  // for the whole week, not just the days being filled right now.
  for (const meal of keptMeals) {
    const placed = candidates.find((c) => c.id === meal.recipeRef)
    if (placed) updateWeekContext(weekCtx, placed)
  }

  const causedBy = { source: 'algorithm' as const, algorithmVersion: '2.0', triggeredByUserId: userId }

  if (!projState.weekStarted) {
    await appendWeekPlanEvent(ctx,
      { weekStartDate, causedBy, payload: { eventType: 'week_started' } },
    )
  }

  for (const date of unanimousAwayDates) {
    const day = orderedDays[(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7]
    if (!day) continue
    if (!selectedDayNames.includes(day) || projState.skippedDays.includes(day) || projState.lockedDays.includes(day) || projState.meals[day]) continue
    await appendWeekPlanEvent(ctx,
      { weekStartDate, causedBy, payload: { eventType: 'day_skipped', dayOfWeek: day } },
    )
  }

  for (const day of daysToFill) {
    const unused = candidates.filter((c) => !alreadyUsed.has(c.id))
    const scoringPool = unused.length > 0 ? unused : candidates
    const date = addDays(weekStartDate, orderedDays.indexOf(day))
    const weekOverride = projState.contextOverrides?.[date]
    const baseSelection = mergeDayPlanningContext(selectedDaysByName.get(day), weekOverride)
    const selection = simpleDates.has(date) ? { ...baseSelection, effortLevel: 'busy' as const } : baseSelection
    const ranked = rankCandidates(scoringPool, {
      householdId, feedback, householdSignals, allRecipes: candidates, weekCtx, selection,
      recentMealIds, fatiguedMealIds, preferredPrepRecipeIds: prepRecipeIdsByDate.get(date), wishedMeals: remainingWishedMeals,
    })
    const next = ranked[0]
    if (!next) continue

    // Evaluated against `weekCtx` as it stood *before* this pick — same
    // order as the web engine (evaluateConfidence, then updateWeekContext).
    const baseReason = deriveAssignmentReason(next, {
      householdId,
      feedback,
      allRecipes: candidates,
      selection,
      fatiguedMealIds: confirmedFatiguedMealIds,
      everCookedRecipeIds,
      legacyPlannedRecipeIds,
      selectionSource: weekOverride ? 'week-override' : 'household-default',
    })
    const reason = hasPantryFocus && readIngredientArray(next.ingredients).some((ingredient) => pantryCoversIngredient(ingredient, focusedPantryStock))
      ? 'pantry-coverage' as const
      : baseReason
    const confidence = evaluateAssignmentConfidence(next, weekCtx, selection)

    alreadyUsed.add(next.id)
    for (let index = remainingWishedMeals.length - 1; index >= 0; index -= 1) {
      const wishedMeal = remainingWishedMeals[index]
      if (wishedMeal && recipeMatchesWish(next.title, wishedMeal)) remainingWishedMeals.splice(index, 1)
    }
    updateWeekContext(weekCtx, next)
    await appendWeekPlanEvent(ctx,
      {
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

// Generation as one use case: quota reservation, the shadow-mode fallback,
// the premium gate, and releasing the reservation when nothing was generated.
// The handler only translates the result into a status code.
export async function generateWeek(
  ctx: RequestContext,
  weekStartDate: string,
  input: { regenerate: boolean; today: string; pantryItemKeys: string[] },
) {
  const { db, userId, householdId } = ctx
  const { regenerate, today, pantryItemKeys } = input
  // Product date behavior follows the device-local header, but billing usage
  // must never trust a caller-controlled date.
  const usagePeriodStart = serverWeeklyUsagePeriodStart()
  const entitlement = await resolveEntitlementForHousehold(db, userId, householdId)
  let reservation: Awaited<ReturnType<typeof reserveWeeklyGeneration>> & { persisted: boolean }
  try {
    reservation = { ...await reserveWeeklyGeneration(db, householdId, usagePeriodStart, regenerate), persisted: true }
  } catch (error) {
    if (entitlement.gatesEnabled) throw error
    console.error('[premium-gate] failed to persist weekly AI usage in shadow mode', error)
    reservation = { recorded: true, current: 0, limit: 1, persisted: false }
  }
  if (!reservation.recorded) {
    const gate = await observePremiumGate(db, entitlement, { householdId, userId, reason: 'week_generation_limit', usage: reservation })
    if (gate) return { gate }
  }
  let result: Awaited<ReturnType<typeof doGenerateWeekPlan>>
  try {
    result = await doGenerateWeekPlan(
      ctx,
      weekStartDate,
      regenerate,
      today,
      [...new Set(pantryItemKeys)],
    )
  } catch (error) {
    if (reservation.recorded && reservation.persisted) await releaseWeeklyGenerationBestEffort(db, householdId, usagePeriodStart, regenerate)
    throw error
  }
  if (reservation.recorded && reservation.persisted && ('error' in result || !result.generated)) {
    await releaseWeeklyGenerationBestEffort(db, householdId, usagePeriodStart, regenerate)
  }
  if ('error' in result) return result
  return { ok: true as const }
}
