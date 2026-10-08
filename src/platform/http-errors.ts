import { z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import type { Db } from '../db.js'
import { assertMembership } from '../membership.js'
import type { PremiumRequiredBody } from '../premium-gates.js'
import { isDateInWeek, isMonday } from '../shared/week-dates.js'

// --- Error contract ------------------------------------------------------------
//
// Every expected failure from a migrated module answers `{ error: ErrorCode }`.
// The enum is published in OpenAPI so the iOS client gets a typed code. Add a
// code here before throwing it; an unknown code is a compile error.

export const errorCodes = [
  'NOT_MEMBER',
  'HOUSEHOLD_NOT_FOUND',
  'WEEK_PLAN_NOT_FOUND',
  'SHOPPING_LIST_NOT_FOUND',
  'INVALID_JSON',
  'INVALID_REQUEST',
  'INVALID_WEEK_START_DATE',
  'INVALID_WEEK_CONTEXT_DATE',
  'INVALID_WEEK_RANGE',
  'NO_PLAN',
  'LOCKED_DAY',
  'NO_RESCUE_FOUND',
  'NO_COMPLETED_WEEK',
  'NO_RECIPES',
  'ALL_RECIPES_EXCLUDED',
  'STALE_WEEK_PLAN',
  'STALE_WEEK_PLAN_STATE',
  'STALE_SHOPPING_STATE',
] as const

export type ErrorCode = typeof errorCodes[number]

export const ErrorCodeSchema = z.enum(errorCodes).openapi('ErrorCode')

// A request that failed Zod validation lists what was wrong. Debugging aid
// only; clients branch on `error`, never on `issues`.
export const ValidationIssueSchema = z.object({
  code: z.string(),
  path: z.array(z.string()),
  message: z.string(),
}).openapi('ValidationIssue')

export const ErrorResponseSchema = z.object({
  error: ErrorCodeSchema,
  issues: z.array(ValidationIssueSchema).optional(),
}).openapi('ErrorResponse')

export type TValidationIssue = z.infer<typeof ValidationIssueSchema>
export type TErrorResponse = z.infer<typeof ErrorResponseSchema>

export type ApiErrorStatus = 400 | 403 | 404 | 409 | 422

// `defaultHook` for a migrated module's `OpenAPIHono`: a request that fails
// param, query, or body validation answers 400 INVALID_REQUEST instead of
// Zod's `{ success: false, error }`. Not-yet-migrated files keep Zod's format.
export function invalidRequestHook(result: { success: true } | { success: false; error: z.ZodError }, c: Context) {
  if (result.success) return
  const issues: TValidationIssue[] = result.error.issues.map((issue) => ({ code: issue.code, path: issue.path.map(String), message: issue.message }))
  return c.json({ error: 'INVALID_REQUEST', issues } satisfies TErrorResponse, 400)
}

// `responses` entries for `createRoute`: `errorResponses({ 404: 'Caller is not a member' })`.
export function errorResponses<const T extends Partial<Record<ApiErrorStatus, string>>>(descriptions: T) {
  const responses = {} as { [S in keyof T]: { description: string; content: { 'application/json': { schema: typeof ErrorResponseSchema } } } }
  for (const [status, description] of Object.entries(descriptions) as Array<[keyof T, string]>) {
    responses[status] = { description, content: { 'application/json': { schema: ErrorResponseSchema } } }
  }
  return responses
}

// Extra fields a few codes carry next to `error` (declared by their own
// response schemas, e.g. `StaleWeekHistoryPlanResponse`).
type ErrorDetails = { updatedAt?: string | null; issues?: TValidationIssue[] }

// A typed error a route (or the use case it calls) throws instead of
// returning an error response. `app.onError` in app.ts maps it to
// `c.json(err.body, err.status)`; sub-apps mounted with `app.route('/', ...)`
// have no `onError` of their own, so they inherit that single mapping.
export class ApiError extends Error {
  readonly body: Record<string, unknown>

  constructor(status: 403, gate: PremiumRequiredBody)
  constructor(status: ApiErrorStatus, code: ErrorCode, details?: ErrorDetails)
  constructor(readonly status: ApiErrorStatus, codeOrGate: ErrorCode | PremiumRequiredBody, details?: ErrorDetails) {
    const body = typeof codeOrGate === 'string' ? { error: codeOrGate, ...details } : codeOrGate
    super(body.error)
    this.body = body
  }
}

export type RequestContext = { db: Db; accessToken: string; userId: string; householdId: string }

// For reads and writes that never need the caller's own id. A full
// `RequestContext` satisfies it.
export type HouseholdScope = Pick<RequestContext, 'db' | 'accessToken' | 'householdId'>

// Called as the first line after `c.req.valid(...)` in every household route.
// An explicit helper and not middleware: middleware in @hono/zod-openapi runs
// BEFORE param validation, so an invalid householdId would reach the database.
export async function requireHouseholdMember(
  db: Db,
  ctx: { accessToken: string; userId: string },
  householdId: string,
): Promise<RequestContext> {
  const member = await assertMembership(db, ctx.accessToken, householdId, ctx.userId)
  if (!member) throw new ApiError(404, 'NOT_MEMBER')
  return { db, accessToken: ctx.accessToken, userId: ctx.userId, householdId }
}

export function requireMonday(date: string, error: { status: 400 | 422; code: ErrorCode }) {
  if (!isMonday(date)) throw new ApiError(error.status, error.code)
}

export function requireDateInWeek(weekStartDate: string, date: string, error: { status: 400 | 422; code: ErrorCode }) {
  if (!isDateInWeek(weekStartDate, date)) throw new ApiError(error.status, error.code)
}
