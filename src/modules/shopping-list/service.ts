import type { HouseholdScope } from '../../platform/http-errors.js'
import { DEFAULT_SHOPPING_CATEGORY_ORDER } from '../../shopping-preferences.js'
import type { TShoppingListLanguage } from './localization.js'
import { readShoppingProjectionState, toShoppingStatePayload } from './projection.js'
import {
  appendShoppingListEvent,
  loadShoppingListSummaryRows,
  replaceShoppingListStateRows,
  selectShoppingListProjection,
} from './repository.js'
import type { TShoppingListCausedBy, TShoppingListEventPayload, TShoppingStatePayload } from './schemas.js'
import { buildShoppingListGroups } from './summary.js'

export function recordShoppingListEvent(
  ctx: HouseholdScope,
  weekStartDate: string,
  causedBy: TShoppingListCausedBy,
  payload: TShoppingListEventPayload,
) {
  return appendShoppingListEvent(ctx, { weekStartDate, causedBy, payload })
}

// Exactly one query, against the projection only — never a replay of the
// event log on the read path.
export function getShoppingList(ctx: HouseholdScope, weekStartDate: string) {
  return selectShoppingListProjection(ctx, weekStartDate)
}

export async function getShoppingListState(ctx: HouseholdScope, weekStartDate: string) {
  const projection = await selectShoppingListProjection(ctx, weekStartDate)
  if (!projection) return { state: null, updatedAt: null }

  const state = readShoppingProjectionState(projection.state)
  const payload = toShoppingStatePayload(state)
  return {
    state: payload,
    updatedAt: payload ? projection.updatedAt.toISOString() : null,
  }
}

export function replaceShoppingListState(
  ctx: HouseholdScope,
  args: {
    weekStartDate: string
    causedBy: TShoppingListCausedBy
    expectedUpdatedAt?: string | null
    state: TShoppingStatePayload | null
  },
) {
  return replaceShoppingListStateRows(ctx, args)
}

export async function getShoppingListSummary(
  ctx: HouseholdScope,
  weekStartDate: string,
  // Kept temporarily for source compatibility with callers/tests that used
  // to control the rolling-day filter. Shopping summaries are now stable for
  // the whole selected week, so `today` is deliberately ignored.
  options: { language?: TShoppingListLanguage; today?: string } = {},
) {
  const language = options.language ?? 'en'
  const rows = await loadShoppingListSummaryRows(ctx, weekStartDate)
  if (!rows) return null
  const { household, shoppingProjection, profileRow, preferencesRow, mealOccurrences, recipeRows } = rows

  const categoryOrder = Array.isArray(preferencesRow?.categoryOrder)
    ? preferencesRow.categoryOrder.filter((value): value is string => typeof value === 'string')
    : DEFAULT_SHOPPING_CATEGORY_ORDER
  // No profile row at all → no household size to scale to; each meal falls
  // back to the recipe's own base servings (i.e. unscaled) per decision 17.
  const householdSize = profileRow ? profileRow.adults + profileRow.children : undefined

  const shoppingState = readShoppingProjectionState(shoppingProjection?.state)
  const recipesById = new Map(recipeRows.map((recipe) => [recipe.id, recipe]))

  const groups = buildShoppingListGroups({ mealOccurrences, recipesById, householdSize, categoryOrder, shoppingState, language })

  return {
    household,
    weekStartDate,
    updatedAt: shoppingProjection?.updatedAt.toISOString() ?? null,
    groups,
  }
}
