import { normalizeIngredientCategory } from './ingredient-categories.js'

export type TIngredientIdentityInput = {
  item: string
  unit?: string | null
  category?: string | null
}

export function normalizeIngredientKeyPart(value: string | null | undefined) {
  return (value ?? '').trim().toLocaleLowerCase('sv-SE').replace(/\s+/g, '-')
}

export function singularizeIngredientName(value: string) {
  const normalized = value.trim().toLocaleLowerCase('sv-SE').replace(/\s+/g, ' ')
  if (normalized.endsWith('ies') && normalized.length > 4) return `${normalized.slice(0, -3)}y`
  if (normalized.endsWith('oes') && normalized.length > 4) return normalized.slice(0, -2)
  if (normalized.endsWith('s') && !normalized.endsWith('ss') && normalized.length > 3) return normalized.slice(0, -1)
  return normalized
}

export function ingredientItemKey(ingredient: TIngredientIdentityInput) {
  return [
    normalizeIngredientKeyPart(normalizeIngredientCategory(ingredient.item, ingredient.category)),
    normalizeIngredientKeyPart(ingredient.item),
    normalizeIngredientKeyPart(ingredient.unit),
  ].join(':')
}

export function canonicalIngredientItemKey(ingredient: TIngredientIdentityInput) {
  return [
    normalizeIngredientKeyPart(normalizeIngredientCategory(ingredient.item, ingredient.category)),
    normalizeIngredientKeyPart(singularizeIngredientName(ingredient.item)),
    normalizeIngredientKeyPart(ingredient.unit),
  ].join(':')
}

export function ingredientStateItemKeys(ingredient: TIngredientIdentityInput) {
  const legacyCategory = normalizeIngredientKeyPart(ingredient.category) || 'other'
  const rawItem = normalizeIngredientKeyPart(ingredient.item)
  const canonicalItem = normalizeIngredientKeyPart(singularizeIngredientName(ingredient.item))
  const unit = normalizeIngredientKeyPart(ingredient.unit)
  return new Set([
    ingredientItemKey(ingredient),
    canonicalIngredientItemKey(ingredient),
    [legacyCategory, rawItem, unit].join(':'),
    [legacyCategory, canonicalItem, unit].join(':'),
  ])
}

export function pantryCoversIngredient(ingredient: TIngredientIdentityInput, pantryStock: Record<string, number>) {
  return [...ingredientStateItemKeys(ingredient)].some((key) => (pantryStock[key] ?? 0) > 0)
}
