import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { createDb } from '../src/db.js'
import { ignorePortionHistory } from '../src/portion-memory.js'
import { householdMemberships, householdPortionMemories, households } from '../src/schema.js'
import { fakeAccessToken } from './fake-access-token.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const describeWithDb = testDatabaseUrl ? describe : describe.skip

describeWithDb('Portion memory + RLS', () => {
  const db = createDb(testDatabaseUrl!)
  const userA = '11111111-1111-1111-1111-111111111111'
  const userB = '22222222-2222-2222-2222-222222222222'
  const recipeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  let householdAId: string
  let householdBId: string

  beforeEach(async () => {
    await db.execute(sql`delete from "household_portion_memories"`)
    await db.execute(sql`delete from "household_memberships"`)
    await db.execute(sql`delete from "households"`)
    const [a] = await db.insert(households).values({ name: 'A' }).returning({ id: households.id })
    const [b] = await db.insert(households).values({ name: 'B' }).returning({ id: households.id })
    householdAId = a!.id
    householdBId = b!.id
    await db.insert(householdMemberships).values([
      { householdId: householdAId, userId: userA, role: 'owner', status: 'active' },
      { householdId: householdBId, userId: userB, role: 'owner', status: 'active' },
    ])
  })

  afterAll(async () => {
    await db.execute(sql`delete from "household_portion_memories"`)
    await db.execute(sql`delete from "household_memberships"`)
    await db.execute(sql`delete from "households"`)
  })

  it('upserts one shared cutoff per household and recipe', async () => {
    const first = await ignorePortionHistory(db, fakeAccessToken(userA), userA, householdAId, recipeId)
    const second = await ignorePortionHistory(db, fakeAccessToken(userA), userA, householdAId, recipeId)
    const rows = await db.select().from(householdPortionMemories)

    expect(rows).toHaveLength(1)
    expect(second.getTime()).toBeGreaterThanOrEqual(first.getTime())
  })

  it('does not expose another household cutoff through RLS', async () => {
    await ignorePortionHistory(db, fakeAccessToken(userB), userB, householdBId, recipeId)
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userA })}, true)`)
      await tx.execute(sql`set local role authenticated`)
      return tx.select().from(householdPortionMemories).where(eq(householdPortionMemories.householdId, householdBId))
    })
    expect(rows).toEqual([])
  })

  it('returns 401 without a bearer token', async () => {
    const response = await buildApp(db).request(`/households/${householdAId}/portion-memory/${recipeId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'ignore' }),
    })
    expect(response.status).toBe(401)
  })
})
