import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { createDb } from '../src/db.js'
import { getHouseholdProfile, upsertHouseholdProfile } from '../src/household-profile.js'
import { householdMemberships, householdProfiles, householdRecipeRecommendations, households } from '../src/schema.js'
import { fakeAccessToken } from './fake-access-token.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL

const describeWithDb = testDatabaseUrl ? describe : describe.skip

describeWithDb('Household profile', () => {
  const db = createDb(testDatabaseUrl!)

  const userA = '11111111-1111-1111-1111-111111111111'
  const userB = '22222222-2222-2222-2222-222222222222'
  const userC = '33333333-3333-3333-3333-333333333333'

  let householdAId: string
  let householdBId: string

  const profile = {
    adults: 2,
    children: 1,
    priorities: ['quick', 'child-friendly'] as const,
    avoidIngredients: ['peanuts'],
    selectedDays: [
      { day: 'monday' as const, effortLevel: 'busy' as const, lateEvening: true },
      { day: 'tuesday' as const, occasion: 'standard' as const },
    ],
  }

  beforeEach(async () => {
    await db.execute(sql`delete from "household_recipe_recommendations"`)
    await db.execute(sql`delete from "household_profiles"`)
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
    await db.execute(sql`delete from "household_profiles"`)
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

  it('creates and reads a household planning profile for an active member', async () => {
    const saved = await upsertHouseholdProfile(db, fakeAccessToken(userA), userA, householdAId, profile)

    expect(saved.householdId).toBe(householdAId)
    expect(saved.adults).toBe(2)
    expect(saved.children).toBe(1)
    expect(saved.priorities).toEqual(['quick', 'child-friendly'])
    expect(saved.avoidIngredients).toEqual(['peanuts'])
    expect(saved.selectedDays).toEqual(profile.selectedDays)
    expect(saved.updatedBy).toBe(userA)

    const read = await getHouseholdProfile(db, fakeAccessToken(userA), householdAId)
    expect(read).toMatchObject({
      householdId: householdAId,
      adults: 2,
      children: 1,
      priorities: ['quick', 'child-friendly'],
      avoidIngredients: ['peanuts'],
      selectedDays: profile.selectedDays,
      updatedBy: userA,
    })
  })

  it('updates the existing profile instead of inserting a duplicate', async () => {
    await upsertHouseholdProfile(db, fakeAccessToken(userA), userA, householdAId, profile)

    const updated = await upsertHouseholdProfile(db, fakeAccessToken(userA), userA, householdAId, {
      ...profile,
      adults: 3,
      children: 0,
      priorities: ['budget'],
      avoidIngredients: [],
    })

    expect(updated.adults).toBe(3)
    expect(updated.children).toBe(0)
    expect(updated.priorities).toEqual(['budget'])
    expect(updated.avoidIngredients).toEqual([])

    const rows = await db.select().from(householdProfiles).where(eq(householdProfiles.householdId, householdAId))
    expect(rows).toHaveLength(1)
  })

  it('normalizes avoid terms and invalidates cached recommendations when the profile changes', async () => {
    await db.insert(householdRecipeRecommendations).values({
      householdId: householdAId,
      language: 'sv',
      recommendations: [{ mealId: 'cached', reason: 'Stale reason' }],
    })

    const saved = await upsertHouseholdProfile(db, fakeAccessToken(userA), userA, householdAId, {
      ...profile,
      avoidIngredients: [' fisk ', '', '   '],
    })

    expect(saved.avoidIngredients).toEqual(['fisk'])
    const cached = await db
      .select()
      .from(householdRecipeRecommendations)
      .where(eq(householdRecipeRecommendations.householdId, householdAId))
    expect(cached).toHaveLength(0)
  })

  it('does not expose another household profile across RLS', async () => {
    await upsertHouseholdProfile(db, fakeAccessToken(userB), userB, householdBId, profile)

    const directRows = await asUser(userA, (tx) =>
      tx
        .select()
        .from(householdProfiles)
        .where(and(eq(householdProfiles.householdId, householdBId), eq(householdProfiles.adults, 2))),
    )
    expect(directRows).toHaveLength(0)

    const read = await getHouseholdProfile(db, fakeAccessToken(userA), householdBId)
    expect(read).toBeNull()
  })

  it('refuses profile writes from non-members and removed members', async () => {
    await expect(upsertHouseholdProfile(db, fakeAccessToken(userA), userA, householdBId, profile)).rejects.toThrow(/row-level security/i)
    await expect(upsertHouseholdProfile(db, fakeAccessToken(userC), userC, householdAId, profile)).rejects.toThrow(/row-level security/i)
  })

  it('returns 401 from profile routes when no bearer token is supplied', async () => {
    const app = buildApp(db)

    const getResponse = await app.request(`/households/${householdAId}/profile`)
    expect(getResponse.status).toBe(401)

    const putResponse = await app.request(`/households/${householdAId}/profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profile),
    })
    expect(putResponse.status).toBe(401)
  })
})
