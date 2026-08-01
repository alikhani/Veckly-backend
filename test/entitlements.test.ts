import { describe, expect, it } from 'vitest'
import { premiumGatesEnabled, resolveEntitlement, type EntitlementCandidate } from '../src/entitlements.js'

const now = new Date('2026-08-01T12:00:00.000Z')
const householdA = '11111111-1111-1111-1111-111111111111'
const householdB = '22222222-2222-2222-2222-222222222222'

function candidate(overrides: Partial<EntitlementCandidate> = {}): EntitlementCandidate {
  return {
    householdId: householdA,
    source: 'subscription',
    startsAt: new Date('2026-07-01T00:00:00.000Z'),
    endsAt: null,
    revokedAt: null,
    subscriptionStatus: 'active',
    subscriptionPeriodEndsAt: new Date('2026-08-31T00:00:00.000Z'),
    ...overrides,
  }
}

describe('provider-neutral entitlement resolver', () => {
  it('defaults to free and keeps enforcement disabled', () => {
    expect(resolveEntitlement([householdA], [], now)).toEqual({ tier: 'free', householdId: null, source: null, gatesEnabled: false })
    expect(premiumGatesEnabled).toBe(false)
  })

  it('resolves an active sponsored subscription as premium', () => {
    expect(resolveEntitlement([householdA], [candidate()], now)).toMatchObject({ tier: 'premium', householdId: householdA, source: 'subscription' })
  })

  it('resolves beta grants through the same path', () => {
    expect(resolveEntitlement([householdA], [candidate({ source: 'beta', subscriptionStatus: null, subscriptionPeriodEndsAt: null })], now)).toMatchObject({ tier: 'premium', source: 'beta' })
  })

  it('keeps grace-period sponsorship active', () => {
    expect(resolveEntitlement([householdA], [candidate({ subscriptionStatus: 'grace_period', subscriptionPeriodEndsAt: new Date('2026-07-31T00:00:00.000Z') })], now)).toMatchObject({ tier: 'premium' })
  })

  it.each(['expired', 'cancelled', 'revoked'] as const)('does not grant premium for a %s subscription', (subscriptionStatus) => {
    expect(resolveEntitlement([householdA], [candidate({ subscriptionStatus })], now).tier).toBe('free')
  })

  it('does not grant premium after a grant expires or is revoked', () => {
    expect(resolveEntitlement([householdA], [candidate({ source: 'beta', subscriptionStatus: null, subscriptionPeriodEndsAt: null, endsAt: now })], now).tier).toBe('free')
    expect(resolveEntitlement([householdA], [candidate({ source: 'manual', subscriptionStatus: null, subscriptionPeriodEndsAt: null, revokedAt: now })], now).tier).toBe('free')
  })

  it('does not leak sponsorship after a household change', () => {
    expect(resolveEntitlement([householdB], [candidate()], now).tier).toBe('free')
    expect(resolveEntitlement([householdA, householdB], [candidate({ householdId: householdB })], now)).toMatchObject({ tier: 'premium', householdId: householdB })
  })

  it('requires the target household to be an active membership before evaluating its sponsorship', () => {
    const sponsoredB = candidate({ householdId: householdB })
    expect(resolveEntitlement([], [sponsoredB], now).tier).toBe('free')
    expect(resolveEntitlement([householdA], [sponsoredB], now).tier).toBe('free')
  })
})
