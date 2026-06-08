import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, eq, desc } from 'drizzle-orm'
import { requireAuth, type AuthedUser } from './auth.js'
import { withRls } from './rls.js'
import { shoppingListEvents, shoppingListProjections } from './schema.js'
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

// --- The transactional write path -------------------------------------------
//
// Identical shape to `appendWeekPlanEvent`: append the event and fold it into
// the projection inside one `withRls` transaction, so either both persist or
// neither does. See that function's comments for why `withRls` needs no
// changes to support this nested-transaction shape.
async function appendShoppingListEvent(
  db: Db,
  accessToken: string,
  args: { householdId: string; weekStartDate: string; causedBy: z.infer<typeof CausedBySchema>; payload: z.infer<typeof ShoppingListEventPayloadSchema> },
) {
  return withRls(db, accessToken, async (tx) => {
    // Same "read-then-insert is sufficient at this product's realistic scale"
    // reasoning as week-plan — see that function's comment for the race
    // analysis and the unique-index backstop.
    const [latest] = await tx
      .select({ sequenceNumber: shoppingListEvents.sequenceNumber })
      .from(shoppingListEvents)
      .where(and(eq(shoppingListEvents.householdId, args.householdId), eq(shoppingListEvents.weekStartDate, args.weekStartDate)))
      .orderBy(desc(shoppingListEvents.sequenceNumber))
      .limit(1)

    const nextSequenceNumber = (latest?.sequenceNumber ?? 0) + 1

    const { eventType, ...payloadFields } = args.payload

    const [event] = await tx
      .insert(shoppingListEvents)
      .values({
        householdId: args.householdId,
        weekStartDate: args.weekStartDate,
        sequenceNumber: nextSequenceNumber,
        causedBy: args.causedBy,
        eventType,
        payload: payloadFields,
      })
      .returning()

    if (!event) throw new Error('Insert did not return the persisted event')

    const [existingProjection] = await tx
      .select({ state: shoppingListProjections.state })
      .from(shoppingListProjections)
      .where(and(eq(shoppingListProjections.householdId, args.householdId), eq(shoppingListProjections.weekStartDate, args.weekStartDate)))

    const currentState = (existingProjection?.state as TShoppingListProjectionState | undefined) ?? emptyProjectionState()
    const nextState = foldEventIntoProjection(currentState, args.payload)

    await tx
      .insert(shoppingListProjections)
      .values({ householdId: args.householdId, weekStartDate: args.weekStartDate, state: nextState, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [shoppingListProjections.householdId, shoppingListProjections.weekStartDate],
        set: { state: nextState, updatedAt: new Date() },
      })

    return event
  })
}

// --- Routes ------------------------------------------------------------------

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

    const event = await appendShoppingListEvent(db, accessToken, {
      householdId,
      weekStartDate,
      causedBy,
      payload: payload as z.infer<typeof ShoppingListEventPayloadSchema>,
    })

    return c.json(
      {
        id: event.id,
        householdId: event.householdId,
        weekStartDate: event.weekStartDate,
        sequenceNumber: event.sequenceNumber,
        occurredAt: event.occurredAt.toISOString(),
        causedBy: event.causedBy as z.infer<typeof CausedBySchema>,
        eventType: event.eventType,
        payload: event.payload as Record<string, unknown>,
      },
      201,
    )
  })

  app.openapi(getShoppingListRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const { householdId, weekStartDate } = c.req.valid('param')

    // Exactly one query, against the projection only — same read-path rule as
    // week-plan's: never replay the event log on the read path.
    const [projection] = await withRls(db, accessToken, (tx) =>
      tx
        .select()
        .from(shoppingListProjections)
        .where(and(eq(shoppingListProjections.householdId, householdId), eq(shoppingListProjections.weekStartDate, weekStartDate))),
    )

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

  return app
}

// Exported for tests that need to seed projection rows directly (bypassing
// appendShoppingListEvent) to prove the read path reflects the projection,
// never a replay of the log — same rationale as week-plan's exports.
export { foldEventIntoProjection, emptyProjectionState }
export type { TShoppingListProjectionState }
