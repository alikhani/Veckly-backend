import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { requireAuth, type AuthedUser } from '../../auth.js'
import type { Db } from '../../db.js'
import type { PersistedStreamEvent, PersistedStreamProjection } from '../../event-stream.js'
import { WeekContextOverrideSchema } from '../../planning-context.js'
import { ApiError, errorResponses, invalidRequestHook, requireDateInWeek, requireHouseholdMember, requireMonday, type ErrorCode } from '../../platform/http-errors.js'
import { PremiumRequiredResponseSchema } from '../../premium-gates.js'
import { requestToday } from '../../shared/week-dates.js'
import {
  AppendWeekPlanEventRequestSchema,
  CausedBySchema,
  ClearWeekContextOverrideResponseSchema,
  ContextOverrideParamsSchema,
  FinalizeWeekHistoryPlanResponseSchema,
  GenerateWeekPlanErrorSchema,
  GenerateWeekPlanRequestSchema,
  GenerateWeekPlanResponseSchema,
  HouseholdParamsSchema,
  ParamsSchema,
  PreviousWeekProposalApplyResponseSchema,
  PreviousWeekProposalErrorSchema,
  PreviousWeekProposalRequestSchema,
  PreviousWeekProposalSchema,
  StaleWeekHistoryPlanResponseSchema,
  UpsertWeekHistoryPlanResponseSchema,
  UpsertWeekHistoryPlanSchema,
  WeekContextOverrideItemSchema,
  WeekContextOverridesResponseSchema,
  WeekHistoryDetailSchema,
  WeekHistoryListItemSchema,
  WeekHistoryQuerySchema,
  WeekPlanEventPayloadSchema,
  WeekPlanEventSchema,
  WeekPlanEventTypeSchema,
  WeekPlanProjectionSchema,
  WeekPlanSummarySchema,
  WeekRescueApplyResponseSchema,
  WeekRescueErrorSchema,
  WeekRescuePreviewSchema,
  WeekRescueRequestSchema,
} from './schemas.js'
import {
  applyPreviousWeekProposal,
  applyWeekRescue,
  clearWeekContextOverride,
  finalizeWeekHistoryPlan,
  getWeekContextOverrides,
  getWeekHistoryPlan,
  getWeekPlan,
  getWeekPlanSummary,
  listWeekHistory,
  previewPreviousWeekProposal,
  previewWeekRescue,
  recordWeekPlanEvent,
  upsertWeekContextOverride,
  upsertWeekHistoryPlan,
} from './service.js'
import { generateWeek } from './service-generate.js'

// --- Routes ------------------------------------------------------------------
//
// The transactional append-and-fold mechanism (read latest sequence number,
// insert the event, fold it into the projection, upsert — all in one `withRls`
// transaction) now lives in `event-stream.ts` as `appendStreamEvent`.
// Shopping-list's stream is the second instance that proved it's genuinely
// shared: the two were byte-identical in shape, differing only in their
// tables and fold function. See that module's comment for why the table
// arguments are duck-typed rather than fought into Drizzle's generics.

const appendWeekPlanEventRoute = createRoute({
  method: 'post',
  path: '/households/{householdId}/week-plans/{weekStartDate}/events',
  operationId: 'appendWeekPlanEvent',
  summary: 'Append an event to a household week plan',
  security: [{ bearerAuth: [] }],
  request: {
    params: ParamsSchema,
    body: { content: { 'application/json': { schema: AppendWeekPlanEventRequestSchema } } },
  },
  responses: {
    201: {
      description: 'The persisted event',
      content: { 'application/json': { schema: WeekPlanEventSchema } },
    },
    401: { description: 'Missing or invalid session' },
  },
})

const getWeekPlanRoute = createRoute({
  method: 'get',
  path: '/households/{householdId}/week-plans/{weekStartDate}',
  operationId: 'getWeekPlan',
  summary: "Read a household week plan's current state",
  security: [{ bearerAuth: [] }],
  request: { params: ParamsSchema },
  responses: {
    200: {
      description: 'The current materialized projection for this week',
      content: { 'application/json': { schema: WeekPlanProjectionSchema } },
    },
    404: { description: "The week hasn't started yet — no projection exists" },
    401: { description: 'Missing or invalid session' },
  },
})

const getWeekPlanSummaryRoute = createRoute({
  method: 'get',
  path: '/households/{householdId}/week-plans/{weekStartDate}/summary',
  operationId: 'getWeekPlanSummary',
  summary: "Read a household week plan as an iOS-friendly hydrated summary",
  security: [{ bearerAuth: [] }],
  request: { params: ParamsSchema },
  responses: {
    200: {
      description: 'The current week plan summary. Missing projections return an empty week.',
      content: { 'application/json': { schema: WeekPlanSummarySchema } },
    },
    404: { description: 'Household not found or caller is not a member' },
    401: { description: 'Missing or invalid session' },
  },
})

const previewWeekRescueRoute = createRoute({
  method: 'post',
  path: '/households/{householdId}/week-plans/{weekStartDate}/rescue/preview',
  operationId: 'previewWeekRescue',
  summary: 'Preview one concrete rescue for a disrupted dinner plan',
  security: [{ bearerAuth: [] }],
  request: {
    params: ParamsSchema,
    body: { content: { 'application/json': { schema: WeekRescueRequestSchema } } },
  },
  responses: {
    200: { description: 'A non-mutating rescue preview', content: { 'application/json': { schema: WeekRescuePreviewSchema } } },
    409: { description: 'The plan changed since the request was created', content: { 'application/json': { schema: WeekRescueErrorSchema } } },
    422: { description: 'No safe rescue is available', content: { 'application/json': { schema: WeekRescueErrorSchema } } },
    401: { description: 'Missing or invalid session' },
    404: { description: 'Household not found or caller is not a member' },
  },
})

const applyWeekRescueRoute = createRoute({
  method: 'post',
  path: '/households/{householdId}/week-plans/{weekStartDate}/rescue/apply',
  operationId: 'applyWeekRescue',
  summary: 'Apply a previously previewed rescue idempotently',
  security: [{ bearerAuth: [] }],
  request: {
    params: ParamsSchema,
    body: { content: { 'application/json': { schema: WeekRescueRequestSchema } } },
  },
  responses: {
    200: { description: 'The rescue was applied or had already been applied', content: { 'application/json': { schema: WeekRescueApplyResponseSchema } } },
    409: { description: 'The plan changed since preview', content: { 'application/json': { schema: WeekRescueErrorSchema } } },
    422: { description: 'No safe rescue is available', content: { 'application/json': { schema: WeekRescueErrorSchema } } },
    401: { description: 'Missing or invalid session' },
    404: { description: 'Household not found or caller is not a member' },
  },
})

const previewPreviousWeekProposalRoute = createRoute({
  method: 'post',
  path: '/households/{householdId}/week-plans/{weekStartDate}/previous-week/preview',
  operationId: 'previewPreviousWeekProposal',
  summary: 'Preview an improved reuse of the latest completed week',
  security: [{ bearerAuth: [] }],
  request: {
    params: ParamsSchema,
    body: { content: { 'application/json': { schema: PreviousWeekProposalRequestSchema } } },
  },
  responses: {
    200: { description: 'A non-mutating improved-week proposal', content: { 'application/json': { schema: PreviousWeekProposalSchema } } },
    409: { description: 'The target week changed since the request was created', content: { 'application/json': { schema: PreviousWeekProposalErrorSchema } } },
    422: { description: 'No completed week or safe recipe pool is available', content: { 'application/json': { schema: PreviousWeekProposalErrorSchema } } },
    401: { description: 'Missing or invalid session' },
    404: { description: 'Household not found or caller is not a member' },
  },
})

const applyPreviousWeekProposalRoute = createRoute({
  method: 'post',
  path: '/households/{householdId}/week-plans/{weekStartDate}/previous-week/apply',
  operationId: 'applyPreviousWeekProposal',
  summary: 'Apply an improved previous-week proposal idempotently',
  security: [{ bearerAuth: [] }],
  request: {
    params: ParamsSchema,
    body: { content: { 'application/json': { schema: PreviousWeekProposalRequestSchema } } },
  },
  responses: {
    200: { description: 'The proposal was applied or had already been applied', content: { 'application/json': { schema: PreviousWeekProposalApplyResponseSchema } } },
    409: { description: 'The target week changed since preview', content: { 'application/json': { schema: PreviousWeekProposalErrorSchema } } },
    422: { description: 'No completed week or safe recipe pool is available', content: { 'application/json': { schema: PreviousWeekProposalErrorSchema } } },
    401: { description: 'Missing or invalid session' },
    404: { description: 'Household not found or caller is not a member' },
  },
})

const getWeekContextOverridesRoute = createRoute({
  method: 'get',
  path: '/households/{householdId}/week-plans/{weekStartDate}/context-overrides',
  operationId: 'getWeekContextOverrides',
  summary: 'Read date-specific planning context for one week',
  security: [{ bearerAuth: [] }],
  request: { params: ParamsSchema },
  responses: {
    200: {
      description: 'The explicit overrides saved for this week',
      content: { 'application/json': { schema: WeekContextOverridesResponseSchema } },
    },
    400: { description: 'Invalid week start date' },
    401: { description: 'Missing or invalid session' },
    404: { description: 'Household not found or caller is not a member' },
  },
})

const upsertWeekContextOverrideRoute = createRoute({
  method: 'put',
  path: '/households/{householdId}/week-plans/{weekStartDate}/context-overrides/{date}',
  operationId: 'upsertWeekContextOverride',
  summary: 'Create or replace date-specific planning context for one week',
  security: [{ bearerAuth: [] }],
  request: {
    params: ContextOverrideParamsSchema,
    body: { content: { 'application/json': { schema: WeekContextOverrideSchema } } },
  },
  responses: {
    200: {
      description: 'The saved override',
      content: { 'application/json': { schema: WeekContextOverrideItemSchema } },
    },
    400: { description: 'Invalid week or date' },
    401: { description: 'Missing or invalid session' },
    404: { description: 'Household not found or caller is not a member' },
  },
})

const clearWeekContextOverrideRoute = createRoute({
  method: 'delete',
  path: '/households/{householdId}/week-plans/{weekStartDate}/context-overrides/{date}',
  operationId: 'clearWeekContextOverride',
  summary: 'Clear date-specific planning context for one week',
  security: [{ bearerAuth: [] }],
  request: { params: ContextOverrideParamsSchema },
  responses: {
    200: {
      description: 'The override was cleared',
      content: { 'application/json': { schema: ClearWeekContextOverrideResponseSchema } },
    },
    400: { description: 'Invalid week or date' },
    401: { description: 'Missing or invalid session' },
    404: { description: 'Household not found or caller is not a member' },
  },
})

const listWeekHistoryPlansRoute = createRoute({
  method: 'get',
  path: '/households/{householdId}/week-plans',
  operationId: 'listWeekHistoryPlans',
  summary: "List a household's persisted week plans",
  security: [{ bearerAuth: [] }],
  request: { params: HouseholdParamsSchema, query: WeekHistoryQuerySchema },
  responses: {
    200: {
      description: 'Week plans ordered by week start date descending',
      content: { 'application/json': { schema: z.array(WeekHistoryListItemSchema) } },
    },
    403: { description: 'Premium is required for older history', content: { 'application/json': { schema: PremiumRequiredResponseSchema } } },
    404: { description: 'Household not found or caller is not a member' },
    400: { description: 'Invalid range' },
    401: { description: 'Missing or invalid session' },
  },
})

const getWeekHistoryPlanRoute = createRoute({
  method: 'get',
  path: '/households/{householdId}/week-plans/{weekStartDate}/history',
  operationId: 'getWeekHistoryPlan',
  summary: 'Get persisted week-plan history metadata and state',
  security: [{ bearerAuth: [] }],
  request: { params: ParamsSchema },
  responses: {
    200: {
      description: 'The persisted week plan, or null when absent',
      content: { 'application/json': { schema: WeekHistoryDetailSchema } },
    },
    400: { description: 'Invalid week start date' },
    401: { description: 'Missing or invalid session' },
    ...errorResponses({ 404: 'Caller is not a member of the household' }),
  },
})

const upsertWeekHistoryPlanRoute = createRoute({
  method: 'patch',
  path: '/households/{householdId}/week-plans/{weekStartDate}/history',
  operationId: 'upsertWeekHistoryPlan',
  summary: 'Persist or update week-plan history state',
  security: [{ bearerAuth: [] }],
  request: {
    params: ParamsSchema,
    body: { content: { 'application/json': { schema: UpsertWeekHistoryPlanSchema } } },
  },
  responses: {
    200: {
      description: 'Week history plan persisted',
      content: { 'application/json': { schema: UpsertWeekHistoryPlanResponseSchema } },
    },
    400: { description: 'Invalid request' },
    409: {
      description: 'The supplied expectedUpdatedAt value is stale',
      content: { 'application/json': { schema: StaleWeekHistoryPlanResponseSchema } },
    },
    401: { description: 'Missing or invalid session' },
  },
})

const generateWeekPlanRoute = createRoute({
  method: 'post',
  path: '/households/{householdId}/week-plans/{weekStartDate}/generate',
  operationId: 'generateWeekPlan',
  summary: 'Generate meals for a week from household profile and available recipes',
  security: [{ bearerAuth: [] }],
  request: {
    params: ParamsSchema,
    body: { content: { 'application/json': { schema: GenerateWeekPlanRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Week plan generated (or nothing to do — all days already filled)',
      content: { 'application/json': { schema: GenerateWeekPlanResponseSchema } },
    },
    422: {
      description: 'No recipes available to plan with',
      content: { 'application/json': { schema: GenerateWeekPlanErrorSchema } },
    },
    403: { description: 'Premium generation quota reached', content: { 'application/json': { schema: PremiumRequiredResponseSchema } } },
    401: { description: 'Missing or invalid session' },
    404: { description: 'Household not found or caller is not a member' },
  },
})

const finalizeWeekHistoryPlanRoute = createRoute({
  method: 'post',
  path: '/households/{householdId}/week-plans/{weekStartDate}/finalize',
  operationId: 'finalizeWeekHistoryPlan',
  summary: 'Finalize a persisted week plan',
  security: [{ bearerAuth: [] }],
  request: { params: ParamsSchema },
  responses: {
    200: {
      description: 'Week plan finalized',
      content: { 'application/json': { schema: FinalizeWeekHistoryPlanResponseSchema } },
    },
    400: { description: 'Invalid week start date' },
    404: { description: 'Week plan not found' },
    401: { description: 'Missing or invalid session' },
  },
})

type TEnv = { Variables: { user: AuthedUser; accessToken: string } }

function authOf(c: Context<TEnv>) {
  return { accessToken: c.get('accessToken'), userId: c.get('user').id }
}

// Use-case failures carry their error code; STALE_WEEK_PLAN is the one
// conflict, every other code means no safe change is available.
function staleOrUnprocessable(result: { error: ErrorCode }): never {
  throw new ApiError(result.error === 'STALE_WEEK_PLAN' ? 409 : 422, result.error)
}

function toWeekPlanEventResponse(event: PersistedStreamEvent) {
  return {
    id: event.id,
    householdId: event.householdId,
    weekStartDate: event.weekStartDate,
    sequenceNumber: event.sequenceNumber,
    occurredAt: event.occurredAt.toISOString(),
    causedBy: event.causedBy as z.infer<typeof CausedBySchema>,
    eventType: event.eventType as z.infer<typeof WeekPlanEventTypeSchema>,
    payload: event.payload as Record<string, unknown>,
  }
}

function toWeekPlanProjectionResponse(projection: PersistedStreamProjection) {
  return {
    householdId: projection.householdId,
    weekStartDate: projection.weekStartDate,
    state: projection.state as Record<string, unknown>,
    updatedAt: projection.updatedAt.toISOString(),
  }
}

// Every household route checks the caller's membership before any use case
// runs (authenticate -> authorize -> repository). The order of the Monday
// check and the membership check differs per route and is kept exactly as it
// is (see "Kända inkonsekvenser" #6 in PLAN-arkitektur-pilot-week-2026-10.md).
export function buildWeekPlanRoutes(db: Db) {
  const app = new OpenAPIHono<TEnv>({ defaultHook: invalidRequestHook })

  // Hono middleware doesn't cross OpenAPIHono sub-app boundaries — the
  // households module registers its own `requireAuth` on `/households/*`,
  // and so must this one (it doesn't inherit the registration when mounted
  // into the parent app via `.route('/', ...)`).
  app.use('/households/*', requireAuth)

  app.openapi(getWeekContextOverridesRoute, async (c) => {
    const { householdId, weekStartDate } = c.req.valid('param')
    requireMonday(weekStartDate, { status: 400, code: 'INVALID_WEEK_START_DATE' })
    const ctx = await requireHouseholdMember(db, authOf(c), householdId)
    const overrides = await getWeekContextOverrides(ctx, weekStartDate)
    return c.json({ overrides }, 200)
  })

  app.openapi(upsertWeekContextOverrideRoute, async (c) => {
    const { householdId, weekStartDate, date } = c.req.valid('param')
    requireMonday(weekStartDate, { status: 400, code: 'INVALID_WEEK_CONTEXT_DATE' })
    requireDateInWeek(weekStartDate, date, { status: 400, code: 'INVALID_WEEK_CONTEXT_DATE' })
    const ctx = await requireHouseholdMember(db, authOf(c), householdId)
    const saved = await upsertWeekContextOverride(ctx, weekStartDate, date, c.req.valid('json'))
    return c.json(saved, 200)
  })

  app.openapi(clearWeekContextOverrideRoute, async (c) => {
    const { householdId, weekStartDate, date } = c.req.valid('param')
    requireMonday(weekStartDate, { status: 400, code: 'INVALID_WEEK_CONTEXT_DATE' })
    requireDateInWeek(weekStartDate, date, { status: 400, code: 'INVALID_WEEK_CONTEXT_DATE' })
    const ctx = await requireHouseholdMember(db, authOf(c), householdId)
    await clearWeekContextOverride(ctx, weekStartDate, date)
    return c.json({ ok: true }, 200)
  })

  app.openapi(generateWeekPlanRoute, async (c) => {
    const { householdId, weekStartDate } = c.req.valid('param')
    const { regenerate, pantryItemKeys } = c.req.valid('json')
    requireMonday(weekStartDate, { status: 400, code: 'INVALID_WEEK_START_DATE' })
    const ctx = await requireHouseholdMember(db, authOf(c), householdId)
    const today = requestToday(c.req.header('X-Veckly-Today'))
    const result = await generateWeek(ctx, weekStartDate, { regenerate, today, pantryItemKeys })
    if ('gate' in result) throw new ApiError(403, result.gate)
    if ('error' in result && result.error === 'NOT_MEMBER') throw new ApiError(404, 'NOT_MEMBER')
    if ('error' in result) throw new ApiError(422, result.error)
    return c.json({ ok: true }, 200)
  })

  app.openapi(appendWeekPlanEventRoute, async (c) => {
    const { householdId, weekStartDate } = c.req.valid('param')
    requireMonday(weekStartDate, { status: 400, code: 'INVALID_WEEK_START_DATE' })
    const ctx = await requireHouseholdMember(db, authOf(c), householdId)
    // The body's `causedBy` is never trusted (see shopping-list's event route):
    // events are always attributed to the authenticated caller.
    const { causedBy: _ignored, ...payload } = c.req.valid('json')
    if (payload.eventType === 'week_context_override_upserted' || payload.eventType === 'week_context_override_cleared') {
      requireDateInWeek(weekStartDate, payload.date, { status: 400, code: 'INVALID_WEEK_CONTEXT_DATE' })
    }
    const event = await recordWeekPlanEvent(ctx, weekStartDate, { source: 'user', userId: ctx.userId }, payload as z.infer<typeof WeekPlanEventPayloadSchema>)
    return c.json(toWeekPlanEventResponse(event), 201)
  })

  app.openapi(getWeekPlanRoute, async (c) => {
    const { householdId, weekStartDate } = c.req.valid('param')
    requireMonday(weekStartDate, { status: 400, code: 'INVALID_WEEK_START_DATE' })
    const ctx = await requireHouseholdMember(db, authOf(c), householdId)
    const projection = await getWeekPlan(ctx, weekStartDate)
    // Free text, unchanged (see "Kända inkonsekvenser" #3).
    if (!projection) throw new ApiError(404, 'No week plan found for this week')
    c.header('Cache-Control', 'private, max-age=300')
    return c.json(toWeekPlanProjectionResponse(projection), 200)
  })

  app.openapi(getWeekPlanSummaryRoute, async (c) => {
    const { householdId, weekStartDate } = c.req.valid('param')
    requireMonday(weekStartDate, { status: 400, code: 'INVALID_WEEK_START_DATE' })
    const ctx = await requireHouseholdMember(db, authOf(c), householdId)
    const summary = await getWeekPlanSummary(ctx, weekStartDate)
    // Free text, unchanged (see "Kända inkonsekvenser" #2).
    if (!summary) throw new ApiError(404, 'Household not found.')
    c.header('Cache-Control', 'private, max-age=300')
    return c.json(summary, 200)
  })

  // Rescue answers a non-Monday week or a date outside it with 422 NO_PLAN,
  // before membership (see "Kända inkonsekvenser" #4).
  app.openapi(previewWeekRescueRoute, async (c) => {
    const { householdId, weekStartDate } = c.req.valid('param')
    const request = c.req.valid('json')
    requireMonday(weekStartDate, { status: 422, code: 'NO_PLAN' })
    requireDateInWeek(weekStartDate, request.date, { status: 422, code: 'NO_PLAN' })
    const ctx = await requireHouseholdMember(db, authOf(c), householdId)
    const result = await previewWeekRescue(ctx, weekStartDate, request)
    if ('error' in result) staleOrUnprocessable(result)
    return c.json(result, 200)
  })

  app.openapi(applyWeekRescueRoute, async (c) => {
    const { householdId, weekStartDate } = c.req.valid('param')
    const request = c.req.valid('json')
    requireMonday(weekStartDate, { status: 422, code: 'NO_PLAN' })
    requireDateInWeek(weekStartDate, request.date, { status: 422, code: 'NO_PLAN' })
    const ctx = await requireHouseholdMember(db, authOf(c), householdId)
    const result = await applyWeekRescue(ctx, weekStartDate, request)
    if ('error' in result) staleOrUnprocessable(result)
    return c.json(result, 200)
  })

  // A non-Monday week is 422 NO_COMPLETED_WEEK, before membership (see
  // "Kända inkonsekvenser" #5).
  app.openapi(previewPreviousWeekProposalRoute, async (c) => {
    const { householdId, weekStartDate } = c.req.valid('param')
    requireMonday(weekStartDate, { status: 422, code: 'NO_COMPLETED_WEEK' })
    const ctx = await requireHouseholdMember(db, authOf(c), householdId)
    const result = await previewPreviousWeekProposal(ctx, weekStartDate, c.req.valid('json'))
    if ('error' in result) staleOrUnprocessable(result)
    return c.json(result, 200)
  })

  app.openapi(applyPreviousWeekProposalRoute, async (c) => {
    const { householdId, weekStartDate } = c.req.valid('param')
    requireMonday(weekStartDate, { status: 422, code: 'NO_COMPLETED_WEEK' })
    const ctx = await requireHouseholdMember(db, authOf(c), householdId)
    const result = await applyPreviousWeekProposal(ctx, weekStartDate, c.req.valid('json'))
    if ('error' in result) staleOrUnprocessable(result)
    return c.json(result, 200)
  })

  // Membership first, then the range.
  app.openapi(listWeekHistoryPlansRoute, async (c) => {
    const { householdId } = c.req.valid('param')
    const { from, to } = c.req.valid('query')
    const ctx = await requireHouseholdMember(db, authOf(c), householdId)
    if (from) requireMonday(from, { status: 400, code: 'INVALID_WEEK_RANGE' })
    if (to) requireMonday(to, { status: 400, code: 'INVALID_WEEK_RANGE' })
    const result = await listWeekHistory(ctx, { from, to })
    if ('gate' in result) throw new ApiError(403, result.gate)
    return c.json(result.plans, 200)
  })

  // Membership is checked before the Monday check.
  app.openapi(getWeekHistoryPlanRoute, async (c) => {
    const { householdId, weekStartDate } = c.req.valid('param')
    const ctx = await requireHouseholdMember(db, authOf(c), householdId)
    requireMonday(weekStartDate, { status: 400, code: 'INVALID_WEEK_START_DATE' })
    const week = await getWeekHistoryPlan(ctx, weekStartDate)
    return c.json({ week }, 200)
  })

  // Membership first, then the Monday check.
  app.openapi(upsertWeekHistoryPlanRoute, async (c) => {
    const { householdId, weekStartDate } = c.req.valid('param')
    const body = c.req.valid('json')
    const ctx = await requireHouseholdMember(db, authOf(c), householdId)
    requireMonday(weekStartDate, { status: 400, code: 'INVALID_WEEK_START_DATE' })
    const result = await upsertWeekHistoryPlan(ctx, weekStartDate, body)
    if (result.outcome === 'stale') throw new ApiError(409, 'STALE_WEEK_PLAN_STATE', { updatedAt: result.updatedAt })
    const { plan } = result
    return c.json({ ok: true, weekStartDate: plan.weekStartDate, weekNumber: plan.weekNumber, weekYear: plan.weekYear, updatedAt: plan.updatedAt }, 200)
  })

  // The Monday check runs before membership here.
  app.openapi(finalizeWeekHistoryPlanRoute, async (c) => {
    const { householdId, weekStartDate } = c.req.valid('param')
    requireMonday(weekStartDate, { status: 400, code: 'INVALID_WEEK_START_DATE' })
    const ctx = await requireHouseholdMember(db, authOf(c), householdId)
    const plan = await finalizeWeekHistoryPlan(ctx, weekStartDate)
    if (!plan) throw new ApiError(404, 'WEEK_PLAN_NOT_FOUND')
    return c.json({ ok: true, weekStartDate, status: 'finalized', updatedAt: plan.updatedAt }, 200)
  })

  return app
}
