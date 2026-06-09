import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, eq, inArray } from 'drizzle-orm'
import { requireAuth, type AuthedUser } from './auth.js'
import { appendStreamEvent, getStreamProjection } from './event-stream.js'
import { withRls } from './rls.js'
import { households, recipes, shoppingListEvents, shoppingListProjections, weekPlanProjections } from './schema.js'
import type { Db } from './db.js'

// --- Wire shapes -----------------------------------------------------------
//
// Same flat-envelope shape as week-plan's events — `{ causedBy, eventType,
// ...fields }` — for the same reason: `eventType` is both the Zod
// discriminant and the queryable `event_type` column.

const CausedBySchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('user'), userId: z.string().uuid() }),
  z.object({ source: z.literal('algorithm'), algorithmVersion: z.string(), triggeredByUserId: z.string().uuid() }),
  z.object({ source: z.literal('system'), reason: z.string() }),
]).openapi('ShoppingListCausedBy')

// Minimal lifecycle marker — mirrors week-plan's `WeekStarted`. Proves the
// stream has a start; the architecture doc's "shopping-list:<date>" framing
// names the stream key (household + week) but doesn't yet specify the full
// event vocabulary — that's future work, not this slice's job to pin down.
const ListStartedPayloadSchema = z.object({
  eventType: z.literal('list_started'),
})

// `itemKey` is a placeholder freeform identifier, not a real FK — shopping
// list items don't have a domain model yet (same situation `recipeRef` names
// in week-plan's `MealAssigned`: coupling the event-sourcing proof to a
// domain that doesn't exist would be backwards).
const ItemCheckedPayloadSchema = z.object({
  eventType: z.literal('item_checked'),
  itemKey: z.string().min(1),
  checked: z.boolean(),
})

const ShoppingListEventPayloadSchema = z.discriminatedUnion('eventType', [
  ListStartedPayloadSchema,
  ItemCheckedPayloadSchema,
])

const AppendShoppingListEventRequestSchema = z.object({
  causedBy: CausedBySchema,
}).and(ShoppingListEventPayloadSchema).openapi('AppendShoppingListEventRequest')

const ShoppingListEventSchema = z.object({
  id: z.string().uuid(),
  householdId: z.string().uuid(),
  weekStartDate: z.string(),
  sequenceNumber: z.number().int(),
  occurredAt: z.string(),
  causedBy: CausedBySchema,
  eventType: z.enum(['list_started', 'item_checked']),
  payload: z.record(z.string(), z.unknown()),
}).openapi('ShoppingListEvent')

const ShoppingListProjectionSchema = z.object({
  householdId: z.string().uuid(),
  weekStartDate: z.string(),
  state: z.record(z.string(), z.unknown()),
  updatedAt: z.string(),
}).openapi('ShoppingListProjection')

const ParamsSchema = z.object({
  householdId: z.string().uuid(),
  weekStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'),
})

const ShoppingListSummaryItemSchema = z.object({
  itemKey: z.string(),
  label: z.string(),
  amount: z.string().nullable(),
  unit: z.string().nullable(),
  checked: z.boolean(),
}).openapi('ShoppingListSummaryItem')

const ShoppingListSummaryGroupSchema = z.object({
  category: z.string(),
  items: z.array(ShoppingListSummaryItemSchema),
}).openapi('ShoppingListSummaryGroup')

const ShoppingListSummarySchema = z.object({
  household: z.object({ id: z.string().uuid(), name: z.string() }),
  weekStartDate: z.string(),
  updatedAt: z.string().nullable(),
  groups: z.array(ShoppingListSummaryGroupSchema),
}).openapi('ShoppingListSummary')

// --- Projection fold --------------------------------------------------------
//
// Minimal shape needed to prove `item_checked` folds correctly — same
// "explicitly provisional" status as week-plan's projection state. `itemKey`
// is the only identity an item has right now, so `checkedItems` is keyed on
// it directly.
type TShoppingListProjectionState = {
  listStarted: boolean
  checkedItems: Record<string, boolean>
}

const emptyProjectionState = (): TShoppingListProjectionState => ({ listStarted: false, checkedItems: {} })

function foldEventIntoProjection(
  state: TShoppingListProjectionState,
  payload: z.infer<typeof ShoppingListEventPayloadSchema>,
): TShoppingListProjectionState {
  switch (payload.eventType) {
    case 'list_started':
      return { ...state, listStarted: true }
    case 'item_checked':
      return { ...state, checkedItems: { ...state.checkedItems, [payload.itemKey]: payload.checked } }
  }
}

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

const weekDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const

type TRecipeIngredient = {
  item: string
  amount?: string
  unit?: string
  category?: string
}

type TWeekPlanProjectionState = {
  meals?: Partial<Record<typeof weekDays[number], { recipeRef?: string }>>
}

function normalizeKeyPart(value: string | null | undefined) {
  return (value ?? '').trim().toLowerCase().replace(/\s+/g, '-')
}

function buildItemKey(ingredient: TRecipeIngredient) {
  const category = normalizeKeyPart(ingredient.category || 'Other')
  const item = normalizeKeyPart(ingredient.item)
  const amount = normalizeKeyPart(ingredient.amount)
  const unit = normalizeKeyPart(ingredient.unit)
  return [category, item, amount, unit].join(':')
}

function readShoppingProjectionState(state: unknown): TShoppingListProjectionState {
  const candidate = state as Partial<TShoppingListProjectionState> | null | undefined
  return {
    listStarted: candidate?.listStarted === true,
    checkedItems: candidate?.checkedItems && typeof candidate.checkedItems === 'object' ? candidate.checkedItems : {},
  }
}

export async function getShoppingListSummary(db: Db, accessToken: string, householdId: string, weekStartDate: string) {
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

    const shoppingState = readShoppingProjectionState(shoppingProjection?.state)
    const weekState = (weekProjection?.state ?? {}) as TWeekPlanProjectionState
    const recipeIds = weekDays
      .map((day) => weekState.meals?.[day]?.recipeRef)
      .filter((id): id is string => Boolean(id))

    const recipeRows = recipeIds.length
      ? await tx
        .select({ id: recipes.id, ingredients: recipes.ingredients })
        .from(recipes)
        .where(and(eq(recipes.householdId, householdId), inArray(recipes.id, recipeIds)))
      : []

    const itemsByKey = new Map<string, { category: string; label: string; amount: string | null; unit: string | null; checked: boolean }>()

    for (const recipe of recipeRows) {
      for (const ingredient of recipe.ingredients as TRecipeIngredient[]) {
        if (!ingredient.item.trim()) continue
        const itemKey = buildItemKey(ingredient)
        if (itemsByKey.has(itemKey)) continue
        itemsByKey.set(itemKey, {
          category: ingredient.category?.trim() || 'Other',
          label: ingredient.item.trim(),
          amount: ingredient.amount?.trim() || null,
          unit: ingredient.unit?.trim() || null,
          checked: shoppingState.checkedItems[itemKey] === true,
        })
      }
    }

    const groupsByCategory = new Map<string, Array<{ itemKey: string; label: string; amount: string | null; unit: string | null; checked: boolean }>>()
    for (const [itemKey, item] of itemsByKey) {
      const group = groupsByCategory.get(item.category) ?? []
      group.push({ itemKey, label: item.label, amount: item.amount, unit: item.unit, checked: item.checked })
      groupsByCategory.set(item.category, group)
    }

    const groups = Array.from(groupsByCategory.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([category, items]) => ({
        category,
        items: items.sort((left, right) => left.label.localeCompare(right.label)),
      }))

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
    const { householdId, weekStartDate } = c.req.valid('param')
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
        eventType: event.eventType as 'list_started' | 'item_checked',
        payload: event.payload as Record<string, unknown>,
      },
      201,
    )
  })

  app.openapi(getShoppingListRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const { householdId, weekStartDate } = c.req.valid('param')

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
    const { householdId, weekStartDate } = c.req.valid('param')
    const summary = await getShoppingListSummary(db, accessToken, householdId, weekStartDate)

    if (!summary) return c.json({ error: 'Household not found.' } as never, 404)
    return c.json(summary, 200)
  })

  return app
}

// Exported for tests that need to seed projection rows directly (bypassing
// appendShoppingListEvent) to prove the read path reflects the projection,
// never a replay of the log — same rationale as week-plan's exports.
export { foldEventIntoProjection, emptyProjectionState }
export type { TShoppingListProjectionState }
