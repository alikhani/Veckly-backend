import { normalizeIngredientCategory, readRecipeIngredients } from '../../ingredient-categories.js'
import {
  canonicalIngredientItemKey,
  ingredientItemKey,
  ingredientStateItemKeys,
  singularizeIngredientName,
} from '../../ingredient-identity.js'
import { localizeShoppingIngredientLabel, localizeShoppingUnit, type TShoppingListLanguage } from './localization.js'
import { normalizeKeyPart, type TShoppingListProjectionState } from './projection.js'

const weekDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const

type TRecipeIngredient = {
  item: string
  amount?: string
  unit?: string
  category?: string
}

// The narrow slice of week-plan's projection state the summary reads (the
// `week_plan_projections.state` JSONB, read in the same transaction).
export type TWeekPlanProjectionState = {
  meals?: Partial<Record<typeof weekDays[number], { recipeRef?: string; servings?: number }>>
}

const buildItemKey = ingredientItemKey
const singularizeShoppingItem = singularizeIngredientName
const buildCanonicalItemKey = canonicalIngredientItemKey

const buildStateItemKeys = ingredientStateItemKeys

function preferredShoppingLabel(current: string, candidate: string) {
  const currentTrimmed = current.trim()
  const candidateTrimmed = candidate.trim()
  const currentIsPlural = singularizeShoppingItem(currentTrimmed) !== currentTrimmed.toLowerCase()
  const candidateIsPlural = singularizeShoppingItem(candidateTrimmed) !== candidateTrimmed.toLowerCase()
  if (currentIsPlural !== candidateIsPlural) return currentIsPlural ? currentTrimmed : candidateTrimmed
  return currentTrimmed.localeCompare(candidateTrimmed) <= 0 ? currentTrimmed : candidateTrimmed
}

function formatAggregatedAmount(n: number): string {
  return Number.isInteger(n) ? String(n) : parseFloat(n.toFixed(2)).toString()
}

export type TPlannedMealOccurrence = { recipeRef: string; servingsOverride: number | undefined }

export function plannedMealOccurrences(weekState: TWeekPlanProjectionState): TPlannedMealOccurrence[] {
  // One entry per (day, recipeRef) *occurrence* — not deduplicated by
  // recipe id. The same recipe can be planned on more than one day in the
  // same week (e.g. Monday and Thursday), each occurrence potentially
  // scaled to a different `plannedMealServings` (a per-day servings
  // override applies to one day, not the recipe). Deduplicating here would
  // silently drop a real ingredient contribution from the list.
  return weekDays
    .map((day) => ({
      recipeRef: weekState.meals?.[day]?.recipeRef,
      servingsOverride: weekState.meals?.[day]?.servings,
    }))
    .filter((meal): meal is typeof meal & { recipeRef: string } => Boolean(meal.recipeRef))
}

export function buildShoppingListGroups(input: {
  mealOccurrences: TPlannedMealOccurrence[]
  recipesById: Map<string, { ingredients: unknown; source: string; servings: number }>
  householdSize: number | undefined
  categoryOrder: string[]
  shoppingState: TShoppingListProjectionState
  language: TShoppingListLanguage
}) {
  const { mealOccurrences, recipesById, householdSize, categoryOrder, shoppingState, language } = input
  const categorySortIndex = new Map(categoryOrder.map((category, index) => [normalizeKeyPart(category), index]))
  const ingredientRows = mealOccurrences.flatMap((meal) => {
    const recipe = recipesById.get(meal.recipeRef)
    if (!recipe) return []
    const recipeBaseServings = recipe.servings
    const plannedMealServings = meal.servingsOverride ?? householdSize ?? recipeBaseServings
    const scaleFactor = plannedMealServings / recipeBaseServings
    return readRecipeIngredients<TRecipeIngredient>(recipe.ingredients)
      .filter((ingredient) => ingredient.item.trim())
      .map((ingredient) => ({
        ingredient,
        scaleFactor,
        rawItemKey: buildItemKey(ingredient),
        canonicalItemKey: buildCanonicalItemKey(ingredient),
        stateItemKeys: buildStateItemKeys(ingredient),
        shouldLocalize: recipe.source === 'builtin',
      }))
  })
  const canonicalKeyVariants = new Map<string, Set<string>>()
  for (const row of ingredientRows) {
    const variants = canonicalKeyVariants.get(row.canonicalItemKey) ?? new Set<string>()
    variants.add(row.rawItemKey)
    canonicalKeyVariants.set(row.canonicalItemKey, variants)
  }

  type TItemAccumulator = {
    category: string
    label: string
    originalItemKeys: Set<string>
    shouldLocalize: boolean
    totalAmount: number | null
    canSum: boolean
    unit: string | null
  }
  const accumulator = new Map<string, TItemAccumulator>()

  for (const { ingredient, scaleFactor, rawItemKey, canonicalItemKey, stateItemKeys, shouldLocalize } of ingredientRows) {
    const itemKey = (canonicalKeyVariants.get(canonicalItemKey)?.size ?? 0) > 1 ? canonicalItemKey : rawItemKey
    const rawAmount = ingredient.amount?.trim() || null
    const parsed = rawAmount ? parseFloat(rawAmount) : null
    const validNum = parsed !== null && !isNaN(parsed) && isFinite(parsed)
    const scaledAmount = validNum ? parsed! * scaleFactor : null

    const existing = accumulator.get(itemKey)
    if (existing) {
      for (const key of stateItemKeys) existing.originalItemKeys.add(key)
      existing.shouldLocalize ||= shouldLocalize
      existing.label = preferredShoppingLabel(existing.label, ingredient.item)
      if (existing.canSum && validNum) {
        existing.totalAmount = (existing.totalAmount ?? 0) + scaledAmount!
      } else {
        existing.canSum = false
        existing.totalAmount = null
      }
    } else {
      accumulator.set(itemKey, {
        category: normalizeIngredientCategory(ingredient.item, ingredient.category),
        label: ingredient.item.trim(),
        originalItemKeys: stateItemKeys,
        shouldLocalize,
        totalAmount: validNum ? scaledAmount! : null,
        canSum: validNum,
        unit: ingredient.unit?.trim() || null,
      })
    }
  }

  const itemsByKey = new Map<string, {
    category: string
    label: string
    amount: string | null
    unit: string | null
    checked: boolean
    isCustom: boolean
  }>()
  for (const [itemKey, item] of accumulator) {
    itemsByKey.set(itemKey, {
      category: item.category,
      label: item.shouldLocalize ? localizeShoppingIngredientLabel(item.label, language) : item.label,
      amount: item.totalAmount !== null ? formatAggregatedAmount(item.totalAmount) : null,
      unit: item.shouldLocalize ? localizeShoppingUnit(item.unit, language) : item.unit,
      checked: shoppingState.checkedItems[itemKey] === true || [...item.originalItemKeys].some((originalKey) => shoppingState.checkedItems[originalKey] === true),
      isCustom: false,
    })
  }

  for (const item of shoppingState.customItems) {
    itemsByKey.set(item.itemKey, {
      category: item.category,
      label: item.label,
      amount: null,
      unit: null,
      checked: shoppingState.checkedItems[item.itemKey] === true,
      isCustom: true,
    })
  }

  const groupsByCategory = new Map<string, {
    category: string
    items: Array<{
      itemKey: string
      label: string
      amount: string | null
      unit: string | null
      checked: boolean
      isCustom: boolean
    }>
  }>()
  for (const [itemKey, item] of itemsByKey) {
    // Category casing historically differs between recipe ingredients
    // ("other") and custom items ("Other"). Group by the canonical API
    // value so one aisle never renders as two visually identical sections.
    const categoryKey = normalizeKeyPart(item.category) || 'other'
    const group = groupsByCategory.get(categoryKey) ?? { category: item.category || 'other', items: [] }
    group.items.push({ itemKey, label: item.label, amount: item.amount, unit: item.unit, checked: item.checked, isCustom: item.isCustom })
    groupsByCategory.set(categoryKey, group)
  }

  const groups = Array.from(groupsByCategory.entries())
    .sort(([left], [right]) =>
      (categorySortIndex.get(left) ?? Number.MAX_SAFE_INTEGER) - (categorySortIndex.get(right) ?? Number.MAX_SAFE_INTEGER)
        || left.localeCompare(right)
    )
    .map(([, group]) => ({
      category: group.category,
      items: group.items.sort((left, right) => left.label.localeCompare(right.label)),
    }))

  return groups
}
