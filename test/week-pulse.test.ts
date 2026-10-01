import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { createDb } from '../src/db.js'
import { householdMemberships, householdWeekPulses, households, userProfiles } from '../src/schema.js'
import { buildWeekPulseResponse, isDateInWeek, upsertWeekPulse } from '../src/week-pulse.js'
import { fakeAccessToken } from './fake-access-token.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const describeWithDb = testDatabaseUrl ? describe : describe.skip

describeWithDb('Household week pulse + RLS', () => {
  const db = createDb(testDatabaseUrl!)
  const userA = '11111111-1111-1111-1111-111111111111'
  const userB = '22222222-2222-2222-2222-222222222222'
  const stranger = '33333333-3333-3333-3333-333333333333'
  let householdId: string
  let otherHouseholdId: string

  beforeEach(async () => {
    await db.execute(sql`delete from "household_week_pulses"`)
    await db.execute(sql`delete from "user_profiles"`)
    await db.execute(sql`delete from "household_memberships"`)
    await db.execute(sql`delete from "households"`)
    const [household] = await db.insert(households).values({ name: 'Household A' }).returning({ id: households.id })
    const [other] = await db.insert(households).values({ name: 'Household B' }).returning({ id: households.id })
    householdId = household!.id
    otherHouseholdId = other!.id
    await db.insert(householdMemberships).values([
      { householdId, userId: userA, role: 'owner', status: 'active' },
      { householdId, userId: userB, role: 'member', status: 'active' },
      { householdId: otherHouseholdId, userId: stranger, role: 'owner', status: 'active' },
    ])
    await db.insert(userProfiles).values([
      { userId: userA, givenName: 'Ava' },
      { userId: userB, givenName: 'Bo' },
    ])
  })

  afterAll(async () => {
    await db.execute(sql`delete from "household_week_pulses"`)
    await db.execute(sql`delete from "user_profiles"`)
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

  it('lets each member contribute and read the combined response state', async () => {
    await upsertWeekPulse(db, fakeAccessToken(userA), userA, householdId, '2026-10-05', {
      awayDates: ['2026-10-07'], wishedMeal: 'Tacos', simpleDate: '2026-10-08',
    })

    const pulse = await buildWeekPulseResponse(db, fakeAccessToken(userB), householdId, '2026-10-05', userB)
    expect(pulse).toMatchObject({ responseCount: 1, memberCount: 2 })
    expect(pulse.members).toEqual([
      expect.objectContaining({ givenName: 'Ava', responded: true, isCurrentUser: false, wishedMeal: 'Tacos' }),
      expect.objectContaining({ givenName: 'Bo', responded: false, isCurrentUser: true, wishedMeal: null }),
    ])
  })

  it('rejects dates outside the requested week', async () => {
    expect(isDateInWeek('2026-10-05', '2026-10-11')).toBe(true)
    expect(isDateInWeek('2026-10-05', '2026-10-12')).toBe(false)
  })

  it('allows household reads but prevents changing another member row', async () => {
    await db.insert(householdWeekPulses).values({ householdId, weekStartDate: '2026-10-05', userId: userB, awayDates: [], wishedMeal: 'Soup' })

    const updated = await asUser(userA, (tx) => tx.update(householdWeekPulses)
      .set({ wishedMeal: 'Impersonated' })
      .where(and(eq(householdWeekPulses.householdId, householdId), eq(householdWeekPulses.userId, userB)))
      .returning())
    expect(updated).toEqual([])

    const visible = await asUser(userA, (tx) => tx.select().from(householdWeekPulses))
    expect(visible).toHaveLength(1)
  })

  it('does not expose another household pulse', async () => {
    await db.insert(householdWeekPulses).values({ householdId: otherHouseholdId, weekStartDate: '2026-10-05', userId: stranger, awayDates: [], wishedMeal: 'Private' })
    const visible = await asUser(userA, (tx) => tx.select().from(householdWeekPulses))
    expect(visible).toEqual([])
  })
})
