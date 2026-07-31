export const INGREDIENT_CATEGORIES = ['produce', 'protein', 'dairy', 'pantry', 'frozen', 'bakery', 'other'] as const

export type TIngredientCategory = typeof INGREDIENT_CATEGORIES[number]

const CATEGORY_ALIASES: Record<string, TIngredientCategory> = {
  bakery: 'bakery',
  bread: 'bakery',
  dairy: 'dairy',
  fish: 'protein',
  frozen: 'frozen',
  fruit: 'produce',
  meat: 'protein',
  other: 'other',
  pantry: 'pantry',
  produce: 'produce',
  protein: 'protein',
  seafood: 'protein',
  vegetable: 'produce',
}

const PHRASE_KEYWORDS: ReadonlyArray<readonly [TIngredientCategory, readonly string[]]> = [
  ['pantry', ['coconut milk', 'egg noodle', 'egg noodles', 'peanut butter', 'tomato paste']],
  ['protein', ['breaded chicken', 'chicken breast']],
  ['produce', ['bean sprout', 'bell pepper', 'granny smith', 'sweet potato']],
]

const CATEGORY_KEYWORDS: ReadonlyArray<readonly [TIngredientCategory, readonly string[]]> = [
  ['frozen', ['frozen', 'fryst', 'frysta']],
  ['protein', ['bacon', 'beef', 'chicken', 'fish', 'fläsk', 'guanciale', 'ham', 'kalkon', 'korv', 'kyckling', 'kött', 'köttfärs', 'lamb', 'lax', 'mince', 'nötfärs', 'pancetta', 'pork', 'räka', 'räkor', 'salmon', 'sausage', 'seafood', 'skinka', 'shrimp', 'tofu', 'torsk', 'turkey']],
  ['produce', ['apple', 'apelsin', 'aubergine', 'avocado', 'banana', 'basil', 'bean sprout', 'bell pepper', 'broccoli', 'cabbage', 'carrot', 'chili', 'citron', 'cucumber', 'dill', 'eggplant', 'garlic', 'ginger', 'gurka', 'herb', 'koriander', 'leek', 'lemon', 'lime', 'lök', 'majs', 'morot', 'morötter', 'mushroom', 'onion', 'paprika', 'persilja', 'potatis', 'potato', 'rödlök', 'sallad', 'salad', 'spenat', 'spinach', 'svamp', 'sweet potato', 'tomat', 'tomato', 'vitlök', 'zucchini', 'äpple']],
  ['dairy', ['butter', 'cheese', 'cream', 'crème', 'egg', 'eggs', 'feta', 'grädde', 'halloumi', 'milk', 'mozzarella', 'ost', 'parmesan', 'smör', 'yoghurt', 'yogurt', 'ägg']],
  ['bakery', ['bagel', 'baguette', 'brioche', 'bread', 'bröd', 'bun', 'flatbread', 'naan', 'pita', 'roll', 'tortilla']],
  ['pantry', ['bean', 'böna', 'buljong', 'chickpea', 'choklad', 'coconut milk', 'corn', 'flour', 'fond', 'honey', 'kikärt', 'lentil', 'lins', 'majonnäs', 'mayonnaise', 'mjöl', 'mustard', 'noodle', 'nut', 'oil', 'olja', 'pasta', 'pepper', 'rice', 'ris', 'risoni', 'salt', 'sauce', 'senap', 'soja', 'soy', 'spaghetti', 'spice', 'sugar', 'tabasco', 'tomato paste', 'vinäger', 'vinegar']],
]

function normalized(value: string | null | undefined) {
  return (value ?? '').trim().toLocaleLowerCase('sv-SE')
}

export function inferIngredientCategory(name: string): TIngredientCategory {
  const normalizedName = normalized(name)
  const tokens = normalizedName.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  for (const [category, keywords] of PHRASE_KEYWORDS) {
    if (keywords.some((keyword) => ` ${normalizedName} `.includes(` ${keyword} `))) return category
  }
  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    if (keywords.some((keyword) => {
      if (keyword.includes(' ')) return ` ${normalizedName} `.includes(` ${keyword} `)
      return tokens.some((token) => token === keyword || (keyword.length >= 5 && token.includes(keyword)))
    })) return category
  }
  return 'other'
}

export function normalizeIngredientCategory(
  name: string,
  category: string | null | undefined,
): string {
  const normalizedCategory = normalized(category)
  const mapped = CATEGORY_ALIASES[normalizedCategory]
  if (mapped === 'other') {
    const inferred = inferIngredientCategory(name)
    return inferred === 'other' ? 'other' : inferred
  }
  if (mapped) return mapped === normalizedCategory ? category!.trim() : mapped
  return inferIngredientCategory(name)
}

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

export function readRecipeIngredients<T extends { item: string; category?: string | null } = { item: string; category?: string | null }>(
  value: unknown,
): T[] {
  return readJsonArray(value).filter((item): item is T =>
    Boolean(item && typeof item === 'object' && 'item' in item && typeof item.item === 'string'),
  )
}

export function categorizeRecipeIngredients<T extends { item: string; category?: string | null }>(
  ingredients: unknown,
): Array<Omit<T, 'category'> & { category: string }> {
  return readRecipeIngredients<T>(ingredients).map((ingredient) => ({
    ...ingredient,
    category: normalizeIngredientCategory(ingredient.item, ingredient.category),
  }))
}
