import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from './db.js'
import { billingSubscriptions, householdEntitlements, householdMemberships } from './schema.js'

export const premiumGatesEnabled = process.env.PREMIUM_GATES_ENABLED === 'true'

type SubscriptionStatus = 'active' | 'grace_period' | 'expired' | 'cancelled' | 'revoked'
type EntitlementSource = 'subscription' | 'manual' | 'beta'

export type EntitlementCandidate = {
  householdId: string
  source: EntitlementSource
  startsAt: Date
  endsAt: Date | null
  revokedAt: Date | null
  subscriptionStatus: SubscriptionStatus | null
  subscriptionPeriodEndsAt: Date | null
}

export type ResolvedEntitlement = {
  tier: 'free' | 'premium'
  householdId: string | null
  source: EntitlementSource | null
  gatesEnabled: boolean
}

function isCandidateActive(candidate: EntitlementCandidate, now: Date) {
  if (candidate.startsAt > now || candidate.revokedAt !== null) return false
  if (candidate.endsAt !== null && candidate.endsAt <= now) return false
  if (candidate.source !== 'subscription') return true
  if (candidate.subscriptionStatus !== 'active' && candidate.subscriptionStatus !== 'grace_period') return false
  return candidate.subscriptionPeriodEndsAt === null || candidate.subscriptionPeriodEndsAt > now || candidate.subscriptionStatus === 'grace_period'
}

// This is intentionally pure: provider adapters only normalize records, and
// every later gate/read route gets exactly the same household decision.
export function resolveEntitlement(
  activeHouseholdIds: readonly string[],
  candidates: readonly EntitlementCandidate[],
  now = new Date(),
): ResolvedEntitlement {
  const activeIds = new Set(activeHouseholdIds)
  const candidate = candidates.find((item) => activeIds.has(item.householdId) && isCandidateActive(item, now))
  return candidate
    ? { tier: 'premium', householdId: candidate.householdId, source: candidate.source, gatesEnabled: premiumGatesEnabled }
    : { tier: 'free', householdId: null, source: null, gatesEnabled: premiumGatesEnabled }
}

export async function resolveEntitlementForUser(db: Db, userId: string, now = new Date()): Promise<ResolvedEntitlement> {
  const memberships = await db
    .select({ householdId: householdMemberships.householdId })
    .from(householdMemberships)
    .where(and(eq(householdMemberships.userId, userId), eq(householdMemberships.status, 'active')))
  const householdIds = memberships.map((membership) => membership.householdId)
  if (householdIds.length === 0) return resolveEntitlement([], [], now)

  const rows = await db
    .select({
      householdId: householdEntitlements.householdId,
      source: householdEntitlements.source,
      startsAt: householdEntitlements.startsAt,
      endsAt: householdEntitlements.endsAt,
      revokedAt: householdEntitlements.revokedAt,
      subscriptionStatus: billingSubscriptions.status,
      subscriptionPeriodEndsAt: billingSubscriptions.currentPeriodEndsAt,
    })
    .from(householdEntitlements)
    .leftJoin(billingSubscriptions, eq(householdEntitlements.subscriptionId, billingSubscriptions.id))
    .where(inArray(householdEntitlements.householdId, householdIds))

  return resolveEntitlement(householdIds, rows, now)
}

// Household routes must call this rather than the user aggregate above: a
// premium sponsorship for household A must never unlock a gated action in the
// same user's household B. The membership predicate is deliberately part of
// the lookup, even though RLS protects routes too, so the resolver remains a
// safe boundary when used by a future server-side gate.
export async function resolveEntitlementForHousehold(
  db: Db,
  userId: string,
  householdId: string,
  now = new Date(),
): Promise<ResolvedEntitlement> {
  const [membership] = await db
    .select({ householdId: householdMemberships.householdId })
    .from(householdMemberships)
    .where(and(
      eq(householdMemberships.userId, userId),
      eq(householdMemberships.householdId, householdId),
      eq(householdMemberships.status, 'active'),
    ))
  if (!membership) return resolveEntitlement([], [], now)

  const rows = await db
    .select({
      householdId: householdEntitlements.householdId,
      source: householdEntitlements.source,
      startsAt: householdEntitlements.startsAt,
      endsAt: householdEntitlements.endsAt,
      revokedAt: householdEntitlements.revokedAt,
      subscriptionStatus: billingSubscriptions.status,
      subscriptionPeriodEndsAt: billingSubscriptions.currentPeriodEndsAt,
    })
    .from(householdEntitlements)
    .leftJoin(billingSubscriptions, eq(householdEntitlements.subscriptionId, billingSubscriptions.id))
    .where(eq(householdEntitlements.householdId, householdId))

  return resolveEntitlement([householdId], rows, now)
}

export async function grantHouseholdEntitlement(
  db: Db,
  input: {
    householdId: string
    source: 'manual' | 'beta'
    startsAt?: Date
    endsAt?: Date | null
    grantedBy?: string
    metadata?: Record<string, unknown>
  },
) {
  const [grant] = await db.insert(householdEntitlements).values({
    householdId: input.householdId,
    source: input.source,
    startsAt: input.startsAt ?? new Date(),
    endsAt: input.endsAt ?? null,
    grantedBy: input.grantedBy ?? null,
    metadata: input.metadata ?? {},
  }).returning()
  if (!grant) throw new Error('Entitlement grant insert did not return a row')
  return grant
}
