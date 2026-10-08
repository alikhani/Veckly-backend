import { normalizeIngredientKeyPart } from '../../ingredient-identity.js'
import type { TShoppingListEventPayload, TShoppingStatePayload } from './schemas.js'

// --- Projection fold --------------------------------------------------------
//
// Minimal shape needed to prove `item_checked` folds correctly — same
// "explicitly provisional" status as week-plan's projection state. `itemKey`
// is the only identity an item has right now, so `checkedItems` is keyed on
// it directly.
export type TShoppingListProjectionState = {
  listStarted: boolean
  checkedItems: Record<string, boolean>
  pantryStock: Record<string, number>
  customItems: Array<{ itemKey: string; label: string; category: string }>
}

export const emptyProjectionState = (): TShoppingListProjectionState => ({ listStarted: false, checkedItems: {}, pantryStock: {}, customItems: [] })

export function checkedItemsArrayToMap(checkedItems: string[]) {
  return Object.fromEntries([...new Set(checkedItems)].map((itemKey) => [itemKey, true]))
}

function checkedItemsMapToArray(checkedItems: Record<string, boolean>) {
  return Object.entries(checkedItems)
    .filter(([, checked]) => checked)
    .map(([itemKey]) => itemKey)
    .sort((left, right) => left.localeCompare(right))
}

export function foldEventIntoProjection(
  state: TShoppingListProjectionState,
  payload: TShoppingListEventPayload,
): TShoppingListProjectionState {
  switch (payload.eventType) {
    case 'list_started':
      return { ...state, listStarted: true }
    case 'item_checked':
      return { ...state, checkedItems: { ...state.checkedItems, [payload.itemKey]: payload.checked } }
    case 'shopping_state_replaced':
      return {
        listStarted: true,
        checkedItems: checkedItemsArrayToMap(payload.state.checkedItems),
        pantryStock: payload.state.pantryStock,
        customItems: payload.state.customItems ?? [],
      }
    case 'shopping_list_cleared':
      return emptyProjectionState()
  }
}

export const normalizeKeyPart = normalizeIngredientKeyPart

function customItemIdentity(item: { label: string; category: string }) {
  return `${normalizeKeyPart(item.category)}:${(item.label ?? '').trim().toLowerCase().replace(/\s+/g, ' ')}`
}

export function deduplicateCustomItems(items: Array<{ itemKey: string; label: string; category: string }>) {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = customItemIdentity(item)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function readShoppingProjectionState(state: unknown): TShoppingListProjectionState {
  const candidate = state as (
    Partial<TShoppingListProjectionState> & { checkedItems?: unknown; pantryStock?: unknown; customItems?: unknown }
  ) | null | undefined
  const checkedItems = Array.isArray(candidate?.checkedItems)
    ? checkedItemsArrayToMap(candidate.checkedItems.filter((item): item is string => typeof item === 'string'))
    : candidate?.checkedItems && typeof candidate.checkedItems === 'object'
      ? candidate.checkedItems as Record<string, boolean>
      : {}
  const pantryStock = candidate?.pantryStock && typeof candidate.pantryStock === 'object'
    ? Object.fromEntries(
      Object.entries(candidate.pantryStock as Record<string, unknown>)
        .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])),
    )
    : {}
  const customItems = Array.isArray(candidate?.customItems)
    ? candidate.customItems
      .filter((item): item is { itemKey: string; label: string; category: string } => {
        if (!item || typeof item !== 'object') return false
        const candidateItem = item as Record<string, unknown>
        return typeof candidateItem.itemKey === 'string'
          && candidateItem.itemKey.trim().length > 0
          && typeof candidateItem.label === 'string'
          && candidateItem.label.trim().length > 0
          && typeof candidateItem.category === 'string'
          && candidateItem.category.trim().length > 0
      })
      .map((item) => ({
        itemKey: item.itemKey.trim(),
        label: item.label.trim(),
        category: item.category.trim(),
      }))
    : []

  return {
    listStarted: candidate?.listStarted === true,
    checkedItems,
    pantryStock,
    customItems: deduplicateCustomItems(customItems),
  }
}

export function toShoppingStatePayload(state: TShoppingListProjectionState): TShoppingStatePayload | null {
  const customItems = deduplicateCustomItems(state.customItems)
  if (
    !state.listStarted
    && Object.keys(state.checkedItems).length === 0
    && Object.keys(state.pantryStock).length === 0
    && customItems.length === 0
  ) return null
  return {
    checkedItems: checkedItemsMapToArray(state.checkedItems),
    pantryStock: state.pantryStock,
    customItems,
  }
}
