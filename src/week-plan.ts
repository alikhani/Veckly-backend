import { z } from '@hono/zod-openapi'
import {
  type TWeekContextOverride,
} from './planning-context.js'
import type { Db } from './db.js'
import {
  addDays,
  isMonday,
  requestToday,
} from './shared/week-dates.js'
import { recipeMatchesAvoided } from './shared/recipe-matching.js'
import {
  UpsertWeekHistoryPlanSchema,
  type TPreviousWeekProposalRequest,
  type TWeekRescueRequest,
} from './modules/week-plan/schemas.js'
import { emptyProjectionState, foldEventIntoProjection } from './modules/week-plan/projection.js'
import { deriveWeekExplanations } from './modules/week-plan/explanations.js'
import { deriveWeekRescuePreview } from './modules/week-plan/rescue.js'
import * as service from './modules/week-plan/service.js'
import * as serviceGenerate from './modules/week-plan/service-generate.js'

// Old positional signatures, kept only so test/week-plan.test.ts keeps
// compiling unchanged until the shim is removed. Everything else calls the
// `ctx`-based service functions directly.
export function getWeekContextOverrides(db: Db, accessToken: string, householdId: string, weekStartDate: string) {
  return service.getWeekContextOverrides({ db, accessToken, householdId }, weekStartDate)
}

export function upsertWeekContextOverride(db: Db, accessToken: string, userId: string, householdId: string, weekStartDate: string, date: string, override: TWeekContextOverride) {
  return service.upsertWeekContextOverride({ db, accessToken, userId, householdId }, weekStartDate, date, override)
}

export function clearWeekContextOverride(db: Db, accessToken: string, userId: string, householdId: string, weekStartDate: string, date: string) {
  return service.clearWeekContextOverride({ db, accessToken, userId, householdId }, weekStartDate, date)
}

export function listWeekHistoryPlans(db: Db, accessToken: string, householdId: string, range: { from?: string; to?: string }) {
  return service.listWeekHistoryPlans({ db, accessToken, householdId }, range)
}

export function getWeekHistoryPlan(db: Db, accessToken: string, householdId: string, weekStartDate: string) {
  return service.getWeekHistoryPlan({ db, accessToken, householdId }, weekStartDate)
}

export function upsertWeekHistoryPlan(db: Db, accessToken: string, userId: string, householdId: string, weekStartDate: string, input: z.infer<typeof UpsertWeekHistoryPlanSchema>) {
  return service.upsertWeekHistoryPlan({ db, accessToken, userId, householdId }, weekStartDate, input)
}

export function finalizeWeekHistoryPlan(db: Db, accessToken: string, userId: string, householdId: string, weekStartDate: string) {
  return service.finalizeWeekHistoryPlan({ db, accessToken, userId, householdId }, weekStartDate)
}

export function previewWeekRescue(db: Db, accessToken: string, householdId: string, weekStartDate: string, request: TWeekRescueRequest) {
  return service.previewWeekRescue({ db, accessToken, householdId }, weekStartDate, request)
}

export function applyWeekRescue(db: Db, accessToken: string, userId: string, householdId: string, weekStartDate: string, request: TWeekRescueRequest) {
  return service.applyWeekRescue({ db, accessToken, userId, householdId }, weekStartDate, request)
}

export function getWeekPlanSummary(db: Db, accessToken: string, householdId: string, weekStartDate: string) {
  return service.getWeekPlanSummary({ db, accessToken, householdId }, weekStartDate)
}

export function previewPreviousWeekProposal(db: Db, accessToken: string, userId: string, householdId: string, weekStartDate: string, request: TPreviousWeekProposalRequest) {
  return service.previewPreviousWeekProposal({ db, accessToken, userId, householdId }, weekStartDate, request)
}

export function applyPreviousWeekProposal(db: Db, accessToken: string, userId: string, householdId: string, weekStartDate: string, request: TPreviousWeekProposalRequest) {
  return service.applyPreviousWeekProposal({ db, accessToken, userId, householdId }, weekStartDate, request)
}

export function doGenerateWeekPlan(db: Db, accessToken: string, userId: string, householdId: string, weekStartDate: string, regenerate: boolean, today?: string, pantryItemKeys?: string[]) {
  return serviceGenerate.doGenerateWeekPlan({ db, accessToken, userId, householdId }, weekStartDate, regenerate, today, pantryItemKeys)
}

export { buildWeekPlanRoutes } from './modules/week-plan/index.js'

// Exported for tests that need to seed projection rows directly (bypassing
// appendWeekPlanEvent) to prove the read path reflects the projection, never a
// replay of the log.
export { foldEventIntoProjection, emptyProjectionState }
export type { TWeekPlanProjectionState } from './modules/week-plan/projection.js'

// Re-exported so existing importers keep working until the module split lands.
export { addDays, isMonday, recipeMatchesAvoided, requestToday }
export { deriveWeekExplanations, deriveWeekRescuePreview }
