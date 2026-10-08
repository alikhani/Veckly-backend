import { and, desc, eq, gte, inArray, lt, lte, or } from 'drizzle-orm'
import type { z } from 'zod'
import type { Db } from '../../db.js'
import { getStreamProjection } from '../../event-stream.js'
import type { RequestContext } from '../../platform/http-errors.js'
import { withRls } from '../../rls.js'
import { householdMealOutcomes, householdMealSignals, householdMemberships, householdPortionMemories, householdPrepBatchAssignments, householdPrepBatches, householdProfiles, householdSavedRecipes, householdWeekPlans, householdWeekPulses, households, mealFeedback, recipes, shoppingListProjections, userProfiles, weekPlanEvents, weekPlanProjections } from '../../schema.js'
import { addDays, orderedDays } from '../../shared/week-dates.js'
import { listWeekPulseRows } from '../../week-pulse.js'
import { readProjectionState } from './projection.js'
import type { WeekHistoryListItemSchema, WeekHistoryPlanSchema, WeekHistoryStateSchema } from './schemas.js'

// Every function here runs under the caller's RLS identity. Reads that never
// need the caller's own id take the narrower household scope; a full
// `RequestContext` satisfies it.
type HouseholdScope = Pick<RequestContext, 'db' | 'accessToken' | 'householdId'>

// The recipes a household plans from: its own, builtins, and recipes it has
// saved. Deliberately not "any public recipe" — another household's public
// recipe only enters the pool once this household saves it.
function householdRecipePool(tx: Db, householdId: string) {
  return or(
    eq(recipes.householdId, householdId),
    eq(recipes.source, 'builtin'),
    inArray(
      recipes.id,
      tx.select({ id: householdSavedRecipes.recipeId }).from(householdSavedRecipes).where(eq(householdSavedRecipes.householdId, householdId)),
    ),
  )
}

export function toWeekHistoryPlanResponse(row: typeof householdWeekPlans.$inferSelect): z.infer<typeof WeekHistoryPlanSchema> {
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

// Exactly one query, against the projection only — `getStreamProjection`
// never replays the event log.
export function selectWeekPlanProjection(ctx: HouseholdScope, weekStartDate: string) {
  return getStreamProjection(ctx.db, ctx.accessToken, weekPlanProjections, { householdId: ctx.householdId, weekStartDate })
}

export async function selectWeekHistoryPlans(ctx: HouseholdScope, range: { from?: string; to?: string }) {
  const { db, accessToken, householdId } = ctx
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

export async function selectWeekHistoryPlan(ctx: HouseholdScope, weekStartDate: string) {
  const { db, accessToken, householdId } = ctx
  return withRls(db, accessToken, async (tx) => {
    const [row] = await tx
      .select()
      .from(householdWeekPlans)
      .where(and(eq(householdWeekPlans.householdId, householdId), eq(householdWeekPlans.weekStartDate, weekStartDate)))
      .limit(1)

    return row ? toWeekHistoryPlanResponse(row) : null
  })
}

// One transaction: the projection, the avoid-list, the candidate recipes, and
// the day's leftover assignments are read from the same snapshot. Returns
// null when the week has no projection.
export async function loadWeekRescueInputs(ctx: HouseholdScope, weekStartDate: string, date: string) {
  const { db, accessToken, householdId } = ctx
  return withRls(db, accessToken, async (tx) => {
    const [[projection], [profile], prepBatches] = await Promise.all([
      tx.select({ state: weekPlanProjections.state, updatedAt: weekPlanProjections.updatedAt })
        .from(weekPlanProjections)
        .where(and(eq(weekPlanProjections.householdId, householdId), eq(weekPlanProjections.weekStartDate, weekStartDate)))
        .limit(1),
      tx.select({ avoidIngredients: householdProfiles.avoidIngredients })
        .from(householdProfiles).where(eq(householdProfiles.householdId, householdId)).limit(1),
      tx.select({ id: householdPrepBatches.id, recipeId: householdPrepBatches.recipeId })
        .from(householdPrepBatches)
        .where(and(eq(householdPrepBatches.householdId, householdId), lte(householdPrepBatches.cookDate, date))),
    ])
    if (!projection) return null
    const projectionState = readProjectionState(projection.state)
    // Candidates come from the same pool generation plans from. Already-planned
    // recipes are loaded too (for the before-side and shopping diff) even when
    // outside the pool; the derive step never offers a planned recipe.
    const plannedRecipeIds = [...new Set(Object.values(projectionState.meals).map((meal) => meal.recipeRef))]
    const recipeRows = await tx.select({
      id: recipes.id,
      title: recipes.title,
      servings: recipes.servings,
      prepTimeMinutes: recipes.prepTimeMinutes,
      cookTimeMinutes: recipes.cookTimeMinutes,
      ingredients: recipes.ingredients,
      tags: recipes.tags,
    }).from(recipes).where(and(
      eq(recipes.isArchived, false),
      plannedRecipeIds.length > 0
        ? or(householdRecipePool(tx, householdId), inArray(recipes.id, plannedRecipeIds))
        : householdRecipePool(tx, householdId),
    ))
    const assignments = prepBatches.length
      ? await tx.select({ batchId: householdPrepBatchAssignments.batchId })
        .from(householdPrepBatchAssignments)
        .where(and(
          inArray(householdPrepBatchAssignments.batchId, prepBatches.map((batch) => batch.id)),
          eq(householdPrepBatchAssignments.date, date),
        ))
      : []
    return { projection, projectionState, profile, prepBatches, recipeRows, assignments }
  })
}

export async function selectWeekPlanEventPayloads(ctx: HouseholdScope, weekStartDate: string) {
  const { db, accessToken, householdId } = ctx
  return withRls(db, accessToken, async (tx) => tx
    .select({ eventType: weekPlanEvents.eventType, payload: weekPlanEvents.payload })
    .from(weekPlanEvents)
    .where(and(eq(weekPlanEvents.householdId, householdId), eq(weekPlanEvents.weekStartDate, weekStartDate))))
}

export async function selectPreviousWeekReusedPayloads(ctx: HouseholdScope, weekStartDate: string) {
  const { db, accessToken, householdId } = ctx
  return withRls(db, accessToken, (tx) => tx.select({ payload: weekPlanEvents.payload })
    .from(weekPlanEvents).where(and(eq(weekPlanEvents.householdId, householdId), eq(weekPlanEvents.weekStartDate, weekStartDate), eq(weekPlanEvents.eventType, 'previous_week_reused'))))
}

// One transaction, as one consistent snapshot of everything the summary
// shows. Returns null when the household row is not visible.
export async function loadWeekSummaryRows(ctx: HouseholdScope, weekStartDate: string, priorWeekStartDates: string[]) {
  const { db, accessToken, householdId } = ctx
  return withRls(db, accessToken, async (tx) => {
    const [household] = await tx
      .select({ id: households.id, name: households.name })
      .from(households)
      .where(eq(households.id, householdId))
      .limit(1)

    if (!household) return null

    const allWeekStartDates = [weekStartDate, ...priorWeekStartDates]
    const [[projection], priorWeekProjections, outcomeRows, [shoppingProjection], pulseMembers] = await Promise.all([
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
      tx
        .select({ state: shoppingListProjections.state })
        .from(shoppingListProjections)
        .where(and(eq(shoppingListProjections.householdId, householdId), lte(shoppingListProjections.weekStartDate, weekStartDate)))
        .orderBy(desc(shoppingListProjections.weekStartDate))
        .limit(1),
      tx.select({
        userId: householdMemberships.userId,
        givenName: userProfiles.givenName,
        wishedMeal: householdWeekPulses.wishedMeal,
        respondedAt: householdWeekPulses.updatedAt,
      })
        .from(householdMemberships)
        .leftJoin(userProfiles, eq(userProfiles.userId, householdMemberships.userId))
        .leftJoin(householdWeekPulses, and(
          eq(householdWeekPulses.householdId, householdMemberships.householdId),
          eq(householdWeekPulses.weekStartDate, weekStartDate),
          eq(householdWeekPulses.userId, householdMemberships.userId),
        ))
        .where(and(eq(householdMemberships.householdId, householdId), eq(householdMemberships.status, 'active'))),
    ])

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
          ingredients: recipes.ingredients,
        })
        .from(recipes)
        .where(and(or(eq(recipes.householdId, householdId), eq(recipes.isPublic, true)), inArray(recipes.id, recipeIds)))
      : []

    const [portionOutcomeRows, portionMemoryRows] = recipeIds.length ? await Promise.all([
      tx.select({
        plannedRecipeId: householdMealOutcomes.plannedRecipeId,
        status: householdMealOutcomes.status,
        portionOutcome: householdMealOutcomes.portionOutcome,
        intentionalLeftovers: householdMealOutcomes.intentionalLeftovers,
        updatedAt: householdMealOutcomes.updatedAt,
      }).from(householdMealOutcomes).where(and(
        eq(householdMealOutcomes.householdId, householdId),
        inArray(householdMealOutcomes.plannedRecipeId, recipeIds),
      )),
      tx.select({
        recipeId: householdPortionMemories.recipeId,
        ignoredThrough: householdPortionMemories.ignoredThrough,
      }).from(householdPortionMemories).where(and(
        eq(householdPortionMemories.householdId, householdId),
        inArray(householdPortionMemories.recipeId, recipeIds),
      )),
    ]) : [[], []]
    const accessibleRecipeTitles = await tx.select({ title: recipes.title }).from(recipes).where(and(
      eq(recipes.isArchived, false),
      householdRecipePool(tx, householdId),
    ))

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

    return {
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
    }
  })
}

// Each read is its own RLS transaction, run concurrently — the same shape the
// proposal has always loaded with.
export function loadPreviousWeekInputs(ctx: RequestContext, weekStartDate: string, priorWindowStart: string) {
  const { db, accessToken, userId, householdId } = ctx
  return Promise.all([
    withRls(db, accessToken, (tx) => tx.select({ avoidIngredients: householdProfiles.avoidIngredients, selectedDays: householdProfiles.selectedDays })
      .from(householdProfiles).where(eq(householdProfiles.householdId, householdId)).limit(1)),
    getStreamProjection(db, accessToken, weekPlanProjections, { householdId, weekStartDate }),
    withRls(db, accessToken, (tx) => tx.select({
      id: recipes.id, title: recipes.title, servings: recipes.servings, prepTimeMinutes: recipes.prepTimeMinutes,
      tags: recipes.tags, ingredients: recipes.ingredients, cuisine: recipes.cuisine,
      proteinSource: recipes.proteinSource, mealWeight: recipes.mealWeight, householdId: recipes.householdId,
    }).from(recipes).where(and(eq(recipes.isArchived, false), householdRecipePool(tx, householdId)))),
    withRls(db, accessToken, (tx) => tx.select({ mealId: mealFeedback.mealId, vote: mealFeedback.vote, signal: mealFeedback.signal })
      .from(mealFeedback).where(and(eq(mealFeedback.householdId, householdId), eq(mealFeedback.userId, userId)))),
    withRls(db, accessToken, (tx) => tx.select({ mealId: householdMealSignals.mealId, signal: householdMealSignals.signal })
      .from(householdMealSignals).where(eq(householdMealSignals.householdId, householdId))),
    withRls(db, accessToken, (tx) => tx.select({ weekStartDate: weekPlanProjections.weekStartDate, state: weekPlanProjections.state })
      .from(weekPlanProjections).where(and(eq(weekPlanProjections.householdId, householdId), gte(weekPlanProjections.weekStartDate, priorWindowStart), lt(weekPlanProjections.weekStartDate, weekStartDate)))),
    withRls(db, accessToken, (tx) => tx.select({
      weekStartDate: householdMealOutcomes.weekStartDate, date: householdMealOutcomes.date,
      plannedRecipeId: householdMealOutcomes.plannedRecipeId, status: householdMealOutcomes.status,
      actualRecipeId: householdMealOutcomes.actualRecipeId,
    }).from(householdMealOutcomes).where(and(
      eq(householdMealOutcomes.householdId, householdId), gte(householdMealOutcomes.weekStartDate, priorWindowStart), lt(householdMealOutcomes.weekStartDate, weekStartDate),
    ))),
    withRls(db, accessToken, (tx) => tx.select({ state: shoppingListProjections.state })
      .from(shoppingListProjections)
      .where(and(eq(shoppingListProjections.householdId, householdId), lte(shoppingListProjections.weekStartDate, weekStartDate)))
      .orderBy(desc(shoppingListProjections.weekStartDate)).limit(1)),
    withRls(db, accessToken, (tx) => tx
      .select({ date: householdPrepBatchAssignments.date, recipeId: householdPrepBatches.recipeId })
      .from(householdPrepBatchAssignments)
      .innerJoin(householdPrepBatches, eq(householdPrepBatchAssignments.batchId, householdPrepBatches.id))
      .where(and(
        eq(householdPrepBatches.householdId, householdId), eq(householdPrepBatchAssignments.mealType, 'dinner'),
        gte(householdPrepBatchAssignments.date, weekStartDate), lte(householdPrepBatchAssignments.date, addDays(weekStartDate, 6)),
      ))),
  ])
}

// Each read is its own RLS transaction, run concurrently — the same shape
// generation has always loaded with.
export function loadGenerationInputs(ctx: RequestContext, weekStartDate: string, priorWeekStartDates: string[]) {
  const { db, accessToken, userId, householdId } = ctx
  return Promise.all([
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
          householdRecipePool(tx, householdId),
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
    withRls(db, accessToken, (tx) => tx
      .select({ state: shoppingListProjections.state })
      .from(shoppingListProjections)
      .where(and(eq(shoppingListProjections.householdId, householdId), lte(shoppingListProjections.weekStartDate, weekStartDate)))
      .orderBy(desc(shoppingListProjections.weekStartDate))
      .limit(1)),
    withRls(db, accessToken, (tx) => tx
      .select({ date: householdPrepBatchAssignments.date, recipeId: householdPrepBatches.recipeId })
      .from(householdPrepBatchAssignments)
      .innerJoin(householdPrepBatches, eq(householdPrepBatchAssignments.batchId, householdPrepBatches.id))
      .where(and(
        eq(householdPrepBatches.householdId, householdId),
        eq(householdPrepBatchAssignments.mealType, 'dinner'),
        gte(householdPrepBatchAssignments.date, weekStartDate),
        lte(householdPrepBatchAssignments.date, addDays(weekStartDate, 6)),
      ))),
    listWeekPulseRows(db, accessToken, householdId, weekStartDate),
  ])
}
