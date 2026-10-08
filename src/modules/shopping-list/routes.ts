import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { requireAuth, type AuthedUser } from '../../auth.js'
import type { Db } from '../../db.js'
import type { PersistedStreamEvent, PersistedStreamProjection } from '../../event-stream.js'
import { languageFromAcceptLanguage } from '../../locale.js'
import { ApiError, errorResponses, invalidRequestHook, requireHouseholdMember, requireMonday } from '../../platform/http-errors.js'
import {
  AppendShoppingListEventRequestSchema,
  CausedBySchema,
  ParamsSchema,
  ShoppingListEventPayloadSchema,
  ShoppingListEventSchema,
  ShoppingListProjectionSchema,
  ShoppingListStateResponseSchema,
  ShoppingListSummarySchema,
  StaleShoppingListStateResponseSchema,
  UpdateShoppingListStateRequestSchema,
  UpdateShoppingListStateResponseSchema,
} from './schemas.js'
import {
  getShoppingList,
  getShoppingListState,
  getShoppingListSummary,
  recordShoppingListEvent,
  replaceShoppingListState,
} from './service.js'

// --- Routes ------------------------------------------------------------------

const appendShoppingListEventRoute = createRoute({
  method: 'post',
  path: '/households/{householdId}/shopping-lists/{weekStartDate}/events',
  operationId: 'appendShoppingListEvent',
  summary: 'Append an event to a household shopping list',
  security: [{ bearerAuth: [] }],
  request: {
    params: ParamsSchema,
    body: { content: { 'application/json': { schema: AppendShoppingListEventRequestSchema } } },
  },
  responses: {
    201: {
      description: 'The persisted event',
      content: { 'application/json': { schema: ShoppingListEventSchema } },
    },
    401: { description: 'Missing or invalid session' },
    ...errorResponses({ 400: 'Invalid request, or week start is not a Monday' }),
  },
})

const getShoppingListRoute = createRoute({
  method: 'get',
  path: '/households/{householdId}/shopping-lists/{weekStartDate}',
  operationId: 'getShoppingList',
  summary: "Read a household shopping list's current state",
  security: [{ bearerAuth: [] }],
  request: { params: ParamsSchema },
  responses: {
    200: {
      description: 'The current materialized projection for this week',
      content: { 'application/json': { schema: ShoppingListProjectionSchema } },
    },
    404: { description: "The list hasn't started yet — no projection exists" },
    401: { description: 'Missing or invalid session' },
    ...errorResponses({ 400: 'Invalid request, or week start is not a Monday' }),
  },
})

const getShoppingListSummaryRoute = createRoute({
  method: 'get',
  path: '/households/{householdId}/shopping-lists/{weekStartDate}/summary',
  operationId: 'getShoppingListSummary',
  summary: "Read a household shopping list as an iOS-friendly grouped summary",
  security: [{ bearerAuth: [] }],
  request: { params: ParamsSchema },
  responses: {
    200: {
      description: 'The current shopping list summary. Missing projections return an empty list.',
      content: { 'application/json': { schema: ShoppingListSummarySchema } },
    },
    404: { description: 'Household not found or caller is not a member' },
    401: { description: 'Missing or invalid session' },
    ...errorResponses({ 400: 'Invalid request, or week start is not a Monday' }),
  },
})

const getShoppingListStateRoute = createRoute({
  method: 'get',
  path: '/households/{householdId}/shopping-lists/{weekStartDate}/state',
  operationId: 'getShoppingListState',
  summary: "Read a household shopping list's shared checklist and pantry state",
  security: [{ bearerAuth: [] }],
  request: { params: ParamsSchema },
  responses: {
    200: {
      description: 'The shared shopping state, or null when unset',
      content: { 'application/json': { schema: ShoppingListStateResponseSchema } },
    },
    401: { description: 'Missing or invalid session' },
    ...errorResponses({ 400: 'Invalid request, or week start is not a Monday' }),
  },
})

const updateShoppingListStateRoute = createRoute({
  method: 'patch',
  path: '/households/{householdId}/shopping-lists/{weekStartDate}/state',
  operationId: 'updateShoppingListState',
  summary: "Replace or clear a household shopping list's shared checklist and pantry state",
  security: [{ bearerAuth: [] }],
  request: {
    params: ParamsSchema,
    body: { content: { 'application/json': { schema: UpdateShoppingListStateRequestSchema } } },
  },
  responses: {
    200: {
      description: 'State was replaced or cleared',
      content: { 'application/json': { schema: UpdateShoppingListStateResponseSchema } },
    },
    409: {
      description: 'The supplied expectedUpdatedAt value is stale',
      content: { 'application/json': { schema: StaleShoppingListStateResponseSchema } },
    },
    401: { description: 'Missing or invalid session' },
    ...errorResponses({ 400: 'Invalid request, or week start is not a Monday' }),
  },
})

type TEnv = { Variables: { user: AuthedUser; accessToken: string } }

function authOf(c: Context<TEnv>) {
  return { accessToken: c.get('accessToken'), userId: c.get('user').id }
}

function toShoppingListEventResponse(event: PersistedStreamEvent) {
  return {
    id: event.id,
    householdId: event.householdId,
    weekStartDate: event.weekStartDate,
    sequenceNumber: event.sequenceNumber,
    occurredAt: event.occurredAt.toISOString(),
    causedBy: event.causedBy as z.infer<typeof CausedBySchema>,
    eventType: event.eventType as 'list_started' | 'item_checked' | 'shopping_state_replaced' | 'shopping_list_cleared',
    payload: event.payload as Record<string, unknown>,
  }
}

function toShoppingListProjectionResponse(projection: PersistedStreamProjection) {
  return {
    householdId: projection.householdId,
    weekStartDate: projection.weekStartDate,
    state: projection.state as Record<string, unknown>,
    updatedAt: projection.updatedAt.toISOString(),
  }
}

// Every household route checks the caller's membership before any use case
// runs (authenticate -> authorize -> repository), in one order: request
// validation, then the Monday week, then membership.
export function buildShoppingListRoutes(db: Db) {
  const app = new OpenAPIHono<TEnv>({ defaultHook: invalidRequestHook })

  // Same sub-app middleware-isolation note as week-plan's: this registration
  // doesn't cross into the parent app via `.route('/', ...)`.
  app.use('/households/*', requireAuth)

  app.openapi(appendShoppingListEventRoute, async (c) => {
    const { householdId, weekStartDate } = c.req.valid('param')
    requireMonday(weekStartDate, { status: 400, code: 'INVALID_WEEK_START_DATE' })
    const ctx = await requireHouseholdMember(db, authOf(c), householdId)
    // The body's `causedBy` is never trusted: a client could otherwise attribute
    // an event to another user or to the algorithm/system. The field stays in the
    // request schema so existing clients keep validating.
    const { causedBy: _ignored, ...payload } = c.req.valid('json')
    const event = await recordShoppingListEvent(ctx, weekStartDate, { source: 'user', userId: ctx.userId }, payload as z.infer<typeof ShoppingListEventPayloadSchema>)
    return c.json(toShoppingListEventResponse(event), 201)
  })

  app.openapi(getShoppingListRoute, async (c) => {
    const { householdId, weekStartDate } = c.req.valid('param')
    requireMonday(weekStartDate, { status: 400, code: 'INVALID_WEEK_START_DATE' })
    const ctx = await requireHouseholdMember(db, authOf(c), householdId)
    const projection = await getShoppingList(ctx, weekStartDate)
    // Free text, unchanged.
    if (!projection) throw new ApiError(404, 'No shopping list found for this week')
    return c.json(toShoppingListProjectionResponse(projection), 200)
  })

  app.openapi(getShoppingListSummaryRoute, async (c) => {
    const { householdId, weekStartDate } = c.req.valid('param')
    requireMonday(weekStartDate, { status: 400, code: 'INVALID_WEEK_START_DATE' })
    const ctx = await requireHouseholdMember(db, authOf(c), householdId)
    const summary = await getShoppingListSummary(ctx, weekStartDate, {
      language: languageFromAcceptLanguage(c.req.header('Accept-Language')),
    })
    // Free text, unchanged.
    if (!summary) throw new ApiError(404, 'Household not found.')
    c.header('Cache-Control', 'no-store')
    return c.json(summary, 200)
  })

  app.openapi(getShoppingListStateRoute, async (c) => {
    const { householdId, weekStartDate } = c.req.valid('param')
    requireMonday(weekStartDate, { status: 400, code: 'INVALID_WEEK_START_DATE' })
    const ctx = await requireHouseholdMember(db, authOf(c), householdId)
    return c.json(await getShoppingListState(ctx, weekStartDate), 200)
  })

  app.openapi(updateShoppingListStateRoute, async (c) => {
    const { householdId, weekStartDate } = c.req.valid('param')
    requireMonday(weekStartDate, { status: 400, code: 'INVALID_WEEK_START_DATE' })
    const ctx = await requireHouseholdMember(db, authOf(c), householdId)
    const body = c.req.valid('json')
    const result = await replaceShoppingListState(ctx, {
      weekStartDate,
      causedBy: { source: 'user', userId: ctx.userId },
      expectedUpdatedAt: body.expectedUpdatedAt,
      state: body.state,
    })
    if (result.outcome === 'stale') throw new ApiError(409, 'STALE_SHOPPING_STATE', { updatedAt: result.updatedAt })
    return c.json({ ok: true, updatedAt: result.updatedAt }, 200)
  })

  return app
}
