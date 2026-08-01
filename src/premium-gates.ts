import type { ResolvedEntitlement } from './entitlements.js'

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

export function premiumRequired(reason: PremiumGateReason, usage?: { limit: number; current: number }): PremiumRequiredBody {
  return { error: 'PREMIUM_REQUIRED', reason, ...usage }
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

export function observePremiumGate(entitlement: ResolvedEntitlement, reason: PremiumGateReason) {
  const required = evaluatePremiumGate(entitlement, reason)
  if (required) console.info('[premium-gate] would block', required)
}
