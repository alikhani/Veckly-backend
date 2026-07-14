import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, desc, eq, inArray, or } from 'drizzle-orm'
import { requireAuth, type AuthedUser } from './auth.js'
import { appendStreamEvent, getStreamProjection } from './event-stream.js'
import { assertMembership } from './membership.js'
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

const ShoppingStatePayloadSchema = z.object({
  checkedItems: z.array(z.string().min(1)),
  pantryStock: z.record(z.string(), z.number().finite()),
  customItems: z.array(
    z.object({
      itemKey: z.string().min(1),
      label: z.string().min(1),
      category: z.string().min(1),
    }),
  ).optional().default([]),
}).openapi('ShoppingStatePayload')

const ShoppingStateReplacedPayloadSchema = z.object({
  eventType: z.literal('shopping_state_replaced'),
  state: ShoppingStatePayloadSchema,
})

const ShoppingListClearedPayloadSchema = z.object({
  eventType: z.literal('shopping_list_cleared'),
})

const ShoppingListEventPayloadSchema = z.discriminatedUnion('eventType', [
  ListStartedPayloadSchema,
  ItemCheckedPayloadSchema,
  ShoppingStateReplacedPayloadSchema,
  ShoppingListClearedPayloadSchema,
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
  eventType: z.enum(['list_started', 'item_checked', 'shopping_state_replaced', 'shopping_list_cleared']),
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
  isCustom: z.boolean(),
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

const ShoppingListStateResponseSchema = z.object({
  state: ShoppingStatePayloadSchema.nullable(),
  updatedAt: z.string().nullable(),
}).openapi('ShoppingListStateResponse')

const UpdateShoppingListStateRequestSchema = z.object({
  expectedUpdatedAt: z.string().nullable().optional(),
  state: ShoppingStatePayloadSchema.nullable(),
}).openapi('UpdateShoppingListStateRequest')

const UpdateShoppingListStateResponseSchema = z.object({
  ok: z.literal(true),
  updatedAt: z.string().nullable(),
}).openapi('UpdateShoppingListStateResponse')

const StaleShoppingListStateResponseSchema = z.object({
  error: z.literal('STALE_SHOPPING_STATE'),
  updatedAt: z.string().nullable(),
}).openapi('StaleShoppingListStateResponse')

// --- Projection fold --------------------------------------------------------
//
// Minimal shape needed to prove `item_checked` folds correctly — same
// "explicitly provisional" status as week-plan's projection state. `itemKey`
// is the only identity an item has right now, so `checkedItems` is keyed on
// it directly.
type TShoppingListProjectionState = {
  listStarted: boolean
  checkedItems: Record<string, boolean>
  pantryStock: Record<string, number>
  customItems: Array<{ itemKey: string; label: string; category: string }>
}

const emptyProjectionState = (): TShoppingListProjectionState => ({ listStarted: false, checkedItems: {}, pantryStock: {}, customItems: [] })

function checkedItemsArrayToMap(checkedItems: string[]) {
  return Object.fromEntries([...new Set(checkedItems)].map((itemKey) => [itemKey, true]))
}

function checkedItemsMapToArray(checkedItems: Record<string, boolean>) {
  return Object.entries(checkedItems)
    .filter(([, checked]) => checked)
    .map(([itemKey]) => itemKey)
    .sort((left, right) => left.localeCompare(right))
}

function foldEventIntoProjection(
  state: TShoppingListProjectionState,
  payload: z.infer<typeof ShoppingListEventPayloadSchema>,
): TShoppingListProjectionState {
  switch (payload.eventType) {
    case 'list_started':
      return { ...state, listStarted: true }
    case 'item_checked':
      return { ...state, checkedItems: { ...state.checkedItems, [payload.itemKey]: payload.checked } }
    case 'shopping_state_replaced':
      return {
        listStarted: true,
        checkedItems: checkedItemsArrayToMap(payload.state.checkedItems),
        pantryStock: payload.state.pantryStock,
        customItems: payload.state.customItems ?? [],
      }
    case 'shopping_list_cleared':
      return emptyProjectionState()
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
  const unit = normalizeKeyPart(ingredient.unit)
  return [category, item, unit].join(':')
}

function singularizeShoppingItem(value: string) {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, ' ')
  if (normalized.endsWith('ies') && normalized.length > 4) return `${normalized.slice(0, -3)}y`
  if (normalized.endsWith('oes') && normalized.length > 4) return normalized.slice(0, -2)
  if (normalized.endsWith('s') && !normalized.endsWith('ss') && normalized.length > 3) return normalized.slice(0, -1)
  return normalized
}

function buildCanonicalItemKey(ingredient: TRecipeIngredient) {
  const category = normalizeKeyPart(ingredient.category || 'Other')
  const item = normalizeKeyPart(singularizeShoppingItem(ingredient.item))
  const unit = normalizeKeyPart(ingredient.unit)
  return [category, item, unit].join(':')
}

function preferredShoppingLabel(current: string, candidate: string) {
  const currentTrimmed = current.trim()
  const candidateTrimmed = candidate.trim()
  const currentIsPlural = singularizeShoppingItem(currentTrimmed) !== currentTrimmed.toLowerCase()
  const candidateIsPlural = singularizeShoppingItem(candidateTrimmed) !== candidateTrimmed.toLowerCase()
  if (currentIsPlural !== candidateIsPlural) return currentIsPlural ? currentTrimmed : candidateTrimmed
  return currentTrimmed.localeCompare(candidateTrimmed) <= 0 ? currentTrimmed : candidateTrimmed
}

function formatAggregatedAmount(n: number): string {
  return Number.isInteger(n) ? String(n) : parseFloat(n.toFixed(2)).toString()
}

function readShoppingProjectionState(state: unknown): TShoppingListProjectionState {
  const candidate = state as (
    Partial<TShoppingListProjectionState> & { checkedItems?: unknown; pantryStock?: unknown; customItems?: unknown }
  ) | null | undefined
  const checkedItems = Array.isArray(candidate?.checkedItems)
    ? checkedItemsArrayToMap(candidate.checkedItems.filter((item): item is string => typeof item === 'string'))
    : candidate?.checkedItems && typeof candidate.checkedItems === 'object'
      ? candidate.checkedItems as Record<string, boolean>
      : {}
  const pantryStock = candidate?.pantryStock && typeof candidate.pantryStock === 'object'
    ? Object.fromEntries(
      Object.entries(candidate.pantryStock as Record<string, unknown>)
        .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])),
    )
    : {}
  const customItems = Array.isArray(candidate?.customItems)
    ? candidate.customItems
      .filter((item): item is { itemKey: string; label: string; category: string } => {
        if (!item || typeof item !== 'object') return false
        const candidateItem = item as Record<string, unknown>
        return typeof candidateItem.itemKey === 'string'
          && candidateItem.itemKey.trim().length > 0
          && typeof candidateItem.label === 'string'
          && candidateItem.label.trim().length > 0
          && typeof candidateItem.category === 'string'
          && candidateItem.category.trim().length > 0
      })
      .map((item) => ({
        itemKey: item.itemKey.trim(),
        label: item.label.trim(),
        category: item.category.trim(),
      }))
    : []

  return {
    listStarted: candidate?.listStarted === true,
    checkedItems,
    pantryStock,
    customItems,
  }
}

function toShoppingStatePayload(state: TShoppingListProjectionState): z.infer<typeof ShoppingStatePayloadSchema> | null {
  if (
    !state.listStarted
    && Object.keys(state.checkedItems).length === 0
    && Object.keys(state.pantryStock).length === 0
    && state.customItems.length === 0
  ) return null
  return {
    checkedItems: checkedItemsMapToArray(state.checkedItems),
    pantryStock: state.pantryStock,
    customItems: state.customItems,
  }
}

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

    const payload: z.infer<typeof ShoppingListEventPayloadSchema> = args.state === null
      ? { eventType: 'shopping_list_cleared' }
      : { eventType: 'shopping_state_replaced', state: args.state }
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
        .where(and(or(eq(recipes.householdId, householdId), eq(recipes.isPublic, true)), inArray(recipes.id, recipeIds)))
      : []

    const ingredientRows = recipeRows.flatMap((recipe) =>
      (recipe.ingredients as TRecipeIngredient[])
        .filter((ingredient) => ingredient.item.trim())
        .map((ingredient) => ({
          ingredient,
          rawItemKey: buildItemKey(ingredient),
          canonicalItemKey: buildCanonicalItemKey(ingredient),
        })),
    )
    const canonicalKeyVariants = new Map<string, Set<string>>()
    for (const row of ingredientRows) {
      const variants = canonicalKeyVariants.get(row.canonicalItemKey) ?? new Set<string>()
      variants.add(row.rawItemKey)
      canonicalKeyVariants.set(row.canonicalItemKey, variants)
    }

    type TItemAccumulator = {
      category: string
      label: string
      originalItemKeys: Set<string>
      totalAmount: number | null
      canSum: boolean
      unit: string | null
    }
    const accumulator = new Map<string, TItemAccumulator>()

    for (const { ingredient, rawItemKey, canonicalItemKey } of ingredientRows) {
      const itemKey = (canonicalKeyVariants.get(canonicalItemKey)?.size ?? 0) > 1 ? canonicalItemKey : rawItemKey
      const rawAmount = ingredient.amount?.trim() || null
      const parsed = rawAmount ? parseFloat(rawAmount) : null
      const validNum = parsed !== null && !isNaN(parsed) && isFinite(parsed)

      const existing = accumulator.get(itemKey)
      if (existing) {
        existing.originalItemKeys.add(rawItemKey)
        existing.label = preferredShoppingLabel(existing.label, ingredient.item)
        if (existing.canSum && validNum) {
          existing.totalAmount = (existing.totalAmount ?? 0) + parsed!
        } else {
          existing.canSum = false
          existing.totalAmount = null
        }
      } else {
        accumulator.set(itemKey, {
          category: ingredient.category?.trim() || 'Other',
          label: ingredient.item.trim(),
          originalItemKeys: new Set([rawItemKey]),
          totalAmount: validNum ? parsed! : null,
          canSum: validNum,
          unit: ingredient.unit?.trim() || null,
        })
      }
    }

    const itemsByKey = new Map<string, {
      category: string
      label: string
      amount: string | null
      unit: string | null
      checked: boolean
      isCustom: boolean
    }>()
    for (const [itemKey, item] of accumulator) {
      itemsByKey.set(itemKey, {
        category: item.category,
        label: item.label,
        amount: item.totalAmount !== null ? formatAggregatedAmount(item.totalAmount) : null,
        unit: item.unit,
        checked: shoppingState.checkedItems[itemKey] === true || [...item.originalItemKeys].some((originalKey) => shoppingState.checkedItems[originalKey] === true),
        isCustom: false,
      })
    }

    for (const item of shoppingState.customItems) {
      itemsByKey.set(item.itemKey, {
        category: item.category,
        label: item.label,
        amount: null,
        unit: null,
        checked: shoppingState.checkedItems[item.itemKey] === true,
        isCustom: true,
      })
    }

    const groupsByCategory = new Map<string, Array<{
      itemKey: string
      label: string
      amount: string | null
      unit: string | null
      checked: boolean
      isCustom: boolean
    }>>()
    for (const [itemKey, item] of itemsByKey) {
      const group = groupsByCategory.get(item.category) ?? []
      group.push({ itemKey, label: item.label, amount: item.amount, unit: item.unit, checked: item.checked, isCustom: item.isCustom })
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
    const summary = await getShoppingListSummary(db, accessToken, householdId, weekStartDate)

    if (!summary) return c.json({ error: 'Household not found.' } as never, 404)
    c.header('Cache-Control', 'private, max-age=300')
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
