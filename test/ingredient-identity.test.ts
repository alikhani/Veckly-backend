import { describe, expect, it } from 'vitest'
import { canonicalIngredientItemKey, ingredientStateItemKeys, pantryCoversIngredient } from '../src/ingredient-identity.js'

describe('ingredient identity', () => {
  it('uses the shopping normalization for category, plural and unit', () => {
    expect(canonicalIngredientItemKey({ item: ' Tomatoes ', unit: 'PC', category: 'Other' })).toBe('produce:tomato:pc')
  })

  it('keeps legacy state keys compatible with pantry data already stored by clients', () => {
    const ingredient = { item: 'carrots', unit: 'pc', category: 'Other' }
    expect(ingredientStateItemKeys(ingredient)).toContain('other:carrots:pc')
    expect(pantryCoversIngredient(ingredient, { 'other:carrots:pc': 2 })).toBe(true)
  })
})
