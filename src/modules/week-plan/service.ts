import type { z } from 'zod'
import { resolveEntitlementForHousehold } from '../../entitlements.js'
import { StaleProjectionError } from '../../event-stream.js'
import { readRecipeIngredients } from '../../ingredient-categories.js'
import { detectConfirmedFatiguedMeals, resolveMealHistory } from '../../meal-history.js'
import { upsertMealOutcome } from '../../meal-outcomes.js'
import { mergeDayPlanningContext, type TWeekContextOverride } from '../../planning-context.js'
import type { HouseholdScope, RequestContext } from '../../platform/http-errors.js'
import { derivePortionSuggestion } from '../../portion-memory.js'
import { observePremiumGate } from '../../premium-gates.js'
import { readIngredientArray, readStringArray, recipeMatchesAvoided } from '../../shared/recipe-matching.js'
import { addDays, orderedDays } from '../../shared/week-dates.js'
import {
  computeCurrentStreak,
  createWeekContext,
  evaluateWeekEconomy,
  extractRecentMealIds,
  rankCandidates,
  recipeMatchesWish,
  scoreMeal,
  updateWeekContext,
  type TFeedbackState,
  type THouseholdMealSignalState,
  type TScoringRecipe,
} from '../../week-scoring.js'
import { deriveWeekExplanations } from './explanations.js'
import { contextOverrideItems, readPantryStock, readProjectionState } from './projection.js'
import {
  appendWeekPlanEvent,
  finalizeWeekHistoryPlanRow,
  loadPreviousWeekInputs,
  loadWeekRescueInputs,
  loadWeekSummaryRows,
  selectPreviousWeekReusedPayloads,
  selectWeekHistoryPlan,
  selectWeekHistoryPlans,
  selectWeekPlanEventPayloads,
  selectWeekPlanProjection,
  type TUpsertWeekHistoryPlanResult,
  upsertWeekHistoryPlanRow,
} from './repository.js'
import { deriveWeekRescuePreview } from './rescue.js'
import type {
  CausedBySchema,
  PlanningDaySelectionSchema,
  PreviousWeekProposalDaySchema,
  PreviousWeekReusedPayloadSchema,
  PreviousWeekReuseReasonSchema,
  TPreviousWeekProposal,
  TPreviousWeekProposalRequest,
  TWeekRescueRequest,
  UpsertWeekHistoryPlanSchema,
  WeekPlanEventPayloadSchema,
  WeekRescuedPayloadSchema,
} from './schemas.js'

const SATIATION_STREAK_THRESHOLD = 3

function streakWeeksOrNull(streak: number): number | null {
  return streak >= SATIATION_STREAK_THRESHOLD ? streak : null
}

export async function getWeekContextOverrides(ctx: HouseholdScope, weekStartDate: string) {
  const projection = await selectWeekPlanProjection(ctx, weekStartDate)
  return contextOverrideItems(readProjectionState(projection?.state), weekStartDate)
}

export async function upsertWeekContextOverride(
  ctx: RequestContext,
  weekStartDate: string,
  date: string,
  override: TWeekContextOverride,
) {
  await appendWeekPlanEvent(ctx,
    {
      weekStartDate,
      causedBy: { source: 'user', userId: ctx.userId },
      payload: { eventType: 'week_context_override_upserted', date, override },
    },
  )
  return { date, ...override }
}

export async function clearWeekContextOverride(
  ctx: RequestContext,
  weekStartDate: string,
  date: string,
) {
  await appendWeekPlanEvent(ctx,
    {
      weekStartDate,
      causedBy: { source: 'user', userId: ctx.userId },
      payload: { eventType: 'week_context_override_cleared', date },
    },
  )
}

export async function listWeekHistoryPlans(ctx: HouseholdScope, range: { from?: string; to?: string }) {
  return selectWeekHistoryPlans(ctx, range)
}

export async function getWeekHistoryPlan(ctx: HouseholdScope, weekStartDate: string) {
  return selectWeekHistoryPlan(ctx, weekStartDate)
}

export async function upsertWeekHistoryPlan(
  ctx: RequestContext,
  weekStartDate: string,
  input: z.infer<typeof UpsertWeekHistoryPlanSchema>,
): Promise<TUpsertWeekHistoryPlanResult> {
  return upsertWeekHistoryPlanRow(ctx, weekStartDate, input)
}

export async function finalizeWeekHistoryPlan(ctx: RequestContext, weekStartDate: string) {
  return finalizeWeekHistoryPlanRow(ctx, weekStartDate)
}

export async function previewWeekRescue(ctx: HouseholdScope, weekStartDate: string, request: TWeekRescueRequest) {
  const inputs = await loadWeekRescueInputs(ctx, weekStartDate, request.date)
  if (!inputs) return { error: 'NO_PLAN' as const }
  const { projection, projectionState, profile, prepBatches, recipeRows, assignments } = inputs
  const assignedBatchIds = new Set(assignments.map((assignment) => assignment.batchId))
  const preferredLeftoverRecipeIds = new Set(prepBatches
    .filter((batch) => assignedBatchIds.has(batch.id) && batch.recipeId)
    .map((batch) => batch.recipeId!))
  return deriveWeekRescuePreview({
    request,
    weekStartDate,
    updatedAt: projection.updatedAt.toISOString(),
    projection: projectionState,
    recipes: recipeRows,
    avoidIngredients: (profile?.avoidIngredients as string[] | undefined) ?? [],
    preferredLeftoverRecipeIds,
  })
}

// Idempotent applies race: two requests with the same id both pass the
// existing-event lookup, and the loser's append hits a unique violation — or,
// once the winner has moved the projection, the append's stale precondition.
// Re-running once lets that lookup find the winner's event and answer
// `alreadyApplied`; a genuinely different concurrent edit makes the re-run's
// preview answer STALE_WEEK_PLAN. One retry only — a conflict from any other
// cause must surface, not loop.
async function retryOnceOnWriteConflict<T>(apply: () => Promise<T>): Promise<T | { error: 'STALE_WEEK_PLAN' }> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await apply()
    } catch (error) {
      const stale = error instanceof StaleProjectionError
      if (!stale && (error as { code?: string }).code !== '23505') throw error
      if (attempt === 2) {
        if (stale) return { error: 'STALE_WEEK_PLAN' }
        throw error
      }
    }
  }
}

export function applyWeekRescue(ctx: RequestContext, weekStartDate: string, request: TWeekRescueRequest) {
  return retryOnceOnWriteConflict(() => applyWeekRescueOnce(ctx, weekStartDate, request))
}

async function applyWeekRescueOnce(ctx: RequestContext, weekStartDate: string, request: TWeekRescueRequest) {
  const { db, accessToken, userId, householdId } = ctx
  const existing = await selectWeekPlanEventPayloads(ctx, weekStartDate)
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

  const preview = await previewWeekRescue(ctx, weekStartDate, request)
  if ('error' in preview) return preview
  await appendWeekPlanEvent(ctx,
    { weekStartDate, causedBy: { source: 'user', userId }, payload: {
      eventType: 'week_rescued', rescueId: request.rescueId, rescueReason: request.intent,
      changes: [preview.primaryChange, ...preview.followUpChanges],
      shoppingDiff: preview.shoppingDiff,
    }, expectedUpdatedAt: preview.expectedUpdatedAt },
  )
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

export async function getWeekPlanSummary(ctx: HouseholdScope, weekStartDate: string) {
  // 4 prior weeks is enough to surface a streak (threshold 3) without an
  // unbounded query — see `computeCurrentStreak` in week-scoring.ts.
  const priorWeekStartDates = Array.from({ length: 4 }, (_, i) => addDays(weekStartDate, -7 * (i + 1)))
  const rows = await loadWeekSummaryRows(ctx, weekStartDate, priorWeekStartDates)
  if (!rows) return null
  const {
    household,
    projection,
    priorWeekProjections,
    outcomeRows,
    shoppingProjection,
    pulseMembers,
    projectionState,
    recipeIds,
    recipeRows,
    portionOutcomeRows,
    portionMemoryRows,
    accessibleRecipeTitles,
    prepBatches,
    prepAssignments,
  } = rows

  const allWeekStartDates = [weekStartDate, ...priorWeekStartDates]

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

  const recipesById = new Map(recipeRows.map((recipe) => [recipe.id, recipe]))
  const portionOutcomesByRecipe = new Map<string, typeof portionOutcomeRows>()
  for (const outcome of portionOutcomeRows) {
    portionOutcomesByRecipe.set(outcome.plannedRecipeId, [...(portionOutcomesByRecipe.get(outcome.plannedRecipeId) ?? []), outcome])
  }
  const ignoredThroughByRecipe = new Map(portionMemoryRows.map((row) => [row.recipeId, row.ignoredThrough]))
  const plannedRecipeTitles = recipeRows.map((recipe) => recipe.title)
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
      portionSuggestion: recipe ? derivePortionSuggestion(
        portionOutcomesByRecipe.get(recipe.id) ?? [],
        meal?.servings ?? recipe.servings,
        ignoredThroughByRecipe.get(recipe.id),
      ) : null,
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
  const pantryStock = readPantryStock(shoppingProjection?.state)

  return {
    household,
    weekStartDate,
    updatedAt: projection?.updatedAt.toISOString() ?? null,
    economy: evaluateWeekEconomy(
      recipeIds.map((id) => recipesById.get(id)).filter((recipe): recipe is NonNullable<typeof recipe> => Boolean(recipe)).map((recipe) => ({
        id: recipe.id,
        title: recipe.title,
        servings: recipe.servings,
        prepTimeMinutes: recipe.prepTimeMinutes,
        tags: readStringArray(recipe.tags),
        ingredients: readIngredientArray(recipe.ingredients),
        cuisine: null,
        proteinSource: null,
        mealWeight: null,
        householdId: null,
      })),
      pantryStock,
    ),
    pulse: {
      responseCount: pulseMembers.filter((member) => member.respondedAt !== null).length,
      memberCount: pulseMembers.length,
      wishes: pulseMembers.flatMap((member) => {
        if (!member.wishedMeal) return []
        const fulfilled = plannedRecipeTitles.some((title) => recipeMatchesWish(title, member.wishedMeal!))
        const available = accessibleRecipeTitles.some((recipe) => recipeMatchesWish(recipe.title, member.wishedMeal!))
        return [{
          userId: member.userId,
          givenName: member.givenName,
          wishedMeal: member.wishedMeal,
          status: fulfilled ? 'fulfilled' as const : available ? 'not-selected' as const : 'unavailable' as const,
        }]
      }),
    },
    explanations: deriveWeekExplanations({
      days,
      recipeIngredients: new Map(recipeRows.map((recipe) => [recipe.id, readRecipeIngredients(recipe.ingredients)])),
      prepLinks: prepBatches.map((batch) => ({
        recipeId: batch.recipeId,
        recipeTitle: batch.recipeId ? recipesById.get(batch.recipeId)?.title ?? null : null,
        cookDate: batch.cookDate,
        coveredDates: assignmentsByBatch.get(batch.id) ?? [],
      })),
      pantryStock,
    }),
    days,
  }
}

export async function previewPreviousWeekProposal(
  ctx: RequestContext,
  weekStartDate: string,
  request: TPreviousWeekProposalRequest,
): Promise<TPreviousWeekProposal | { error: 'NO_COMPLETED_WEEK' | 'NO_RECIPES' | 'ALL_RECIPES_EXCLUDED' | 'STALE_WEEK_PLAN' }> {
  const { householdId } = ctx
  const priorWindowStart = addDays(weekStartDate, -42)
  const [profileRows, projection, poolRecipes, feedbackRows, signalRows, priorProjections, outcomes, shoppingRows, prepAssignmentRows] = await loadPreviousWeekInputs(
    ctx,
    weekStartDate,
    priorWindowStart,
  )

  if (request.expectedUpdatedAt !== (projection?.updatedAt.toISOString() ?? null)) return { error: 'STALE_WEEK_PLAN' }
  if (poolRecipes.length === 0) return { error: 'NO_RECIPES' }
  const completedWeek = [...new Set(outcomes.map((row) => row.weekStartDate))].sort().at(-1)
  if (!completedWeek) return { error: 'NO_COMPLETED_WEEK' }

  const profile = profileRows[0]
  const selections = (profile?.selectedDays as Array<z.infer<typeof PlanningDaySelectionSchema>> | undefined)
    ?? orderedDays.slice(0, 5).map((day) => ({ day }))
  const selectedDays = new Map(selections.map((selection) => [selection.day, selection]))
  const avoidIngredients = (profile?.avoidIngredients as string[] | undefined) ?? []
  const candidates: TScoringRecipe[] = poolRecipes
    .filter((recipe) => !recipeMatchesAvoided(recipe, avoidIngredients))
    .map((recipe) => ({
      id: recipe.id, title: recipe.title, servings: recipe.servings, prepTimeMinutes: recipe.prepTimeMinutes,
      tags: readStringArray(recipe.tags), ingredients: readIngredientArray(recipe.ingredients), cuisine: recipe.cuisine,
      proteinSource: recipe.proteinSource, mealWeight: recipe.mealWeight, householdId: recipe.householdId,
    }))
  if (candidates.length === 0) return { error: 'ALL_RECIPES_EXCLUDED' }

  const recipesById = new Map(candidates.map((recipe) => [recipe.id, recipe]))
  const feedback: TFeedbackState = Object.fromEntries(feedbackRows.map((row) => [row.mealId, { vote: row.vote, ...(row.signal ? { signal: row.signal } : {}) }]))
  const householdSignals: THouseholdMealSignalState = Object.fromEntries(signalRows.map((row) => [row.mealId, row.signal]))
  const priorDates = Array.from({ length: 6 }, (_, index) => addDays(weekStartDate, -7 * (index + 1)))
  const projectionsByDate = new Map(priorProjections.map((row) => [row.weekStartDate, Object.values(readProjectionState(row.state).meals).map((meal) => meal.recipeRef)]))
  const history = resolveMealHistory(priorDates.map((date) => ({ weekStartDate: date, mealIds: projectionsByDate.get(date) ?? [] })), outcomes)
  const recentMealIds = extractRecentMealIds(history.scoringRecords, weekStartDate)
  const fatiguedIds = new Set(detectConfirmedFatiguedMeals(priorDates, history.confirmedRecords))
  const changedCounts = new Map<string, number>()
  for (const outcome of outcomes.filter((row) => row.status === 'changed_plan')) {
    changedCounts.set(outcome.plannedRecipeId, (changedCounts.get(outcome.plannedRecipeId) ?? 0) + 1)
  }
  const sourceOutcomes = outcomes.filter((row) => row.weekStartDate === completedWeek)
  const sourceByDay = new Map(sourceOutcomes.map((outcome) => [orderedDays[new Date(`${outcome.date}T00:00:00Z`).getUTCDay() === 0 ? 6 : new Date(`${outcome.date}T00:00:00Z`).getUTCDay() - 1], outcome]))
  const targetState = readProjectionState(projection?.state)
  const weekCtx = createWeekContext(readPantryStock(shoppingRows[0]?.state))
  const prepRecipeIdsByDate = new Map<string, Set<string>>()
  for (const row of prepAssignmentRows) {
    if (!row.recipeId) continue
    const ids = prepRecipeIdsByDate.get(row.date) ?? new Set<string>()
    ids.add(row.recipeId)
    prepRecipeIdsByDate.set(row.date, ids)
  }
  const used = new Set<string>()
  const days: z.infer<typeof PreviousWeekProposalDaySchema>[] = []

  for (const [day, householdSelection] of selectedDays) {
    if (targetState.lockedDays.includes(day) || targetState.skippedDays.includes(day)) continue
    const targetDate = addDays(weekStartDate, orderedDays.indexOf(day))
    const selection = mergeDayPlanningContext(householdSelection, targetState.contextOverrides?.[targetDate])
    const source = sourceByDay.get(day)
    const previousRecipe = source ? recipesById.get(source.plannedRecipeId) : undefined
    let rejection: z.infer<typeof PreviousWeekReuseReasonSchema> | null = null
    if (!source) rejection = 'fills-selected-day'
    else if (source.status !== 'cooked' || !previousRecipe) rejection = 'not-cooked'
    else if (householdSignals[previousRecipe.id] === 'not_for_us') rejection = 'family-veto'
    else if (feedback[previousRecipe.id]?.vote === 'down') rejection = 'disliked'
    else if (fatiguedIds.has(previousRecipe.id)) rejection = 'fatigued'
    else if ((changedCounts.get(previousRecipe.id) ?? 0) >= 2) rejection = 'changed-plan-often'

    const available = candidates.filter((candidate) => !used.has(candidate.id) && householdSignals[candidate.id] !== 'not_for_us' && feedback[candidate.id]?.vote !== 'down')
    const preferredPrepRecipeIds = prepRecipeIdsByDate.get(targetDate)
    const ranked = rankCandidates(available.length ? available : candidates, {
      householdId, feedback, householdSignals, allRecipes: candidates, weekCtx, selection,
      recentMealIds, fatiguedMealIds: [...fatiguedIds], preferredPrepRecipeIds,
    })
    // Reuse is the promise here. Recency must not turn every meal from last
    // week into a replacement; this comparison only asks whether the target
    // day's explicit context makes another recipe materially better.
    if (!rejection && previousRecipe && ranked[0] && scoreMeal(ranked[0], { householdId, feedback, householdSignals, allRecipes: candidates, weekCtx, selection, preferredPrepRecipeIds }) - scoreMeal(previousRecipe, { householdId, feedback, householdSignals, allRecipes: candidates, weekCtx, selection, preferredPrepRecipeIds }) >= 8) {
      rejection = 'week-context'
    }
    const chosen = !rejection && previousRecipe ? previousRecipe : ranked[0]
    if (!chosen) continue
    used.add(chosen.id)
    updateWeekContext(weekCtx, chosen)
    days.push({
      dayOfWeek: day, date: targetDate, action: !source ? 'added' : rejection ? 'replaced' : 'kept',
      reason: rejection ?? 'worked-last-week', previousRecipeRef: previousRecipe?.id ?? null,
      previousRecipeTitle: previousRecipe?.title ?? null, recipeRef: chosen.id, recipeTitle: chosen.title,
      servings: selection?.servingsOverride ?? chosen.servings,
    })
  }

  return {
    proposalId: request.proposalId, sourceWeekStartDate: completedWeek,
    expectedUpdatedAt: projection?.updatedAt.toISOString() ?? null,
    keptCount: days.filter((day) => day.action === 'kept').length,
    changedCount: days.filter((day) => day.action !== 'kept').length,
    days,
  }
}

export function applyPreviousWeekProposal(
  ctx: RequestContext, weekStartDate: string, request: TPreviousWeekProposalRequest,
) {
  return retryOnceOnWriteConflict(() => applyPreviousWeekProposalOnce(ctx, weekStartDate, request))
}

async function applyPreviousWeekProposalOnce(
  ctx: RequestContext, weekStartDate: string, request: TPreviousWeekProposalRequest,
) {
  const { userId } = ctx
  const existing = await selectPreviousWeekReusedPayloads(ctx, weekStartDate)
  const existingPayload = existing.map((row) => row.payload as z.infer<typeof PreviousWeekReusedPayloadSchema>).find((payload) => payload.proposalId === request.proposalId)
  if (existingPayload) {
    const proposal = { proposalId: existingPayload.proposalId, sourceWeekStartDate: existingPayload.sourceWeekStartDate, expectedUpdatedAt: null, keptCount: existingPayload.days.filter((day) => day.action === 'kept').length, changedCount: existingPayload.days.filter((day) => day.action !== 'kept').length, days: existingPayload.days }
    return { ok: true as const, alreadyApplied: true, proposal }
  }
  const proposal = await previewPreviousWeekProposal(ctx, weekStartDate, request)
  if ('error' in proposal) return proposal
  await appendWeekPlanEvent(ctx, {
    weekStartDate,
    causedBy: { source: 'algorithm', algorithmVersion: '2.0', triggeredByUserId: userId },
    payload: { eventType: 'previous_week_reused', proposalId: proposal.proposalId, sourceWeekStartDate: proposal.sourceWeekStartDate, days: proposal.days },
    expectedUpdatedAt: proposal.expectedUpdatedAt,
  })
  return { ok: true as const, alreadyApplied: false, proposal }
}

// The history list plus the premium gate for weeks older than the free
// window. Membership and range validation happen before this is called.
export async function listWeekHistory(ctx: RequestContext, range: { from?: string; to?: string }) {
  const { db, userId, householdId } = ctx
  const plans = await listWeekHistoryPlans(ctx, range)
  // Four most recent calendar weeks remain free. Shadow only for now.
  const now = new Date()
  const mondayOffset = (now.getUTCDay() + 6) % 7
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - mondayOffset - 21)).toISOString().slice(0, 10)
  if (plans.some((plan) => plan.weekStartDate < cutoff)) {
    const entitlement = await resolveEntitlementForHousehold(db, userId, householdId)
    const gate = await observePremiumGate(db, entitlement, { householdId, userId, reason: 'week_history' })
    if (gate) return { gate }
  }
  return { plans }
}

export function recordWeekPlanEvent(
  ctx: HouseholdScope,
  weekStartDate: string,
  causedBy: z.infer<typeof CausedBySchema>,
  payload: z.infer<typeof WeekPlanEventPayloadSchema>,
) {
  return appendWeekPlanEvent(ctx, { weekStartDate, causedBy, payload })
}

// Exactly one query, against the projection only — `getStreamProjection`
// is what enforces the one rule the entire pattern hinges on (design doc
// §2: "never replay the event log on the read path").
export function getWeekPlan(ctx: HouseholdScope, weekStartDate: string) {
  return selectWeekPlanProjection(ctx, weekStartDate)
}
