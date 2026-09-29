import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { createDb } from '../src/db.js'
import { listMealOutcomes, upsertMealOutcome } from '../src/meal-outcomes.js'
import { householdMealOutcomes, householdMemberships, households } from '../src/schema.js'
import { fakeAccessToken } from './fake-access-token.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const describeWithDb = testDatabaseUrl ? describe : describe.skip

describeWithDb('Meal outcomes + RLS', () => {
  const db = createDb(testDatabaseUrl!)

  const userA = '11111111-1111-1111-1111-111111111111'
  const userB = '22222222-2222-2222-2222-222222222222'
  const userC = '33333333-3333-3333-3333-333333333333'
  const plannedRecipeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const actualRecipeId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const weekStartDate = '2026-09-28'
  const date = '2026-09-30'
  let householdAId: string
  let householdBId: string

  beforeEach(async () => {
    await db.execute(sql`delete from "household_meal_outcomes"`)
    await db.execute(sql`delete from "household_memberships"`)
    await db.execute(sql`delete from "households"`)

    const [householdA] = await db.insert(households).values({ name: 'Household A' }).returning({ id: households.id })
    const [householdB] = await db.insert(households).values({ name: 'Household B' }).returning({ id: households.id })
    householdAId = householdA!.id
    householdBId = householdB!.id

    await db.insert(householdMemberships).values([
      { householdId: householdAId, userId: userA, role: 'owner', status: 'active' },
      { householdId: householdAId, userId: userB, role: 'member', status: 'active' },
      { householdId: householdBId, userId: userC, role: 'owner', status: 'active' },
    ])
  })

  afterAll(async () => {
    await db.execute(sql`delete from "household_meal_outcomes"`)
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

  it('upserts one shared outcome and lets another active member correct it', async () => {
    await upsertMealOutcome(db, fakeAccessToken(userA), userA, householdAId, date, {
      weekStartDate,
      plannedRecipeId,
      status: 'cooked',
      portionOutcome: 'too_little',
      reason: 'family_approved',
    })

    const corrected = await upsertMealOutcome(db, fakeAccessToken(userB), userB, householdAId, date, {
      weekStartDate,
      plannedRecipeId,
      status: 'changed_plan',
      portionOutcome: 'right_amount',
      reason: 'easy_weeknight',
      actualRecipeId,
      actualMealLabel: 'Leftovers',
    })

    expect(corrected).toMatchObject({
      householdId: householdAId,
      weekStartDate,
      date,
      plannedRecipeId,
      status: 'changed_plan',
      portionOutcome: 'right_amount',
      reason: 'easy_weeknight',
      actualRecipeId,
      actualMealLabel: 'Leftovers',
      updatedBy: userB,
    })

    const listed = await listMealOutcomes(db, fakeAccessToken(userA), householdAId, weekStartDate)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toEqual(corrected)

    const rows = await db.select().from(householdMealOutcomes)
    expect(rows).toHaveLength(1)
  })

  it('allows changed_plan without replacement details and clears old optional fields on replace', async () => {
    await upsertMealOutcome(db, fakeAccessToken(userA), userA, householdAId, date, {
      weekStartDate,
      plannedRecipeId,
      status: 'changed_plan',
      actualMealLabel: 'Takeaway',
      reason: 'too_much_effort',
    })

    const replaced = await upsertMealOutcome(db, fakeAccessToken(userA), userA, householdAId, date, {
      weekStartDate,
      plannedRecipeId,
      status: 'changed_plan',
    })

    expect(replaced).toMatchObject({
      status: 'changed_plan',
      portionOutcome: null,
      reason: null,
      actualRecipeId: null,
      actualMealLabel: null,
    })
  })

  it('does not expose another household outcome through RLS', async () => {
    await upsertMealOutcome(db, fakeAccessToken(userC), userC, householdBId, date, {
      weekStartDate,
      plannedRecipeId,
      status: 'skipped',
    })

    const rows = await asUser(userA, (tx) =>
      tx.select().from(householdMealOutcomes).where(eq(householdMealOutcomes.householdId, householdBId)),
    )

    expect(rows).toEqual([])
  })

  it('refuses direct writes for another household or another updater identity', async () => {
    await expect(
      asUser(userA, (tx) => tx.insert(householdMealOutcomes).values({
        householdId: householdBId,
        weekStartDate,
        date,
        plannedRecipeId,
        status: 'cooked',
        updatedBy: userA,
      })),
    ).rejects.toThrow(/row-level security/i)

    await expect(
      asUser(userA, (tx) => tx.insert(householdMealOutcomes).values({
        householdId: householdAId,
        weekStartDate,
        date,
        plannedRecipeId,
        status: 'cooked',
        updatedBy: userB,
      })),
    ).rejects.toThrow(/row-level security/i)
  })

  it('enforces week, replacement, and skipped-portion invariants in the database', async () => {
    await expect(db.insert(householdMealOutcomes).values({
      householdId: householdAId,
      weekStartDate,
      date: '2026-10-05',
      plannedRecipeId,
      status: 'cooked',
      updatedBy: userA,
    })).rejects.toThrow(/household_meal_outcomes_date_in_week_check/i)

    await expect(db.insert(householdMealOutcomes).values({
      householdId: householdAId,
      weekStartDate,
      date,
      plannedRecipeId,
      status: 'cooked',
      actualMealLabel: 'Takeaway',
      updatedBy: userA,
    })).rejects.toThrow(/household_meal_outcomes_actual_meal_check/i)

    await expect(db.insert(householdMealOutcomes).values({
      householdId: householdAId,
      weekStartDate,
      date,
      plannedRecipeId,
      status: 'skipped',
      portionOutcome: 'too_much',
      updatedBy: userA,
    })).rejects.toThrow(/household_meal_outcomes_skipped_portion_check/i)
  })

  it('returns 401 from both public routes without a bearer token', async () => {
    const app = buildApp(db)

    const listResponse = await app.request(`/households/${householdAId}/meal-outcomes?weekStartDate=${weekStartDate}`)
    const upsertResponse = await app.request(`/households/${householdAId}/meal-outcomes/${date}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weekStartDate, plannedRecipeId, status: 'cooked' }),
    })

    expect(listResponse.status).toBe(401)
    expect(upsertResponse.status).toBe(401)
  })
})
