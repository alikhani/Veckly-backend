import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, desc, eq, inArray, or } from 'drizzle-orm'
import { requireAuth, type AuthedUser } from './auth.js'
import { appendStreamEvent, getStreamProjection } from './event-stream.js'
import { languageFromAcceptLanguage } from './locale.js'
import { assertMembership } from './membership.js'
import { withRls } from './rls.js'
import { householdShoppingPreferences, households, householdProfiles, recipes, shoppingListEvents, shoppingListProjections, weekPlanProjections } from './schema.js'
import type { Db } from './db.js'
import { DEFAULT_SHOPPING_CATEGORY_ORDER } from './shopping-preferences.js'
import {
  AppendShoppingListEventRequestSchema,
  CausedBySchema,
  ParamsSchema,
  ShoppingListEventPayloadSchema,
  ShoppingListEventSchema,
  ShoppingListProjectionSchema,
  ShoppingListStateResponseSchema,
  ShoppingListSummarySchema,
  ShoppingStatePayloadSchema,
  StaleShoppingListStateResponseSchema,
  UpdateShoppingListStateRequestSchema,
  UpdateShoppingListStateResponseSchema,
} from './modules/shopping-list/schemas.js'
import {
  deduplicateCustomItems,
  emptyProjectionState,
  foldEventIntoProjection,
  readShoppingProjectionState,
  toShoppingStatePayload,
  type TShoppingListProjectionState,
} from './modules/shopping-list/projection.js'
import type { TShoppingListLanguage } from './modules/shopping-list/localization.js'
import { buildShoppingListGroups, plannedMealOccurrences, type TWeekPlanProjectionState } from './modules/shopping-list/summary.js'

// --- Routes ------------------------------------------------------------------
//
// The transactional append-and-fold mechanism lives in `event-stream.ts` as
// `appendStreamEvent` — extracted once this stream became the second
// byte-identical instance of week-plan's shape, proving it's genuinely
// shared rather than a one-off that happened to fit. See that module's
// comment for the reasoning (including why the table arguments are duck-typed
// rather than fought into Drizzle's generics).

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
    400: { description: 'Invalid request body' },
    409: {
      description: 'The supplied expectedUpdatedAt value is stale',
      content: { 'application/json': { schema: StaleShoppingListStateResponseSchema } },
    },
    401: { description: 'Missing or invalid session' },
  },
})

async function getShoppingListState(db: Db, accessToken: string, householdId: string, weekStartDate: string) {
  const projection = await getStreamProjection(db, accessToken, shoppingListProjections, { householdId, weekStartDate })
  if (!projection) return { state: null, updatedAt: null }

  const state = readShoppingProjectionState(projection.state)
  const payload = toShoppingStatePayload(state)
  return {
    state: payload,
    updatedAt: payload ? projection.updatedAt.toISOString() : null,
  }
}

type TUpdateShoppingListStateResult =
  | { outcome: 'updated'; updatedAt: string | null }
  | { outcome: 'stale'; updatedAt: string | null }

async function replaceShoppingListState(
  db: Db,
  accessToken: string,
  args: {
    householdId: string
    weekStartDate: string
    causedBy: z.infer<typeof CausedBySchema>
    expectedUpdatedAt?: string | null
    state: z.infer<typeof ShoppingStatePayloadSchema> | null
  },
): Promise<TUpdateShoppingListStateResult> {
  return withRls(db, accessToken, async (tx) => {
    const [existingProjection] = await tx
      .select({ state: shoppingListProjections.state, updatedAt: shoppingListProjections.updatedAt })
      .from(shoppingListProjections)
      .where(and(eq(shoppingListProjections.householdId, args.householdId), eq(shoppingListProjections.weekStartDate, args.weekStartDate)))
      .limit(1)

    const currentState = readShoppingProjectionState(existingProjection?.state)
    const currentUpdatedAt = toShoppingStatePayload(currentState) ? existingProjection?.updatedAt.toISOString() ?? null : null
    if (args.expectedUpdatedAt !== undefined && currentUpdatedAt !== args.expectedUpdatedAt) {
      return { outcome: 'stale', updatedAt: currentUpdatedAt }
    }

    const [latest] = await tx
      .select({ sequenceNumber: shoppingListEvents.sequenceNumber })
      .from(shoppingListEvents)
      .where(and(eq(shoppingListEvents.householdId, args.householdId), eq(shoppingListEvents.weekStartDate, args.weekStartDate)))
      .orderBy(desc(shoppingListEvents.sequenceNumber))
      .limit(1)

    const sanitizedState = args.state
      ? { ...args.state, customItems: deduplicateCustomItems(args.state.customItems ?? []) }
      : null
    const payload: z.infer<typeof ShoppingListEventPayloadSchema> = sanitizedState === null
      ? { eventType: 'shopping_list_cleared' }
      : { eventType: 'shopping_state_replaced', state: sanitizedState }
    const { eventType, ...payloadFields } = payload
    const nextSequenceNumber = (latest?.sequenceNumber ?? 0) + 1

    await tx.insert(shoppingListEvents).values({
      householdId: args.householdId,
      weekStartDate: args.weekStartDate,
      sequenceNumber: nextSequenceNumber,
      causedBy: args.causedBy,
      eventType,
      payload: payloadFields,
    })

    const nextState = foldEventIntoProjection(currentState, payload)
    const now = new Date()
    const [projection] = await tx
      .insert(shoppingListProjections)
      .values({ householdId: args.householdId, weekStartDate: args.weekStartDate, state: nextState, updatedAt: now })
      .onConflictDoUpdate({
        target: [shoppingListProjections.householdId, shoppingListProjections.weekStartDate],
        set: { state: nextState, updatedAt: now },
      })
      .returning({ updatedAt: shoppingListProjections.updatedAt })

    if (!projection) throw new Error('Upsert did not return the shopping list projection')
    return { outcome: 'updated', updatedAt: args.state === null ? null : projection.updatedAt.toISOString() }
  })
}

export async function getShoppingListSummary(
  db: Db,
  accessToken: string,
  householdId: string,
  weekStartDate: string,
  // Kept temporarily for source compatibility with callers/tests that used
  // to control the rolling-day filter. Shopping summaries are now stable for
  // the whole selected week, so `today` is deliberately ignored.
  options: { language?: TShoppingListLanguage; today?: string } = {},
) {
  const language = options.language ?? 'en'
  return withRls(db, accessToken, async (tx) => {
    const [household] = await tx
      .select({ id: households.id, name: households.name })
      .from(households)
      .where(eq(households.id, householdId))
      .limit(1)

    if (!household) return null

    const [weekProjection] = await tx
      .select({ state: weekPlanProjections.state })
      .from(weekPlanProjections)
      .where(and(eq(weekPlanProjections.householdId, householdId), eq(weekPlanProjections.weekStartDate, weekStartDate)))
      .limit(1)

    const [shoppingProjection] = await tx
      .select({ state: shoppingListProjections.state, updatedAt: shoppingListProjections.updatedAt })
      .from(shoppingListProjections)
      .where(and(eq(shoppingListProjections.householdId, householdId), eq(shoppingListProjections.weekStartDate, weekStartDate)))
      .limit(1)

    const [profileRow] = await tx
      .select({ adults: householdProfiles.adults, children: householdProfiles.children })
      .from(householdProfiles)
      .where(eq(householdProfiles.householdId, householdId))
      .limit(1)
    const [preferencesRow] = await tx
      .select({ categoryOrder: householdShoppingPreferences.categoryOrder })
      .from(householdShoppingPreferences)
      .where(eq(householdShoppingPreferences.householdId, householdId))
      .limit(1)
    const categoryOrder = Array.isArray(preferencesRow?.categoryOrder)
      ? preferencesRow.categoryOrder.filter((value): value is string => typeof value === 'string')
      : DEFAULT_SHOPPING_CATEGORY_ORDER
    // No profile row at all → no household size to scale to; each meal falls
    // back to the recipe's own base servings (i.e. unscaled) per decision 17.
    const householdSize = profileRow ? profileRow.adults + profileRow.children : undefined

    const shoppingState = readShoppingProjectionState(shoppingProjection?.state)
    const weekState = (weekProjection?.state ?? {}) as TWeekPlanProjectionState
    const mealOccurrences = plannedMealOccurrences(weekState)

    // Fetch each distinct recipe exactly once — the per-day scaling below
    // reads from this map per occurrence, so there's no need to query the
    // same recipe row twice just because it's planned on two days.
    const recipeIds = [...new Set(mealOccurrences.map((meal) => meal.recipeRef))]
    const recipeRows = recipeIds.length
      ? await tx
        .select({ id: recipes.id, ingredients: recipes.ingredients, source: recipes.source, servings: recipes.servings })
        .from(recipes)
        .where(and(or(eq(recipes.householdId, householdId), eq(recipes.isPublic, true)), inArray(recipes.id, recipeIds)))
      : []
    const recipesById = new Map(recipeRows.map((recipe) => [recipe.id, recipe]))

    const groups = buildShoppingListGroups({ mealOccurrences, recipesById, householdSize, categoryOrder, shoppingState, language })

    return {
      household,
      weekStartDate,
      updatedAt: shoppingProjection?.updatedAt.toISOString() ?? null,
      groups,
    }
  })
}

export function buildShoppingListRoutes(db: Db) {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()

  // Same sub-app middleware-isolation note as week-plan's: this registration
  // doesn't cross into the parent app via `.route('/', ...)`.
  app.use('/households/*', requireAuth)

  app.openapi(appendShoppingListEventRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId, weekStartDate } = c.req.valid('param')
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' }, 404)
    const body = c.req.valid('json')
    const { causedBy, ...payload } = body

    const event = await appendStreamEvent(
      db,
      accessToken,
      { events: shoppingListEvents, projections: shoppingListProjections },
      { fold: foldEventIntoProjection, emptyState: emptyProjectionState },
      { householdId, weekStartDate, causedBy, payload: payload as z.infer<typeof ShoppingListEventPayloadSchema> },
    )

    return c.json(
      {
        id: event.id,
        householdId: event.householdId,
        weekStartDate: event.weekStartDate,
        sequenceNumber: event.sequenceNumber,
        occurredAt: event.occurredAt.toISOString(),
        causedBy: event.causedBy as z.infer<typeof CausedBySchema>,
        eventType: event.eventType as 'list_started' | 'item_checked' | 'shopping_state_replaced' | 'shopping_list_cleared',
        payload: event.payload as Record<string, unknown>,
      },
      201,
    )
  })

  app.openapi(getShoppingListRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId, weekStartDate } = c.req.valid('param')
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' }, 404)

    // Exactly one query, against the projection only — `getStreamProjection`
    // enforces the same read-path rule as week-plan's: never replay the event
    // log on the read path.
    const projection = await getStreamProjection(db, accessToken, shoppingListProjections, { householdId, weekStartDate })

    if (!projection) return c.json({ error: 'No shopping list found for this week' }, 404)

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

  app.openapi(getShoppingListSummaryRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId, weekStartDate } = c.req.valid('param')
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' }, 404)
    const summary = await getShoppingListSummary(db, accessToken, householdId, weekStartDate, {
      language: languageFromAcceptLanguage(c.req.header('Accept-Language')),
    })

    if (!summary) return c.json({ error: 'Household not found.' } as never, 404)
    c.header('Cache-Control', 'no-store')
    return c.json(summary, 200)
  })

  app.openapi(getShoppingListStateRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId, weekStartDate } = c.req.valid('param')
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' }, 404)
    const state = await getShoppingListState(db, accessToken, householdId, weekStartDate)
    return c.json(state, 200)
  })

  app.openapi(updateShoppingListStateRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId, weekStartDate } = c.req.valid('param')
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' }, 404)
    const body = c.req.valid('json')
    const result = await replaceShoppingListState(db, accessToken, {
      householdId,
      weekStartDate,
      causedBy: { source: 'user', userId: user.id },
      expectedUpdatedAt: body.expectedUpdatedAt,
      state: body.state,
    })

    if (result.outcome === 'stale') return c.json({ error: 'STALE_SHOPPING_STATE', updatedAt: result.updatedAt }, 409)
    return c.json({ ok: true, updatedAt: result.updatedAt }, 200)
  })

  return app
}

// Exported for tests that need to seed projection rows directly (bypassing
// appendShoppingListEvent) to prove the read path reflects the projection,
// never a replay of the log — same rationale as week-plan's exports.
export { foldEventIntoProjection, emptyProjectionState, getShoppingListState, replaceShoppingListState }
export type { TShoppingListProjectionState }
