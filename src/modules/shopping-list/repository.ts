import { and, desc, eq, inArray, or } from 'drizzle-orm'
import { appendStreamEvent, getStreamProjection } from '../../event-stream.js'
import type { HouseholdScope } from '../../platform/http-errors.js'
import { withRls } from '../../rls.js'
import { householdShoppingPreferences, households, householdProfiles, recipes, shoppingListEvents, shoppingListProjections, weekPlanProjections } from '../../schema.js'
import {
  deduplicateCustomItems,
  emptyProjectionState,
  foldEventIntoProjection,
  readShoppingProjectionState,
  toShoppingStatePayload,
} from './projection.js'
import type { TShoppingListCausedBy, TShoppingListEventPayload, TShoppingStatePayload } from './schemas.js'
import { plannedMealOccurrences, type TWeekPlanProjectionState } from './summary.js'

// Exactly one query, against the projection only — `getStreamProjection`
// enforces the same read-path rule as week-plan's: never replay the event
// log on the read path.
export function selectShoppingListProjection(ctx: HouseholdScope, weekStartDate: string) {
  return getStreamProjection(ctx.db, ctx.accessToken, shoppingListProjections, { householdId: ctx.householdId, weekStartDate })
}

// The transactional append-and-fold mechanism lives in `event-stream.ts` as
// `appendStreamEvent` — extracted once this stream became the second
// byte-identical instance of week-plan's shape, proving it's genuinely
// shared rather than a one-off that happened to fit. See that module's
// comment for the reasoning (including why the table arguments are duck-typed
// rather than fought into Drizzle's generics).
export function appendShoppingListEvent(
  ctx: HouseholdScope,
  args: { weekStartDate: string; causedBy: TShoppingListCausedBy; payload: TShoppingListEventPayload },
) {
  return appendStreamEvent(
    ctx.db,
    ctx.accessToken,
    { events: shoppingListEvents, projections: shoppingListProjections },
    { fold: foldEventIntoProjection, emptyState: emptyProjectionState },
    { householdId: ctx.householdId, ...args },
  )
}

export type TUpdateShoppingListStateResult =
  | { outcome: 'updated'; updatedAt: string | null }
  | { outcome: 'stale'; updatedAt: string | null }

// One transaction: the stale check, the event insert and the projection upsert
// land together or not at all.
export async function replaceShoppingListStateRows(
  ctx: HouseholdScope,
  args: {
    weekStartDate: string
    causedBy: TShoppingListCausedBy
    expectedUpdatedAt?: string | null
    state: TShoppingStatePayload | null
  },
): Promise<TUpdateShoppingListStateResult> {
  const householdId = ctx.householdId
  return withRls(ctx.db, ctx.accessToken, async (tx) => {
    const [existingProjection] = await tx
      .select({ state: shoppingListProjections.state, updatedAt: shoppingListProjections.updatedAt })
      .from(shoppingListProjections)
      .where(and(eq(shoppingListProjections.householdId, householdId), eq(shoppingListProjections.weekStartDate, args.weekStartDate)))
      .limit(1)

    const currentState = readShoppingProjectionState(existingProjection?.state)
    const currentUpdatedAt = toShoppingStatePayload(currentState) ? existingProjection?.updatedAt.toISOString() ?? null : null
    if (args.expectedUpdatedAt !== undefined && currentUpdatedAt !== args.expectedUpdatedAt) {
      return { outcome: 'stale', updatedAt: currentUpdatedAt }
    }

    const [latest] = await tx
      .select({ sequenceNumber: shoppingListEvents.sequenceNumber })
      .from(shoppingListEvents)
      .where(and(eq(shoppingListEvents.householdId, householdId), eq(shoppingListEvents.weekStartDate, args.weekStartDate)))
      .orderBy(desc(shoppingListEvents.sequenceNumber))
      .limit(1)

    const sanitizedState = args.state
      ? { ...args.state, customItems: deduplicateCustomItems(args.state.customItems ?? []) }
      : null
    const payload: TShoppingListEventPayload = sanitizedState === null
      ? { eventType: 'shopping_list_cleared' }
      : { eventType: 'shopping_state_replaced', state: sanitizedState }
    const { eventType, ...payloadFields } = payload
    const nextSequenceNumber = (latest?.sequenceNumber ?? 0) + 1

    await tx.insert(shoppingListEvents).values({
      householdId,
      weekStartDate: args.weekStartDate,
      sequenceNumber: nextSequenceNumber,
      causedBy: args.causedBy,
      eventType,
      payload: payloadFields,
    })

    const nextState = foldEventIntoProjection(currentState, payload)
    const now = new Date()
    const [projection] = await tx
      .insert(shoppingListProjections)
      .values({ householdId, weekStartDate: args.weekStartDate, state: nextState, updatedAt: now })
      .onConflictDoUpdate({
        target: [shoppingListProjections.householdId, shoppingListProjections.weekStartDate],
        set: { state: nextState, updatedAt: now },
      })
      .returning({ updatedAt: shoppingListProjections.updatedAt })

    if (!projection) throw new Error('Upsert did not return the shopping list projection')
    return { outcome: 'updated', updatedAt: args.state === null ? null : projection.updatedAt.toISOString() }
  })
}

// Every row the summary needs, read in one transaction. The week plan is read
// straight from `week_plan_projections` (not through week-plan's module) so it
// stays inside this same snapshot. Returns null when the household is not
// visible to the caller.
export async function loadShoppingListSummaryRows(ctx: HouseholdScope, weekStartDate: string) {
  const householdId = ctx.householdId
  return withRls(ctx.db, ctx.accessToken, async (tx) => {
    const [household] = await tx
      .select({ id: households.id, name: households.name })
      .from(households)
      .where(eq(households.id, householdId))
      .limit(1)

    if (!household) return null

    const [weekProjection] = await tx
      .select({ state: weekPlanProjections.state })
      .from(weekPlanProjections)
      .where(and(eq(weekPlanProjections.householdId, householdId), eq(weekPlanProjections.weekStartDate, weekStartDate)))
      .limit(1)

    const [shoppingProjection] = await tx
      .select({ state: shoppingListProjections.state, updatedAt: shoppingListProjections.updatedAt })
      .from(shoppingListProjections)
      .where(and(eq(shoppingListProjections.householdId, householdId), eq(shoppingListProjections.weekStartDate, weekStartDate)))
      .limit(1)

    const [profileRow] = await tx
      .select({ adults: householdProfiles.adults, children: householdProfiles.children })
      .from(householdProfiles)
      .where(eq(householdProfiles.householdId, householdId))
      .limit(1)
    const [preferencesRow] = await tx
      .select({ categoryOrder: householdShoppingPreferences.categoryOrder })
      .from(householdShoppingPreferences)
      .where(eq(householdShoppingPreferences.householdId, householdId))
      .limit(1)

    const weekState = (weekProjection?.state ?? {}) as TWeekPlanProjectionState
    const mealOccurrences = plannedMealOccurrences(weekState)

    // Fetch each distinct recipe exactly once — the per-day scaling reads
    // from this map per occurrence, so there's no need to query the same
    // recipe row twice just because it's planned on two days.
    const recipeIds = [...new Set(mealOccurrences.map((meal) => meal.recipeRef))]
    const recipeRows = recipeIds.length
      ? await tx
        .select({ id: recipes.id, ingredients: recipes.ingredients, source: recipes.source, servings: recipes.servings })
        .from(recipes)
        .where(and(or(eq(recipes.householdId, householdId), eq(recipes.isPublic, true)), inArray(recipes.id, recipeIds)))
      : []

    return { household, shoppingProjection, profileRow, preferencesRow, mealOccurrences, recipeRows }
  })
}
