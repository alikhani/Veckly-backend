import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { createDb } from '../src/db.js'
import { createProductEvent } from '../src/product-events.js'
import { households, householdMemberships, productEvents } from '../src/schema.js'
import { fakeAccessToken } from './fake-access-token.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const describeWithDb = testDatabaseUrl ? describe : describe.skip

describeWithDb('Product events + RLS', () => {
  const db = createDb(testDatabaseUrl!)

  const userA = '11111111-1111-1111-1111-111111111111'
  const userB = '22222222-2222-2222-2222-222222222222'
  let householdAId: string
  let householdBId: string

  beforeEach(async () => {
    await db.execute(sql`delete from "product_events"`)
    await db.execute(sql`delete from "household_memberships"`)
    await db.execute(sql`delete from "households"`)

    const [householdA] = await db.insert(households).values({ name: 'Household A' }).returning({ id: households.id })
    const [householdB] = await db.insert(households).values({ name: 'Household B' }).returning({ id: households.id })
    householdAId = householdA!.id
    householdBId = householdB!.id

    await db.insert(householdMemberships).values([
      { householdId: householdAId, userId: userA, role: 'owner', status: 'active' },
      { householdId: householdBId, userId: userB, role: 'owner', status: 'active' },
    ])
  })

  afterAll(async () => {
    await db.execute(sql`delete from "product_events"`)
    await db.execute(sql`delete from "household_memberships"`)
    await db.execute(sql`delete from "households"`)
  })

  async function asUser<T>(userId: string, run: (tx: typeof db) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId })}, true)`)
      await tx.execute(sql`set local role authenticated`)
      return run(tx as unknown as typeof db)
    })
  }

  it('records a beta funnel event for an active household member', async () => {
    const event = await createProductEvent(db, fakeAccessToken(userA), userA, householdAId, {
      eventName: 'week_completed',
      weekStartDate: '2026-07-13',
      properties: { plannedDinners: 5 },
    })

    expect(event).toMatchObject({
      householdId: householdAId,
      userId: userA,
      eventName: 'week_completed',
      weekStartDate: '2026-07-13',
      properties: { plannedDinners: 5 },
    })
    expect(event.occurredAt).toEqual(expect.any(String))
  })

  it('stores empty properties when the client does not send metadata', async () => {
    const event = await createProductEvent(db, fakeAccessToken(userA), userA, householdAId, {
      eventName: 'shopping_shared',
      properties: {},
    })

    expect(event.weekStartDate).toBeNull()
    expect(event.properties).toEqual({})
  })

  it('does not expose another household event through RLS', async () => {
    await createProductEvent(db, fakeAccessToken(userB), userB, householdBId, {
      eventName: 'retro_completed',
      properties: {},
    })

    const rows = await asUser(userA, (tx) =>
      tx.select().from(productEvents).where(eq(productEvents.householdId, householdBId)),
    )

    expect(rows).toHaveLength(0)
  })

  it('refuses direct insert for a household where the user is not an active member', async () => {
    await expect(
      asUser(userA, (tx) =>
        tx.insert(productEvents).values({
          householdId: householdBId,
          userId: userA,
          eventName: 'partner_invite_clicked',
          properties: {},
        }),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('refuses direct insert attributed to another user', async () => {
    await expect(
      asUser(userA, (tx) =>
        tx.insert(productEvents).values({
          householdId: householdAId,
          userId: userB,
          eventName: 'shopping_main_list_completed',
          properties: {},
        }),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('returns 401 from the public route when no bearer token is supplied', async () => {
    const app = buildApp(db)

    const response = await app.request(`/households/${householdAId}/product-events`, {
      method: 'POST',
      body: JSON.stringify({ eventName: 'week_completed' }),
      headers: { 'Content-Type': 'application/json' },
    })

    expect(response.status).toBe(401)
  })
})
