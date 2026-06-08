import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { createDb } from '../src/db.js'
import { households, householdMemberships } from '../src/schema.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL

const describeWithDb = testDatabaseUrl ? describe : describe.skip

describeWithDb('RLS boundary on households / household_memberships', () => {
  const db = createDb(testDatabaseUrl!)

  const userA = '11111111-1111-1111-1111-111111111111'
  const userB = '22222222-2222-2222-2222-222222222222'
  let householdAId: string
  let householdBId: string

  // Migrations and the `authenticated` role grant are applied once, globally,
  // before any suite starts (see test/global-setup.ts) — applying them per-file
  // would race across vitest's parallel worker processes on the shared
  // TEST_DATABASE_URL ("type already exists").

  beforeEach(async () => {
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
    await db.execute(sql`delete from "household_memberships"`)
    await db.execute(sql`delete from "households"`)
  })

  async function queryAsUser(userId: string) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId })}, true)`)
      await tx.execute(sql`set local role authenticated`)
      return tx
        .select({ id: households.id, name: households.name, role: householdMemberships.role })
        .from(householdMemberships)
        .innerJoin(households, eq(households.id, householdMemberships.householdId))
        .where(eq(householdMemberships.status, 'active'))
    })
  }

  it('returns only the households the authenticated user belongs to', async () => {
    const resultsForA = await queryAsUser(userA)

    expect(resultsForA).toHaveLength(1)
    expect(resultsForA[0]?.id).toBe(householdAId)
    expect(resultsForA.some((row) => row.id === householdBId)).toBe(false)
  })

  it('never returns another household even when the query tries to ask for it directly', async () => {
    const crossHouseholdAttempt = await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userA })}, true)`)
      await tx.execute(sql`set local role authenticated`)
      // Deliberately query household B by id, as user A — RLS, not the WHERE
      // clause, is what must stop this from returning a row.
      return tx.select({ id: households.id }).from(households).where(eq(households.id, householdBId))
    })

    expect(crossHouseholdAttempt).toHaveLength(0)
  })

  it('returns the other household entirely when queried as its own member', async () => {
    const resultsForB = await queryAsUser(userB)

    expect(resultsForB).toHaveLength(1)
    expect(resultsForB[0]?.id).toBe(householdBId)
  })

  it('returns nothing for a user with no membership at all', async () => {
    const stranger = '33333333-3333-3333-3333-333333333333'
    const results = await queryAsUser(stranger)

    expect(results).toHaveLength(0)
  })
})
