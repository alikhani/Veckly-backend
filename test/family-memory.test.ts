import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { createDb } from '../src/db.js'
import { createRecipe } from '../src/recipes.js'
import { getFamilyRecap } from '../src/family-memory.js'
import { households, householdMemberships, recipes, weekPlanProjections } from '../src/schema.js'
import { fakeAccessToken } from './fake-access-token.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL

const describeWithDb = testDatabaseUrl ? describe : describe.skip

describeWithDb('Family memory (Plan D5 recap)', () => {
  const db = createDb(testDatabaseUrl!)

  const userA = '11111111-1111-1111-1111-111111111111'
  const userB = '22222222-2222-2222-2222-222222222222'
  let householdAId: string
  let householdBId: string

  const baseRecipe = {
    description: 'Fast family pasta',
    servings: 4,
    ingredients: [{ item: 'spaghetti', amount: '400', unit: 'g', category: 'Pantry' }],
    steps: [{ text: 'Cook pasta' }],
    tags: ['weekday'],
    source: 'user_created' as const,
    isPublic: false,
  }

  beforeEach(async () => {
    await db.execute(sql`delete from "recipes"`)
    await db.execute(sql`delete from "week_plan_projections"`)
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
    await db.execute(sql`delete from "recipes"`)
    await db.execute(sql`delete from "week_plan_projections"`)
    await db.execute(sql`delete from "household_memberships"`)
    await db.execute(sql`delete from "households"`)
  })

  async function seedWeek(weekStartDate: string, mealRecipeIds: string[]) {
    const meals = Object.fromEntries(mealRecipeIds.map((id, index) => [`day${index}`, { recipeRef: id }]))
    await db.insert(weekPlanProjections).values({
      householdId: householdAId,
      weekStartDate,
      state: { weekStarted: true, request: null, meals, lockedDays: [], skippedDays: [] },
    })
  }

  it('returns zero planned weeks and no top recipe when the household has no history', async () => {
    const recap = await getFamilyRecap(db, fakeAccessToken(userA), householdAId, '2026-06')

    expect(recap).toEqual({ plannedWeekCount: 0, topRecipeThisMonth: null })
  })

  it('counts only weeks that actually had a meal assigned', async () => {
    const recipe = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, { ...baseRecipe, title: 'Pasta' })
    await seedWeek('2026-06-01', [recipe.id])
    // A week row with no meals at all (e.g. only started) doesn't count as "planned".
    await db.insert(weekPlanProjections).values({
      householdId: householdAId,
      weekStartDate: '2026-06-08',
      state: { weekStarted: true, request: null, meals: {}, lockedDays: [], skippedDays: [] },
    })

    const recap = await getFamilyRecap(db, fakeAccessToken(userA), householdAId, '2026-07')

    expect(recap.plannedWeekCount).toBe(1)
  })

  it('picks the most-cooked recipe within the reference month, ignoring other months', async () => {
    const favorite = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, { ...baseRecipe, title: 'Korvstroganoff' })
    const other = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, { ...baseRecipe, title: 'Taco Tuesday' })
    await seedWeek('2026-06-01', [favorite.id, favorite.id, other.id])
    await seedWeek('2026-06-08', [favorite.id])
    // Outside the reference month — must not count toward June's top recipe.
    await seedWeek('2026-07-06', [other.id, other.id, other.id])

    const recap = await getFamilyRecap(db, fakeAccessToken(userA), householdAId, '2026-06')

    expect(recap.topRecipeThisMonth).toEqual({ title: 'Korvstroganoff', count: 3 })
  })

  it('does not expose another household\'s recap across RLS', async () => {
    const recipe = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, { ...baseRecipe, title: 'Pasta' })
    await seedWeek('2026-06-01', [recipe.id])

    const recap = await getFamilyRecap(db, fakeAccessToken(userB), householdBId, '2026-06')

    expect(recap).toEqual({ plannedWeekCount: 0, topRecipeThisMonth: null })
  })

  it('returns 401 from the route when no bearer token is supplied', async () => {
    const app = buildApp(db)

    const response = await app.request(`/households/${householdAId}/recap`)

    expect(response.status).toBe(401)
  })
})
