function readJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function readStringArray(value: unknown): string[] {
  return readJsonArray(value).filter((item): item is string => typeof item === 'string')
}

export function readIngredientArray(value: unknown): Array<{ item: string; unit?: string | null; category?: string | null }> {
  return readJsonArray(value).filter((item): item is { item: string; unit?: string | null; category?: string | null } =>
    Boolean(item && typeof item === 'object' && 'item' in item && typeof item.item === 'string'),
  )
}

// Avoid-matching, in order of signal quality:
//   - Itemized ingredients + tags are matched *always*. Ingredients are the
//     strongest signal; tags are short curated labels (e.g. a "peanut" tag on
//     "Peanut Noodles") and carry genuine allergen intent, so dropping them
//     would turn a real exclusion into a false negative — worse than the bug
//     we're fixing.
//   - The free-prose *title* is matched *only* when the recipe has fewer than
//     two itemized ingredients. The title is the false-positive-prone signal:
//     `avoid="ost"` matched "Rostad kyckling" because "ost" is a substring of
//     "Rostad". A properly itemized recipe should be judged on its ingredients
//     and tags, not on substrings of its name. But a title-only or
//     partially-itemized recipe (e.g. a URL import that only captured one
//     ingredient) still needs the title as a safety net — onboarding's
//     go-to-dish creates a title-only recipe when AI fill-in doesn't
//     complete, and a title-only "Fiskgratäng" must stay filtered for a
//     "fisk" avoid. Two itemized ingredients is the threshold for trusting
//     the ingredient list over the title.
// Substring matching is still crude on compound-word languages (see
// PLAN-ingrediens-taxonomi.md) — this only removes the *title* false positives
// for the common case where the recipe is properly itemized.
export function recipeMatchesAvoided(
  recipe: { title: string; tags: unknown; ingredients: unknown },
  avoidIngredients: string[],
): boolean {
  const avoided = avoidIngredients.map((a) => a.trim().toLowerCase()).filter((a) => a !== '')
  if (avoided.length === 0) return false
  const ingredientItems = readIngredientArray(recipe.ingredients)
    .map((i) => i.item.trim().toLowerCase())
    .filter((item) => item !== '')
  const haystacks = [...readStringArray(recipe.tags).map((t) => t.trim().toLowerCase())]
  haystacks.push(...ingredientItems)
  if (ingredientItems.length < 2) {
    haystacks.push(recipe.title.toLowerCase())
  }
  return avoided.some((lower) => haystacks.some((h) => h.includes(lower)))
}
