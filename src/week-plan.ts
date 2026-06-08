import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, eq, desc } from 'drizzle-orm'
import { requireAuth, type AuthedUser } from './auth.js'
import { withRls } from './rls.js'
import { weekPlanEvents, weekPlanProjections } from './schema.js'
import type { Db } from './db.js'

// --- Wire shapes -----------------------------------------------------------
//
// Flat envelope — `{ causedBy, eventType, ...fields }` — matching the design
// doc's `TWeekPlanEvent = {...} & TWeekPlanEventPayload` intersection (not a
// nested `payload` object). `eventType` doubles as the discriminant for both
// the Zod union (HTTP boundary validation) and the `event_type` column
// (queryable without reaching into JSONB).

const CausedBySchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('user'), userId: z.string().uuid() }),
  z.object({ source: z.literal('algorithm'), algorithmVersion: z.string(), triggeredByUserId: z.string().uuid() }),
  z.object({ source: z.literal('system'), reason: z.string() }),
]).openapi('CausedBy')

const dayOfWeek = z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'])

// Minimal lifecycle marker — this slice proves the append/fold/read mechanism,
// not WeekStarted's eventual real shape (the design doc lists ~15 event types;
// these two are enough to prove the pattern earns its keep).
const WeekStartedPayloadSchema = z.object({
  eventType: z.literal('week_started'),
})

// `recipeRef` is a placeholder freeform identifier, not a real FK — recipes
// don't have a domain model yet (design doc §4 is future work). Coupling the
// event-sourcing proof to a domain that doesn't exist yet would be backwards.
const MealAssignedPayloadSchema = z.object({
  eventType: z.literal('meal_assigned'),
  dayOfWeek,
  recipeRef: z.string().min(1),
})

const WeekPlanEventPayloadSchema = z.discriminatedUnion('eventType', [
  WeekStartedPayloadSchema,
  MealAssignedPayloadSchema,
])

const AppendWeekPlanEventRequestSchema = z.object({
  causedBy: CausedBySchema,
}).and(WeekPlanEventPayloadSchema).openapi('AppendWeekPlanEventRequest')

const WeekPlanEventSchema = z.object({
  id: z.string().uuid(),
  householdId: z.string().uuid(),
  weekStartDate: z.string(),
  sequenceNumber: z.number().int(),
  occurredAt: z.string(),
  causedBy: CausedBySchema,
  eventType: z.enum(['week_started', 'meal_assigned']),
  payload: z.record(z.string(), z.unknown()),
}).openapi('WeekPlanEvent')

const WeekPlanProjectionSchema = z.object({
  householdId: z.string().uuid(),
  weekStartDate: z.string(),
  state: z.record(z.string(), z.unknown()),
  updatedAt: z.string(),
}).openapi('WeekPlanProjection')

const ParamsSchema = z.object({
  householdId: z.string().uuid(),
  weekStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'),
})

// --- Projection fold --------------------------------------------------------
//
// The minimal shape needed to prove `meal_assigned` folds correctly. Explicitly
// provisional — the design doc itself flags the projection shape as an open
// implementation-time question; freezing it now, before the other ~13 event
// types are scoped, would be premature.
type TWeekPlanProjectionState = {
  weekStarted: boolean
  meals: Partial<Record<z.infer<typeof dayOfWeek>, { recipeRef: string }>>
}

const emptyProjectionState = (): TWeekPlanProjectionState => ({ weekStarted: false, meals: {} })

function foldEventIntoProjection(
  state: TWeekPlanProjectionState,
  payload: z.infer<typeof WeekPlanEventPayloadSchema>,
): TWeekPlanProjectionState {
  switch (payload.eventType) {
    case 'week_started':
      return { ...state, weekStarted: true }
    case 'meal_assigned':
      return { ...state, meals: { ...state.meals, [payload.dayOfWeek]: { recipeRef: payload.recipeRef } } }
  }
}

// --- The transactional write path -------------------------------------------
//
// Append the event and fold it into the projection in the same `withRls`
// transaction — if either step throws, both roll back. `withRls` needs zero
// changes: it already hands back `tx` typed as `Db`, and a flat sequence of
// statements against it gets atomicity from the one outer transaction it
// opened (postgres-js nested transactions become savepoints on the same
// connection — confirmed via node_modules/drizzle-orm/postgres-js/session.js).
async function appendWeekPlanEvent(
  db: Db,
  accessToken: string,
  args: { householdId: string; weekStartDate: string; causedBy: z.infer<typeof CausedBySchema>; payload: z.infer<typeof WeekPlanEventPayloadSchema> },
) {
  return withRls(db, accessToken, async (tx) => {
    // Read-then-insert is sufficient at this product's realistic scale (one
    // real session per household per week — design doc §6); the unique index
    // on (household_id, week_start_date, sequence_number) is the race backstop
    // that turns a concurrent double-append into a constraint violation rather
    // than a silent corruption. `select ... for update` is the named escalation
    // path if batch-generation concurrency (e.g. PlanGenerated) ever becomes real.
    const [latest] = await tx
      .select({ sequenceNumber: weekPlanEvents.sequenceNumber })
      .from(weekPlanEvents)
      .where(and(eq(weekPlanEvents.householdId, args.householdId), eq(weekPlanEvents.weekStartDate, args.weekStartDate)))
      .orderBy(desc(weekPlanEvents.sequenceNumber))
      .limit(1)

    const nextSequenceNumber = (latest?.sequenceNumber ?? 0) + 1

    const { eventType, ...payloadFields } = args.payload

    const [event] = await tx
      .insert(weekPlanEvents)
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
      .select({ state: weekPlanProjections.state })
      .from(weekPlanProjections)
      .where(and(eq(weekPlanProjections.householdId, args.householdId), eq(weekPlanProjections.weekStartDate, args.weekStartDate)))

    const currentState = (existingProjection?.state as TWeekPlanProjectionState | undefined) ?? emptyProjectionState()
    const nextState = foldEventIntoProjection(currentState, args.payload)

    await tx
      .insert(weekPlanProjections)
      .values({ householdId: args.householdId, weekStartDate: args.weekStartDate, state: nextState, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [weekPlanProjections.householdId, weekPlanProjections.weekStartDate],
        set: { state: nextState, updatedAt: new Date() },
      })

    return event
  })
}

// --- Routes ------------------------------------------------------------------

const appendWeekPlanEventRoute = createRoute({
  method: 'post',
  path: '/households/{householdId}/week-plans/{weekStartDate}/events',
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

export function buildWeekPlanRoutes(db: Db) {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()

  // Hono middleware doesn't cross OpenAPIHono sub-app boundaries — the
  // households module registers its own `requireAuth` on `/households/*`,
  // and so must this one (it doesn't inherit the registration when mounted
  // into the parent app via `.route('/', ...)`).
  app.use('/households/*', requireAuth)

  app.openapi(appendWeekPlanEventRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const { householdId, weekStartDate } = c.req.valid('param')
    const body = c.req.valid('json')
    const { causedBy, ...payload } = body

    const event = await appendWeekPlanEvent(db, accessToken, {
      householdId,
      weekStartDate,
      causedBy,
      payload: payload as z.infer<typeof WeekPlanEventPayloadSchema>,
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

  app.openapi(getWeekPlanRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const { householdId, weekStartDate } = c.req.valid('param')

    // Exactly one query, against the projection only — this is the one rule
    // the entire pattern hinges on (design doc §2: "never replay the event
    // log on the read path"). It must never reference week_plan_events.
    const [projection] = await withRls(db, accessToken, (tx) =>
      tx
        .select()
        .from(weekPlanProjections)
        .where(and(eq(weekPlanProjections.householdId, householdId), eq(weekPlanProjections.weekStartDate, weekStartDate))),
    )

    if (!projection) return c.json({ error: 'No week plan found for this week' }, 404)

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
// appendWeekPlanEvent) to prove the read path reflects the projection, never a
// replay of the log.
export { foldEventIntoProjection, emptyProjectionState }
export type { TWeekPlanProjectionState }
