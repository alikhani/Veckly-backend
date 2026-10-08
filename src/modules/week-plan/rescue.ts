import type { z } from 'zod'
import { readRecipeIngredients } from '../../ingredient-categories.js'
import { recipeMatchesAvoided } from '../../shared/recipe-matching.js'
import { addDays, orderedDays } from '../../shared/week-dates.js'
import { normalizedIngredientName } from './explanations.js'
import type { TWeekPlanProjectionState } from './projection.js'
import type { dayOfWeek, TWeekRescuePreview, TWeekRescueRequest } from './schemas.js'

export type TWeekRescueFailure = 'NO_PLAN' | 'LOCKED_DAY' | 'NO_RESCUE_FOUND' | 'STALE_WEEK_PLAN'

export type TRescueRecipe = {
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
  avoidIngredients?: string[]
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
      && !input.projection.skippedDays.includes(day)
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
  const plannedRecipeIds = new Set(Object.values(input.projection.meals).map((meal) => meal.recipeRef))
  const candidates = input.recipes
    .filter((recipe) => !plannedRecipeIds.has(recipe.id))
    .filter((recipe) => !recipeMatchesAvoided(recipe, input.avoidIngredients ?? []))
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
