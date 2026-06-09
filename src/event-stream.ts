import { and, eq, desc } from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'
import { withRls } from './rls.js'
import type { Db } from './db.js'

export type PersistedStreamEvent = {
  id: string
  householdId: string
  weekStartDate: string
  sequenceNumber: number
  occurredAt: Date
  causedBy: unknown
  eventType: string
  payload: unknown
}

export type PersistedStreamProjection = {
  householdId: string
  weekStartDate: string
  state: unknown
  updatedAt: Date
}

type StreamTables = {
  events: PgTable
  projections: PgTable
}

// The transactional shape proven twice now, byte-identical both times
// (week-plan, then shopping-list): append an event to a per-(household, week)
// stream, fold it into the materialized projection, and persist both from one
// `withRls` transaction so either both land or neither does.
//
// Drizzle's table types don't unify across tables whose `event_type` columns
// reference distinct `pgEnum`s — the table arguments are duck-typed at this
// boundary instead (the same kind of cast `test/week-plan.test.ts` already
// leans on for its debug-db setup, `as unknown as typeof db`). The column
// NAMES are the real, load-bearing contract — `householdId`, `weekStartDate`,
// `sequenceNumber`, `causedBy`, `eventType`, `payload` on events;
// `householdId`, `weekStartDate`, `state`, `updatedAt` on projections — and
// both 0003's and 0008's migrations enforce that shape at the schema level
// via matching unique indexes. TypeScript isn't the only thing holding it.
export async function appendStreamEvent<TPayload extends { eventType: string }, TState>(
  db: Db,
  accessToken: string,
  tables: StreamTables,
  config: {
    fold: (state: TState, payload: TPayload) => TState
    emptyState: () => TState
  },
  args: { householdId: string; weekStartDate: string; causedBy: unknown; payload: TPayload },
): Promise<PersistedStreamEvent> {
  const events = tables.events as any
  const projections = tables.projections as any

  return withRls(db, accessToken, async (tx) => {
    // Read-then-insert is sufficient at this product's realistic scale (one
    // real session per household per week — design doc §6); the unique index
    // on (household_id, week_start_date, sequence_number) is the race backstop
    // that turns a concurrent double-append into a constraint violation rather
    // than a silent corruption. `select ... for update` is the named escalation
    // path if batch-generation concurrency ever becomes real — both instances
    // independently arrived at this same reasoning, which is itself a signal
    // it belongs here rather than copy-pasted per stream.
    const [latest] = await tx
      .select({ sequenceNumber: events.sequenceNumber })
      .from(events)
      .where(and(eq(events.householdId, args.householdId), eq(events.weekStartDate, args.weekStartDate)))
      .orderBy(desc(events.sequenceNumber))
      .limit(1)

    const nextSequenceNumber = (latest?.sequenceNumber ?? 0) + 1

    const { eventType, ...payloadFields } = args.payload

    const [event] = await tx
      .insert(events)
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
      .select({ state: projections.state })
      .from(projections)
      .where(and(eq(projections.householdId, args.householdId), eq(projections.weekStartDate, args.weekStartDate)))

    const currentState = (existingProjection?.state as TState | undefined) ?? config.emptyState()
    const nextState = config.fold(currentState, args.payload)

    await tx
      .insert(projections)
      .values({ householdId: args.householdId, weekStartDate: args.weekStartDate, state: nextState, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [projections.householdId, projections.weekStartDate],
        set: { state: nextState, updatedAt: new Date() },
      })

    return event as PersistedStreamEvent
  })
}

// The read-path rule both instances independently named the same way: exactly
// one query, against the projection only — never replay the event log.
export async function getStreamProjection(
  db: Db,
  accessToken: string,
  projectionsTable: PgTable,
  args: { householdId: string; weekStartDate: string },
): Promise<PersistedStreamProjection | undefined> {
  const projections = projectionsTable as any

  const [projection] = await withRls(db, accessToken, (tx) =>
    tx
      .select()
      .from(projections)
      .where(and(eq(projections.householdId, args.householdId), eq(projections.weekStartDate, args.weekStartDate))),
  )

  return projection as PersistedStreamProjection | undefined
}
