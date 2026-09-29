import { describe, expect, it } from 'vitest'
import { cookedRecipeIdFromOutcome, detectConfirmedFatiguedMeals, resolveMealHistory } from '../src/meal-history.js'

describe('outcome-aware meal history', () => {
  it('maps cooked and known replacements to the recipe that was actually cooked', () => {
    expect(cookedRecipeIdFromOutcome({
      weekStartDate: '2026-09-07',
      plannedRecipeId: 'planned',
      status: 'cooked',
      actualRecipeId: null,
    })).toBe('planned')
    expect(cookedRecipeIdFromOutcome({
      weekStartDate: '2026-09-07',
      plannedRecipeId: 'planned',
      status: 'changed_plan',
      actualRecipeId: 'replacement',
    })).toBe('replacement')
  })

  it('does not count skipped or unknown changed plans as cooked', () => {
    expect(cookedRecipeIdFromOutcome({
      weekStartDate: '2026-09-07',
      plannedRecipeId: 'planned',
      status: 'skipped',
      actualRecipeId: null,
    })).toBeNull()
    expect(cookedRecipeIdFromOutcome({
      weekStartDate: '2026-09-07',
      plannedRecipeId: 'planned',
      status: 'changed_plan',
      actualRecipeId: null,
    })).toBeNull()
  })

  it('uses plan assignments only for whole weeks without outcome data', () => {
    const history = resolveMealHistory([
      { weekStartDate: '2026-09-07', mealIds: ['legacy-planned'] },
      { weekStartDate: '2026-09-14', mealIds: ['planned-but-skipped', 'unrecorded-plan'] },
    ], [
      {
        weekStartDate: '2026-09-14',
        plannedRecipeId: 'planned-but-skipped',
        status: 'skipped',
        actualRecipeId: null,
      },
    ])

    expect(history.scoringRecords).toEqual([
      { weekStartDate: '2026-09-07', mealIds: ['legacy-planned'] },
      { weekStartDate: '2026-09-14', mealIds: [] },
    ])
    expect(history.confirmedRecords).toEqual([{ weekStartDate: '2026-09-14', mealIds: [] }])
    expect(history.legacyPlannedRecords).toEqual([{ weekStartDate: '2026-09-07', mealIds: ['legacy-planned'] }])
  })

  it('includes an outcome-only week and attributes a replacement to its actual recipe', () => {
    const history = resolveMealHistory([], [{
      weekStartDate: '2026-09-21',
      plannedRecipeId: 'planned',
      status: 'changed_plan',
      actualRecipeId: 'replacement',
    }])

    expect(history.scoringRecords).toEqual([{ weekStartDate: '2026-09-21', mealIds: ['replacement'] }])
    expect(history.confirmedRecords).toEqual(history.scoringRecords)
    expect(history.legacyPlannedRecords).toEqual([])
  })

  it('only exposes fatigue when the recent timeline is continuously confirmed', () => {
    const dates = ['2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21']
    const confirmed = [
      { weekStartDate: dates[0]!, mealIds: ['pasta'] },
      { weekStartDate: dates[1]!, mealIds: ['pasta'] },
      { weekStartDate: dates[2]!, mealIds: ['pasta'] },
      { weekStartDate: dates[3]!, mealIds: [] },
      { weekStartDate: dates[4]!, mealIds: [] },
    ]

    expect(detectConfirmedFatiguedMeals(dates, confirmed)).toEqual(['pasta'])
    expect(detectConfirmedFatiguedMeals(dates, confirmed.filter((record) => record.weekStartDate !== dates[3]))).toEqual([])
  })
})
