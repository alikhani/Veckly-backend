import { canonicalIngredientItemKey, pantryCoversIngredient } from '../../ingredient-identity.js'
import type { TWeekExplanation } from './schemas.js'

const EXCLUDED_SHARED_INGREDIENTS = new Set([
  'salt', 'salt and pepper', 'pepper', 'black pepper', 'water', 'oil', 'olive oil',
  'salt och peppar', 'svartpeppar', 'vatten', 'olja', 'olivolja',
])

export function normalizedIngredientName(value: string) {
  return value.trim().toLocaleLowerCase('sv-SE').replace(/\s+/g, ' ')
}

export function deriveWeekExplanations(input: {
  days: Array<{ date: string; reason: string | null; recipe: { id: string; title: string } | null }>
  recipeIngredients: Map<string, Array<{ item: string; unit?: string | null; category?: string | null }>>
  prepLinks: Array<{ recipeId: string | null; recipeTitle: string | null; cookDate: string; coveredDates: string[] }>
  pantryStock?: Record<string, number>
}): TWeekExplanation[] {
  const explanations: TWeekExplanation[] = []

  // An explicit pantry focus is a user instruction, so acknowledge its
  // effect before lower-priority planning observations can fill the two
  // explanation slots.
  if (input.days.some((day) => day.reason === 'pantry-coverage')) {
    const coveredIngredients = [...new Set(input.days.flatMap((day) => day.recipe
      ? (input.recipeIngredients.get(day.recipe.id) ?? [])
        .filter((ingredient) => pantryCoversIngredient(ingredient, input.pantryStock ?? {}))
        .map((ingredient) => ingredient.item.trim())
      : []))]
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right))
      .slice(0, 5)
    if (coveredIngredients.length > 0) explanations.push({ kind: 'pantry-coverage', ingredients: coveredIngredients })
  }

  const contextDay = input.days.find((day) => day.reason === 'week-override' && day.recipe)
  if (contextDay?.recipe) {
    explanations.push({ kind: 'week-context', date: contextDay.date, recipeTitle: contextDay.recipe.title })
  }

  const prepLink = input.prepLinks
    .filter((link) => link.recipeTitle && link.coveredDates.some((date) => date > link.cookDate))
    .sort((left, right) => left.cookDate.localeCompare(right.cookDate))[0]
  if (prepLink?.recipeTitle) {
    explanations.push({
      kind: 'leftover-chain',
      recipeTitle: prepLink.recipeTitle,
      cookDate: prepLink.cookDate,
      coveredDates: [...new Set(prepLink.coveredDates.filter((date) => date > prepLink.cookDate))].sort(),
    })
  }

  const ingredientUsage = new Map<string, { label: string; recipeIds: Set<string> }>()
  for (const day of input.days) {
    if (!day.recipe) continue
    for (const ingredient of input.recipeIngredients.get(day.recipe.id) ?? []) {
      const normalizedName = normalizedIngredientName(ingredient.item)
      if (!normalizedName || EXCLUDED_SHARED_INGREDIENTS.has(normalizedName)) continue
      const normalized = canonicalIngredientItemKey(ingredient)
      const usage = ingredientUsage.get(normalized) ?? { label: ingredient.item.trim(), recipeIds: new Set<string>() }
      usage.recipeIds.add(day.recipe.id)
      ingredientUsage.set(normalized, usage)
    }
  }
  const sharedIngredient = [...ingredientUsage.entries()]
    .filter(([, usage]) => usage.recipeIds.size >= 2)
    .sort(([leftKey, left], [rightKey, right]) => right.recipeIds.size - left.recipeIds.size || leftKey.localeCompare(rightKey))[0]?.[1]
  if (sharedIngredient) {
    explanations.push({ kind: 'shared-ingredient', ingredient: sharedIngredient.label, dinnerCount: sharedIngredient.recipeIds.size })
  }

  return explanations.slice(0, 2)
}
