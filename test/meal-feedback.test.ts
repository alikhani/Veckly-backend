import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { createDb } from '../src/db.js'
import { households, householdMemberships, mealFeedback } from '../src/schema.js'
import { listMealFeedback, removeMealFeedback, upsertMealFeedback } from '../src/meal-feedback.js'
import { fakeAccessToken } from './fake-access-token.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const describeWithDb = testDatabaseUrl ? describe : describe.skip

describeWithDb('Meal feedback + RLS', () => {
  const db = createDb(testDatabaseUrl!)

  const userA = '11111111-1111-1111-1111-111111111111'
  const userB = '22222222-2222-2222-2222-222222222222'
  let householdAId: string
  let householdBId: string

  beforeEach(async () => {
    await db.execute(sql`delete from "meal_feedback"`)
    await db.execute(sql`delete from "household_memberships"`)
    await db.execute(sql`delete from "households"`)

    const [householdA] = await db.insert(households).values({ name: 'Household A' }).returning({ id: households.id })
    const [householdB] = await db.insert(households).values({ name: 'Household B' }).returning({ id: households.id })
    householdAId = householdA!.id
    householdBId = householdB!.id

    await db.insert(householdMemberships).values([
      { householdId: householdAId, userId: userA, role: 'owner', status: 'active' },
      { householdId: householdAId, userId: userB, role: 'member', status: 'active' },
      { householdId: householdBId, userId: userB, role: 'owner', status: 'active' },
    ])
  })

  afterAll(async () => {
    await db.execute(sql`delete from "meal_feedback"`)
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

  it('upserts, lists as MealPlanner-compatible keyed feedback, and removes a vote', async () => {
    const first = await upsertMealFeedback(db, fakeAccessToken(userA), userA, householdAId, 'taco-rice-bowls', {
      vote: 'up',
      signal: 'family-approved',
    })

    expect(first.feedback).toEqual({ vote: 'up', signal: 'family-approved' })

    await upsertMealFeedback(db, fakeAccessToken(userA), userA, householdAId, 'taco-rice-bowls', { vote: 'down' })

    const listed = await listMealFeedback(db, fakeAccessToken(userA), userA, householdAId)
    expect(listed.feedback).toEqual({ 'taco-rice-bowls': { vote: 'down' } })
    expect(listed.items).toHaveLength(1)

    await removeMealFeedback(db, fakeAccessToken(userA), userA, householdAId, 'taco-rice-bowls')

    await expect(listMealFeedback(db, fakeAccessToken(userA), userA, householdAId)).resolves.toEqual({
      feedback: {},
      items: [],
    })
  })

  it('does not expose another household feedback through RLS', async () => {
    await upsertMealFeedback(db, fakeAccessToken(userB), userB, householdBId, 'private-meal', { vote: 'up' })

    const rows = await asUser(userA, (tx) =>
      tx.select().from(mealFeedback).where(eq(mealFeedback.mealId, 'private-meal')),
    )

    expect(rows).toHaveLength(0)
  })

  it('does not expose another member own feedback in the same household', async () => {
    await upsertMealFeedback(db, fakeAccessToken(userB), userB, householdAId, 'shared-meal', { vote: 'up' })

    const listed = await listMealFeedback(db, fakeAccessToken(userA), userA, householdAId)

    expect(listed.feedback).toEqual({})
  })

  it('refuses direct insert for a household where the user is not an active member', async () => {
    await expect(
      asUser(userA, (tx) =>
        tx.insert(mealFeedback).values({
          householdId: householdBId,
          userId: userA,
          mealId: 'sneaky-meal',
          vote: 'up',
        }),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('refuses direct insert attributed to a different user', async () => {
    await expect(
      asUser(userA, (tx) =>
        tx.insert(mealFeedback).values({
          householdId: householdAId,
          userId: userB,
          mealId: 'impersonated-meal',
          vote: 'up',
        }),
      ),
    ).rejects.toThrow(/row-level security/i)

    const rows = await db
      .select()
      .from(mealFeedback)
      .where(and(eq(mealFeedback.householdId, householdAId), eq(mealFeedback.mealId, 'impersonated-meal')))
    expect(rows).toEqual([])
  })

  it('internal strangle routes preserve MealPlanner response shapes', async () => {
    const previousInternalKey = process.env.VECKLY_INTERNAL_API_KEY
    process.env.VECKLY_INTERNAL_API_KEY = 'test-internal-key'
    try {
      const app = buildApp(db)
      const headers = {
        Authorization: `Bearer ${process.env.VECKLY_INTERNAL_API_KEY}`,
        'Content-Type': 'application/json',
        'X-User-Id': userA,
      }

      const upsertResponse = await app.request('/internal/meal-feedback', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ mealId: 'taco-rice-bowls', feedback: { vote: 'up', signal: 'family-approved' } }),
      })
      expect(upsertResponse.status).toBe(200)
      await expect(upsertResponse.json()).resolves.toEqual({ ok: true })

      const listResponse = await app.request('/internal/meal-feedback', { headers })
      expect(listResponse.status).toBe(200)
      await expect(listResponse.json()).resolves.toEqual({
        'taco-rice-bowls': { vote: 'up', signal: 'family-approved' },
      })

      const removeResponse = await app.request('/internal/meal-feedback', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ mealId: 'taco-rice-bowls', feedback: null }),
      })
      expect(removeResponse.status).toBe(200)
      await expect(removeResponse.json()).resolves.toEqual({ ok: true })

      const emptyResponse = await app.request('/internal/meal-feedback', { headers })
      expect(emptyResponse.status).toBe(200)
      await expect(emptyResponse.json()).resolves.toEqual({})
    } finally {
      if (previousInternalKey === undefined) {
        delete process.env.VECKLY_INTERNAL_API_KEY
      } else {
        process.env.VECKLY_INTERNAL_API_KEY = previousInternalKey
      }
    }
  })
})
