import { describe, expect, it } from 'vitest'
import { WeekContextOverrideSchema, mergeDayPlanningContext } from '../src/planning-context.js'

describe('mergeDayPlanningContext', () => {
  it('requires an override to contain at least one explicit value', () => {
    expect(WeekContextOverrideSchema.safeParse({}).success).toBe(false)
    expect(WeekContextOverrideSchema.safeParse({ lateEvening: false }).success).toBe(true)
  })

  it('uses week-specific values before household defaults', () => {
    expect(mergeDayPlanningContext(
      {
        day: 'tuesday',
        effortLevel: 'standard',
        lateEvening: true,
        leftoversIntent: true,
        servingsOverride: 4,
      },
      {
        effortLevel: 'busy',
        lateEvening: false,
        servingsOverride: 6,
      },
    )).toEqual({
      day: 'tuesday',
      effortLevel: 'busy',
      lateEvening: false,
      leftoversIntent: true,
      servingsOverride: 6,
    })
  })

  it('falls back to the household day when no override exists', () => {
    const householdDefault = { day: 'friday' as const, occasion: 'treat' as const }

    expect(mergeDayPlanningContext(householdDefault, undefined)).toEqual(householdDefault)
  })

  it('returns no context when neither layer exists', () => {
    expect(mergeDayPlanningContext(undefined, undefined)).toBeUndefined()
  })
})
