import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { createDb } from '../src/db.js'
import { upsertMealFeedback } from '../src/meal-feedback.js'
import {
  listHouseholdMealSignals,
  removeHouseholdMealSignal,
  upsertHouseholdMealSignal,
} from '../src/household-meal-signals.js'
import { householdMealSignals, households, householdMemberships, mealFeedback } from '../src/schema.js'
import { fakeAccessToken } from './fake-access-token.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const describeWithDb = testDatabaseUrl ? describe : describe.skip

describeWithDb('Household meal signals + RLS', () => {
  const db = createDb(testDatabaseUrl!)

  const userA = '11111111-1111-1111-1111-111111111111'
  const userB = '22222222-2222-2222-2222-222222222222'
  const userC = '33333333-3333-3333-3333-333333333333'
  let householdAId: string
  let householdBId: string

  beforeEach(async () => {
    await db.execute(sql`delete from "household_meal_signals"`)
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
      { householdId: householdBId, userId: userC, role: 'owner', status: 'active' },
    ])
  })

  afterAll(async () => {
    await db.execute(sql`delete from "household_meal_signals"`)
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

  it('shares a household signal with another active member', async () => {
    await upsertHouseholdMealSignal(db, fakeAccessToken(userA), userA, householdAId, 'taco-rice-bowls', 'works_for_family')

    const listed = await listHouseholdMealSignals(db, fakeAccessToken(userB), householdAId)

    expect(listed.signals).toEqual({ 'taco-rice-bowls': 'works_for_family' })
    expect(listed.items).toMatchObject([
      {
        householdId: householdAId,
        mealId: 'taco-rice-bowls',
        signal: 'works_for_family',
      },
    ])
  })

  it('updates a shared signal and records the latest updater', async () => {
    await upsertHouseholdMealSignal(db, fakeAccessToken(userA), userA, householdAId, 'taco-rice-bowls', 'works_for_family')
    await upsertHouseholdMealSignal(db, fakeAccessToken(userB), userB, householdAId, 'taco-rice-bowls', 'not_for_us')

    await expect(listHouseholdMealSignals(db, fakeAccessToken(userA), householdAId)).resolves.toMatchObject({
      signals: { 'taco-rice-bowls': 'not_for_us' },
    })
    const [row] = await db
      .select({ updatedBy: householdMealSignals.updatedBy })
      .from(householdMealSignals)
      .where(and(eq(householdMealSignals.householdId, householdAId), eq(householdMealSignals.mealId, 'taco-rice-bowls')))
    expect(row?.updatedBy).toBe(userB)
  })

  it('removes a shared signal through the nullable API contract', async () => {
    await upsertHouseholdMealSignal(db, fakeAccessToken(userA), userA, householdAId, 'taco-rice-bowls', 'works_for_family')
    await removeHouseholdMealSignal(db, fakeAccessToken(userB), householdAId, 'taco-rice-bowls')

    await expect(listHouseholdMealSignals(db, fakeAccessToken(userA), householdAId)).resolves.toEqual({
      signals: {},
      items: [],
    })
  })

  it('does not expose another household signal through RLS', async () => {
    await upsertHouseholdMealSignal(db, fakeAccessToken(userC), userC, householdBId, 'private-meal', 'not_for_us')

    const rows = await asUser(userA, (tx) =>
      tx.select().from(householdMealSignals).where(eq(householdMealSignals.mealId, 'private-meal')),
    )

    expect(rows).toHaveLength(0)
  })

  it('does not expose another member private meal feedback while sharing household signals', async () => {
    await upsertHouseholdMealSignal(db, fakeAccessToken(userB), userB, householdAId, 'shared-meal', 'works_for_family')
    await upsertMealFeedback(db, fakeAccessToken(userB), userB, householdAId, 'shared-meal', { vote: 'up' })

    const householdSignals = await listHouseholdMealSignals(db, fakeAccessToken(userA), householdAId)
    const privateFeedbackRows = await asUser(userA, (tx) =>
      tx.select().from(mealFeedback).where(and(eq(mealFeedback.householdId, householdAId), eq(mealFeedback.mealId, 'shared-meal'))),
    )

    expect(householdSignals.signals).toEqual({ 'shared-meal': 'works_for_family' })
    expect(privateFeedbackRows).toEqual([])
  })

  it('refuses direct insert for a household where the user is not an active member', async () => {
    await expect(
      asUser(userA, (tx) =>
        tx.insert(householdMealSignals).values({
          householdId: householdBId,
          mealId: 'sneaky-meal',
          signal: 'works_for_family',
          updatedBy: userA,
        }),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('refuses direct insert attributed to a different user', async () => {
    await expect(
      asUser(userA, (tx) =>
        tx.insert(householdMealSignals).values({
          householdId: householdAId,
          mealId: 'impersonated-meal',
          signal: 'works_for_family',
          updatedBy: userB,
        }),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('returns 401 from the public route when no bearer token is supplied', async () => {
    const app = buildApp(db)

    const response = await app.request(`/households/${householdAId}/meal-signals`)

    expect(response.status).toBe(401)
  })
})
