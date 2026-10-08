import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { requireAuth, type AuthedUser } from './auth.js'
import { assertMembership } from './membership.js'
import { PremiumRequiredResponseSchema } from './premium-gates.js'
import {
  WeekContextOverrideSchema,
  type TWeekContextOverride,
} from './planning-context.js'
import type { Db } from './db.js'
import {
  addDays,
  isDateInWeek,
  isMonday,
  requestToday,
} from './shared/week-dates.js'
import { recipeMatchesAvoided } from './shared/recipe-matching.js'
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
  type TPreviousWeekProposalRequest,
  type TWeekRescueRequest,
} from './modules/week-plan/schemas.js'
import { emptyProjectionState, foldEventIntoProjection } from './modules/week-plan/projection.js'
import { deriveWeekExplanations } from './modules/week-plan/explanations.js'
import { deriveWeekRescuePreview } from './modules/week-plan/rescue.js'
import * as service from './modules/week-plan/service.js'
import * as serviceGenerate from './modules/week-plan/service-generate.js'

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

export function buildWeekPlanRoutes(db: Db) {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()

  // Hono middleware doesn't cross OpenAPIHono sub-app boundaries — the
  // households module registers its own `requireAuth` on `/households/*`,
  // and so must this one (it doesn't inherit the registration when mounted
  // into the parent app via `.route('/', ...)`).
  app.use('/households/*', requireAuth)

  app.openapi(getWeekContextOverridesRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId, weekStartDate } = c.req.valid('param')
    if (!isMonday(weekStartDate)) return c.json({ error: 'INVALID_WEEK_START_DATE' } as never, 400)
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' }, 404)

    const overrides = await service.getWeekContextOverrides({ db, accessToken, householdId }, weekStartDate)
    return c.json({ overrides }, 200)
  })

  app.openapi(upsertWeekContextOverrideRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId, weekStartDate, date } = c.req.valid('param')
    if (!isMonday(weekStartDate) || !isDateInWeek(weekStartDate, date)) {
      return c.json({ error: 'INVALID_WEEK_CONTEXT_DATE' } as never, 400)
    }
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' }, 404)
    const override = c.req.valid('json')

    const saved = await service.upsertWeekContextOverride({ db, accessToken, userId: user.id, householdId }, weekStartDate, date, override)
    return c.json(saved, 200)
  })

  app.openapi(clearWeekContextOverrideRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId, weekStartDate, date } = c.req.valid('param')
    if (!isMonday(weekStartDate) || !isDateInWeek(weekStartDate, date)) {
      return c.json({ error: 'INVALID_WEEK_CONTEXT_DATE' } as never, 400)
    }
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' }, 404)

    await service.clearWeekContextOverride({ db, accessToken, userId: user.id, householdId }, weekStartDate, date)
    return c.json({ ok: true }, 200)
  })

  app.openapi(generateWeekPlanRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId, weekStartDate } = c.req.valid('param')
    const { regenerate, pantryItemKeys } = c.req.valid('json')
    if (!isMonday(weekStartDate)) return c.json({ error: 'INVALID_WEEK_START_DATE' } as never, 400)
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' }, 404)
    const today = requestToday(c.req.header('X-Veckly-Today'))
    const result = await serviceGenerate.generateWeek({ db, accessToken, userId: user.id, householdId }, weekStartDate, { regenerate, today, pantryItemKeys })
    if ('gate' in result) return c.json(result.gate as never, 403)
    if ('error' in result && result.error === 'NOT_MEMBER') return c.json({ error: 'NOT_MEMBER' }, 404)
    if ('error' in result) return c.json(result, 422)
    return c.json({ ok: true }, 200)
  })

  app.openapi(appendWeekPlanEventRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId, weekStartDate } = c.req.valid('param')
    if (!isMonday(weekStartDate)) return c.json({ error: 'INVALID_WEEK_START_DATE' } as never, 400)
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' }, 404)
    const body = c.req.valid('json')
    const { causedBy, ...payload } = body
    if (
      (payload.eventType === 'week_context_override_upserted' || payload.eventType === 'week_context_override_cleared')
      && !isDateInWeek(weekStartDate, payload.date)
    ) {
      return c.json({ error: 'INVALID_WEEK_CONTEXT_DATE' } as never, 400)
    }

    const event = await service.recordWeekPlanEvent({ db, accessToken, householdId }, weekStartDate, causedBy, payload as z.infer<typeof WeekPlanEventPayloadSchema>)

    return c.json(
      {
        id: event.id,
        householdId: event.householdId,
        weekStartDate: event.weekStartDate,
        sequenceNumber: event.sequenceNumber,
        occurredAt: event.occurredAt.toISOString(),
        causedBy: event.causedBy as z.infer<typeof CausedBySchema>,
        eventType: event.eventType as z.infer<typeof WeekPlanEventTypeSchema>,
        payload: event.payload as Record<string, unknown>,
      },
      201,
    )
  })

  app.openapi(getWeekPlanRoute, async (c) => {
    const user = c.get('user')
    const accessToken = c.get('accessToken')
    const { householdId, weekStartDate } = c.req.valid('param')
    if (!isMonday(weekStartDate)) return c.json({ error: 'INVALID_WEEK_START_DATE' } as never, 400)
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' }, 404)

    const projection = await service.getWeekPlan({ db, accessToken, householdId }, weekStartDate)

    if (!projection) return c.json({ error: 'No week plan found for this week' }, 404)

    c.header('Cache-Control', 'private, max-age=300')
    return c.json(
      {
        householdId: projection.householdId,
        weekStartDate: projection.weekStartDate,
        state: projection.state as Record<string, unknown>,
        updatedAt: projection.updatedAt.toISOString(),
      },
      200,
    )
  })

  app.openapi(getWeekPlanSummaryRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId, weekStartDate } = c.req.valid('param')
    if (!isMonday(weekStartDate)) return c.json({ error: 'INVALID_WEEK_START_DATE' } as never, 400)
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' }, 404)
    const summary = await service.getWeekPlanSummary({ db, accessToken, householdId }, weekStartDate)

    if (!summary) return c.json({ error: 'Household not found.' } as never, 404)
    c.header('Cache-Control', 'private, max-age=300')
    return c.json(summary, 200)
  })

  app.openapi(previewWeekRescueRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId, weekStartDate } = c.req.valid('param')
    const request = c.req.valid('json')
    if (!isMonday(weekStartDate) || !isDateInWeek(weekStartDate, request.date)) return c.json({ error: 'NO_PLAN' }, 422)
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' } as never, 404)
    const result = await service.previewWeekRescue({ db, accessToken, householdId }, weekStartDate, request)
    if ('error' in result) return c.json(result, result.error === 'STALE_WEEK_PLAN' ? 409 : 422)
    return c.json(result, 200)
  })

  app.openapi(applyWeekRescueRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId, weekStartDate } = c.req.valid('param')
    const request = c.req.valid('json')
    if (!isMonday(weekStartDate) || !isDateInWeek(weekStartDate, request.date)) return c.json({ error: 'NO_PLAN' }, 422)
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' } as never, 404)
    const result = await service.applyWeekRescue({ db, accessToken, userId: user.id, householdId }, weekStartDate, request)
    if ('error' in result) return c.json(result, result.error === 'STALE_WEEK_PLAN' ? 409 : 422)
    return c.json(result, 200)
  })

  app.openapi(previewPreviousWeekProposalRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId, weekStartDate } = c.req.valid('param')
    if (!isMonday(weekStartDate)) return c.json({ error: 'NO_COMPLETED_WEEK' } as never, 422)
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' } as never, 404)
    const result = await service.previewPreviousWeekProposal({ db, accessToken, userId: user.id, householdId }, weekStartDate, c.req.valid('json'))
    if ('error' in result) return c.json(result, result.error === 'STALE_WEEK_PLAN' ? 409 : 422)
    return c.json(result, 200)
  })

  app.openapi(applyPreviousWeekProposalRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId, weekStartDate } = c.req.valid('param')
    if (!isMonday(weekStartDate)) return c.json({ error: 'NO_COMPLETED_WEEK' } as never, 422)
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' } as never, 404)
    const result = await service.applyPreviousWeekProposal({ db, accessToken, userId: user.id, householdId }, weekStartDate, c.req.valid('json'))
    if ('error' in result) return c.json(result, result.error === 'STALE_WEEK_PLAN' ? 409 : 422)
    return c.json(result, 200)
  })

  app.openapi(listWeekHistoryPlansRoute, async (c) => {
    const user = c.get('user')
    const accessToken = c.get('accessToken')
    const { householdId } = c.req.valid('param')
    const { from, to } = c.req.valid('query')
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' } as never, 404)

    if ((from && !isMonday(from)) || (to && !isMonday(to))) return c.json({ error: 'INVALID_WEEK_RANGE' } as never, 400)

    const result = await service.listWeekHistory({ db, accessToken, userId: user.id, householdId }, { from, to })
    if ('gate' in result) return c.json(result.gate as never, 403)
    return c.json(result.plans, 200)
  })

  app.openapi(getWeekHistoryPlanRoute, async (c) => {
    const user = c.get('user')
    const accessToken = c.get('accessToken')
    const { householdId, weekStartDate } = c.req.valid('param')
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ week: null } as never, 200)

    if (!isMonday(weekStartDate)) return c.json({ error: 'INVALID_WEEK_START_DATE' } as never, 400)

    const week = await service.getWeekHistoryPlan({ db, accessToken, householdId }, weekStartDate)
    return c.json({ week }, 200)
  })

  app.openapi(upsertWeekHistoryPlanRoute, async (c) => {
    const user = c.get('user')
    const accessToken = c.get('accessToken')
    const { householdId, weekStartDate } = c.req.valid('param')
    const body = c.req.valid('json')
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' } as never, 404)

    if (!isMonday(weekStartDate)) return c.json({ error: 'INVALID_WEEK_START_DATE' } as never, 400)

    const result = await service.upsertWeekHistoryPlan({ db, accessToken, userId: user.id, householdId }, weekStartDate, body)
    if (result.outcome === 'stale') return c.json({ error: 'STALE_WEEK_PLAN_STATE', updatedAt: result.updatedAt }, 409)

    return c.json({
      ok: true,
      weekStartDate: result.plan.weekStartDate,
      weekNumber: result.plan.weekNumber,
      weekYear: result.plan.weekYear,
      updatedAt: result.plan.updatedAt,
    }, 200)
  })

  app.openapi(finalizeWeekHistoryPlanRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId, weekStartDate } = c.req.valid('param')

    if (!isMonday(weekStartDate)) return c.json({ error: 'INVALID_WEEK_START_DATE' } as never, 400)

    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' }, 404)

    const plan = await service.finalizeWeekHistoryPlan({ db, accessToken, userId: user.id, householdId }, weekStartDate)
    if (!plan) return c.json({ error: 'WEEK_PLAN_NOT_FOUND' } as never, 404)

    return c.json({ ok: true, weekStartDate, status: 'finalized', updatedAt: plan.updatedAt }, 200)
  })

  return app
}

// Exported for tests that need to seed projection rows directly (bypassing
// appendWeekPlanEvent) to prove the read path reflects the projection, never a
// replay of the log.
export { foldEventIntoProjection, emptyProjectionState }
export type { TWeekPlanProjectionState } from './modules/week-plan/projection.js'

// Re-exported so existing importers keep working until the module split lands.
export { addDays, isMonday, recipeMatchesAvoided, requestToday }
export { deriveWeekExplanations, deriveWeekRescuePreview }
