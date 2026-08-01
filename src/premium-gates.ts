import type { ResolvedEntitlement } from './entitlements.js'
import type { Db } from './db.js'
import { premiumGateObservations } from './schema.js'
import { z } from '@hono/zod-openapi'

// Kept aligned with the existing web premium surfaces. This vocabulary is an
// API contract: clients can render context-specific upgrade copy without
// interpreting provider state or inventing per-platform reason strings.
export const premiumGateReasons = [
  'household_invite',
  'week_generation_limit',
  'recipe_ai_fill_in',
  'ai_recommendations',
  'custom_recipes_limit',
  'week_history',
  'saved_plans_limit',
  'community_share',
] as const

export type PremiumGateReason = typeof premiumGateReasons[number]

export type PremiumRequiredBody = {
  error: 'PREMIUM_REQUIRED'
  reason: PremiumGateReason
  limit?: number
  current?: number
}

export const PremiumRequiredResponseSchema = z.object({
  error: z.literal('PREMIUM_REQUIRED'),
  reason: z.enum(premiumGateReasons),
  limit: z.number().int().optional(),
  current: z.number().int().optional(),
}).openapi('PremiumRequiredResponse')

export function premiumRequired(reason: PremiumGateReason, usage?: { limit: number; current: number }): PremiumRequiredBody {
  return { error: 'PREMIUM_REQUIRED', reason, ...usage }
}

export function isPremiumLimitReached(usage: { limit: number; current: number }) {
  return usage.current >= usage.limit
}

// Phase 2 is shadow mode. Later routes call this after authorize and before
// repository work; only an explicitly enabled server flag may turn a free
// household into the stable 403 body below.
export function evaluatePremiumGate(
  entitlement: ResolvedEntitlement,
  reason: PremiumGateReason,
  usage?: { limit: number; current: number },
): PremiumRequiredBody | null {
  if (!entitlement.gatesEnabled || entitlement.tier === 'premium') return null
  return premiumRequired(reason, usage)
}

export async function recordPremiumGateObservation(db: Db, input: { householdId: string | null; userId: string; reason: PremiumGateReason; usage?: { limit: number; current: number } }) {
  try {
    await db.insert(premiumGateObservations).values({ householdId: input.householdId, userId: input.userId, reason: input.reason, limitValue: input.usage?.limit ?? null, currentValue: input.usage?.current ?? null })
    return true
  } catch (error) {
    // Shadow analytics must never turn a valid product action into a 500.
    console.error('[premium-gate] failed to persist observation', error)
    return false
  }
}

export async function observePremiumGate(
  db: Db,
  entitlement: ResolvedEntitlement,
  input: { householdId: string | null; userId: string; reason: PremiumGateReason; usage?: { limit: number; current: number } },
) {
  if (entitlement.tier === 'premium') return null
  console.info('[premium-gate] would block', premiumRequired(input.reason, input.usage))
  await recordPremiumGateObservation(db, input)
  return evaluatePremiumGate(entitlement, input.reason, input.usage)
}
