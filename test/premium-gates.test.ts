import { describe, expect, it } from 'vitest'
import { evaluatePremiumGate, isPremiumLimitReached, premiumRequired, recordPremiumGateObservation } from '../src/premium-gates.js'
import type { Db } from '../src/db.js'

describe('premium gates', () => {
  it('is a no-op in shadow mode even for a free entitlement', () => {
    expect(evaluatePremiumGate(
      { tier: 'free', householdId: null, source: null, gatesEnabled: false },
      'custom_recipes_limit',
      { limit: 10, current: 10 },
    )).toBeNull()
  })

  it('returns the stable enforcement contract only when explicitly enabled', () => {
    expect(evaluatePremiumGate(
      { tier: 'free', householdId: null, source: null, gatesEnabled: true },
      'custom_recipes_limit',
      { limit: 10, current: 10 },
    )).toEqual({ error: 'PREMIUM_REQUIRED', reason: 'custom_recipes_limit', limit: 10, current: 10 })
  })

  it('never blocks a premium household', () => {
    expect(evaluatePremiumGate(
      { tier: 'premium', householdId: '11111111-1111-1111-1111-111111111111', source: 'beta', gatesEnabled: true },
      'household_invite',
    )).toBeNull()
  })

  it('constructs a reason-only contract for non-limit gates', () => {
    expect(premiumRequired('ai_recommendations')).toEqual({ error: 'PREMIUM_REQUIRED', reason: 'ai_recommendations' })
  })

  it('only reaches a limit at the boundary', () => {
    expect(isPremiumLimitReached({ limit: 10, current: 9 })).toBe(false)
    expect(isPremiumLimitReached({ limit: 10, current: 10 })).toBe(true)
  })

  it('never throws when shadow telemetry persistence fails', async () => {
    const failingDb = { insert: () => ({ values: async () => { throw new Error('database unavailable') } }) } as unknown as Db
    await expect(recordPremiumGateObservation(failingDb, {
      householdId: null,
      userId: '11111111-1111-1111-1111-111111111111',
      reason: 'saved_plans_limit',
      usage: { limit: 2, current: 2 },
    })).resolves.toBe(false)
  })
})
