import { describe, expect, it } from 'vitest'
import { inferIngredientCategory, normalizeIngredientCategory } from '../src/ingredient-categories.js'

describe('ingredient category inference', () => {
  it.each([
    ['kycklingfilé', 'protein'],
    ['briochebröd', 'bakery'],
    ['Granny Smith-äpple', 'produce'],
    ['ca 3 msk smör', 'dairy'],
    ['majonnäs', 'pantry'],
    ['cosmopolitansallad', 'produce'],
    ['coconut milk', 'pantry'],
    ['peanut butter', 'pantry'],
    ['egg noodles', 'pantry'],
    ['breaded chicken', 'protein'],
  ] as const)('categorizes %s as %s', (name, category) => {
    expect(inferIngredientCategory(name)).toBe(category)
  })

  it('does not classify eggplant as dairy from the substring egg', () => {
    expect(inferIngredientCategory('eggplant')).toBe('produce')
  })

  it('does not classify rostad paprika as dairy from the substring ost', () => {
    expect(inferIngredientCategory('rostad paprika')).toBe('produce')
  })

  it('preserves a valid extractor category before applying inference', () => {
    expect(normalizeIngredientCategory('tomato', 'pantry')).toBe('pantry')
  })

  it('infers a category when the extractor category is absent or unknown', () => {
    expect(normalizeIngredientCategory('tomat', null)).toBe('produce')
    expect(normalizeIngredientCategory('chicken breast', 'meat-and-fish')).toBe('protein')
    expect(normalizeIngredientCategory('tomato', 'other')).toBe('produce')
    expect(normalizeIngredientCategory('mystery ingredient', 'other')).toBe('other')
  })
})
