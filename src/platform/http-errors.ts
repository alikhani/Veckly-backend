import type { Db } from '../db.js'
import { assertMembership } from '../membership.js'
import { isDateInWeek, isMonday } from '../shared/week-dates.js'

// A typed error a route (or the use case it calls) throws instead of
// returning an error response. `app.onError` in app.ts maps it to
// `c.json(err.body, err.status)`; sub-apps mounted with `app.route('/', ...)`
// have no `onError` of their own, so they inherit that single mapping.
export class ApiError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 422, readonly body: Record<string, unknown>) {
    super(String(body.error ?? 'API_ERROR'))
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
  if (!member) throw new ApiError(404, { error: 'NOT_MEMBER' })
  return { db, accessToken: ctx.accessToken, userId: ctx.userId, householdId }
}

export function requireMonday(date: string, error: { status: 400 | 422; code: string }) {
  if (!isMonday(date)) throw new ApiError(error.status, { error: error.code })
}

export function requireDateInWeek(weekStartDate: string, date: string, error: { status: 400 | 422; code: string }) {
  if (!isDateInWeek(weekStartDate, date)) throw new ApiError(error.status, { error: error.code })
}
