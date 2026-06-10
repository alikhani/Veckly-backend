import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { clearActiveWeek, getActiveWeek, setActiveWeek } from '../src/active-week.js'
import { createDb } from '../src/db.js'
import { householdActiveWeeks, householdMemberships, households } from '../src/schema.js'
import { fakeAccessToken } from './fake-access-token.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL

const describeWithDb = testDatabaseUrl ? describe : describe.skip

describeWithDb('Household active week', () => {
  const db = createDb(testDatabaseUrl!)

  const userA = '11111111-1111-1111-1111-111111111111'
  const userB = '22222222-2222-2222-2222-222222222222'
  const userC = '33333333-3333-3333-3333-333333333333'

  let householdAId: string
  let householdBId: string

  beforeEach(async () => {
    await db.execute(sql`delete from "household_active_weeks"`)
    await db.execute(sql`delete from "household_memberships"`)
    await db.execute(sql`delete from "households"`)

    const [householdA] = await db.insert(households).values({ name: 'Household A' }).returning({ id: households.id })
    const [householdB] = await db.insert(households).values({ name: 'Household B' }).returning({ id: households.id })
    householdAId = householdA!.id
    householdBId = householdB!.id

    await db.insert(householdMemberships).values([
      { householdId: householdAId, userId: userA, role: 'owner', status: 'active' },
      { householdId: householdAId, userId: userC, role: 'member', status: 'removed' },
      { householdId: householdBId, userId: userB, role: 'owner', status: 'active' },
    ])
  })

  afterAll(async () => {
    await db.execute(sql`delete from "household_active_weeks"`)
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

  it('sets, reads, updates, and clears the active week for an active member', async () => {
    const saved = await setActiveWeek(db, fakeAccessToken(userA), userA, householdAId, {
      weekStartDate: '2026-06-08',
      timezone: 'Europe/Stockholm',
    })
    expect(saved).toMatchObject({
      householdId: householdAId,
      weekStartDate: '2026-06-08',
      timezone: 'Europe/Stockholm',
      updatedBy: userA,
    })

    const updated = await setActiveWeek(db, fakeAccessToken(userA), userA, householdAId, {
      weekStartDate: '2026-06-15',
      timezone: 'Europe/Stockholm',
    })
    expect(updated.weekStartDate).toBe('2026-06-15')

    const read = await getActiveWeek(db, fakeAccessToken(userA), householdAId)
    expect(read?.weekStartDate).toBe('2026-06-15')

    await expect(clearActiveWeek(db, fakeAccessToken(userA), householdAId)).resolves.toBe(true)
    await expect(getActiveWeek(db, fakeAccessToken(userA), householdAId)).resolves.toBeNull()
  })

  it('does not expose another household active week across RLS', async () => {
    await setActiveWeek(db, fakeAccessToken(userB), userB, householdBId, {
      weekStartDate: '2026-06-08',
      timezone: 'Europe/Stockholm',
    })

    const directRows = await asUser(userA, (tx) =>
      tx
        .select()
        .from(householdActiveWeeks)
        .where(and(eq(householdActiveWeeks.householdId, householdBId), eq(householdActiveWeeks.weekStartDate, '2026-06-08'))),
    )
    expect(directRows).toHaveLength(0)

    await expect(getActiveWeek(db, fakeAccessToken(userA), householdBId)).resolves.toBeNull()
  })

  it('refuses active week writes from non-members and removed members', async () => {
    await expect(
      setActiveWeek(db, fakeAccessToken(userA), userA, householdBId, {
        weekStartDate: '2026-06-08',
        timezone: 'Europe/Stockholm',
      }),
    ).rejects.toThrow(/row-level security/i)

    await expect(
      setActiveWeek(db, fakeAccessToken(userC), userC, householdAId, {
        weekStartDate: '2026-06-08',
        timezone: 'Europe/Stockholm',
      }),
    ).rejects.toThrow(/row-level security/i)
  })

  it('requires auth for active week routes', async () => {
    const app = buildApp(db)

    const getResponse = await app.request(`/households/${householdAId}/active-week`)
    expect(getResponse.status).toBe(401)

    const putResponse = await app.request(`/households/${householdAId}/active-week`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weekStartDate: '2026-06-08', timezone: 'Europe/Stockholm' }),
    })
    expect(putResponse.status).toBe(401)

    const deleteResponse = await app.request(`/households/${householdAId}/active-week`, { method: 'DELETE' })
    expect(deleteResponse.status).toBe(401)
  })
})
