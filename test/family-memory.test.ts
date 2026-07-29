import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { createDb } from '../src/db.js'
import { createRecipe } from '../src/recipes.js'
import { upsertMealFeedback } from '../src/meal-feedback.js'
import { getFamilyCookbook, getFamilyRecap } from '../src/family-memory.js'
import { households, householdMemberships, mealFeedback, recipes, weekPlanProjections } from '../src/schema.js'
import { fakeAccessToken } from './fake-access-token.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL

const describeWithDb = testDatabaseUrl ? describe : describe.skip

describeWithDb('Family memory (Plan D3/D5)', () => {
  const db = createDb(testDatabaseUrl!)

  const userA = '11111111-1111-1111-1111-111111111111'
  const userB = '22222222-2222-2222-2222-222222222222'
  const userC = '33333333-3333-3333-3333-333333333333'
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
    await db.execute(sql`delete from "meal_feedback"`)
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
      { householdId: householdAId, userId: userC, role: 'member', status: 'active' },
      { householdId: householdBId, userId: userB, role: 'owner', status: 'active' },
    ])
  })

  afterAll(async () => {
    await db.execute(sql`delete from "meal_feedback"`)
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

  it('excludes weeks older than the 3-year lookback window from the planned-week count', async () => {
    const recipe = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, { ...baseRecipe, title: 'Pasta' })
    await seedWeek('2026-06-01', [recipe.id])
    await seedWeek('2020-01-06', [recipe.id]) // well over 3 years before the reference month

    const recap = await getFamilyRecap(db, fakeAccessToken(userA), householdAId, '2026-07')

    expect(recap.plannedWeekCount).toBe(1)
  })

  it('returns 401 from the route when no bearer token is supplied', async () => {
    const app = buildApp(db)

    const response = await app.request(`/households/${householdAId}/recap`)

    expect(response.status).toBe(401)
  })

  describe('getFamilyCookbook (Plan D3)', () => {
    it('returns an empty cookbook when the caller has liked nothing', async () => {
      const cookbook = await getFamilyCookbook(db, fakeAccessToken(userA), userA, householdAId, '2026-07-06')

      expect(cookbook).toEqual({ totalFamilyLikedCount: 0, favorites: [], dueAgain: [] })
    })

    it('counts a recipe the caller liked and has cooked', async () => {
      const recipe = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, { ...baseRecipe, title: 'Korvstroganoff' })
      await upsertMealFeedback(db, fakeAccessToken(userA), userA, householdAId, recipe.id, { vote: 'up' })
      await seedWeek('2026-07-06', [recipe.id])

      const cookbook = await getFamilyCookbook(db, fakeAccessToken(userA), userA, householdAId, '2026-07-06')

      expect(cookbook.totalFamilyLikedCount).toBe(1)
      expect(cookbook.favorites).toEqual([{ recipeId: recipe.id, title: 'Korvstroganoff', timesCooked: 1, weeksSinceCooked: 0 }])
    })

    it('clamps weeksSinceCooked to 0 instead of going negative for a stale client-supplied current week', async () => {
      const recipe = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, { ...baseRecipe, title: 'Korvstroganoff' })
      await upsertMealFeedback(db, fakeAccessToken(userA), userA, householdAId, recipe.id, { vote: 'up' })
      // Cooked in a week *after* the "current" week the caller passes in —
      // an out-of-date client clock shouldn't be able to produce a negative
      // weeks-since-cooked value.
      await seedWeek('2026-07-13', [recipe.id])

      const cookbook = await getFamilyCookbook(db, fakeAccessToken(userA), userA, householdAId, '2026-07-06')

      expect(cookbook.favorites).toEqual([{ recipeId: recipe.id, title: 'Korvstroganoff', timesCooked: 1, weeksSinceCooked: 0 }])
    })

    // Votes are per-user (RLS enforces `user_id = auth.uid()` even on
    // SELECT, migration 0020) — a household member's own cookbook never
    // includes recipes only their partner liked.
    it('does not count another household member\'s up-vote as the caller\'s own', async () => {
      const recipe = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, { ...baseRecipe, title: 'Korvstroganoff' })
      await upsertMealFeedback(db, fakeAccessToken(userC), userC, householdAId, recipe.id, { vote: 'up' })
      await seedWeek('2026-07-06', [recipe.id])

      const cookbook = await getFamilyCookbook(db, fakeAccessToken(userA), userA, householdAId, '2026-07-06')

      expect(cookbook).toEqual({ totalFamilyLikedCount: 0, favorites: [], dueAgain: [] })
    })

    it('excludes a down-voted recipe', async () => {
      const recipe = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, { ...baseRecipe, title: 'Fish Stew' })
      await upsertMealFeedback(db, fakeAccessToken(userA), userA, householdAId, recipe.id, { vote: 'down' })
      await seedWeek('2026-07-06', [recipe.id])

      const cookbook = await getFamilyCookbook(db, fakeAccessToken(userA), userA, householdAId, '2026-07-06')

      expect(cookbook).toEqual({ totalFamilyLikedCount: 0, favorites: [], dueAgain: [] })
    })

    it('returns a liked recipe that has never been cooked as a favorite with nullable recency', async () => {
      const recipe = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, { ...baseRecipe, title: 'Wishlist Curry' })
      await upsertMealFeedback(db, fakeAccessToken(userA), userA, householdAId, recipe.id, { vote: 'up' })

      const cookbook = await getFamilyCookbook(db, fakeAccessToken(userA), userA, householdAId, '2026-07-06')

      expect(cookbook.totalFamilyLikedCount).toBe(1)
      expect(cookbook.favorites).toEqual([
        { recipeId: recipe.id, title: 'Wishlist Curry', timesCooked: 0, weeksSinceCooked: null },
      ])
      expect(cookbook.dueAgain).toEqual([])
    })

    it('counts only liked recipes that are present in the returned lists', async () => {
      const recipe = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, { ...baseRecipe, title: 'Visible Pasta' })
      await upsertMealFeedback(db, fakeAccessToken(userA), userA, householdAId, recipe.id, { vote: 'up' })
      // meal_feedback intentionally has no recipe FK because built-in recipe
      // identifiers can also be voted on. A stale/missing id must therefore
      // not inflate the cookbook headline beyond its renderable rows.
      await db.insert(mealFeedback).values({
        householdId: householdAId,
        userId: userA,
        mealId: '99999999-9999-4999-8999-999999999999',
        vote: 'up',
      })

      const cookbook = await getFamilyCookbook(db, fakeAccessToken(userA), userA, householdAId, '2026-07-06')

      expect(cookbook.totalFamilyLikedCount).toBe(1)
      expect(cookbook.favorites.map((entry) => entry.recipeId)).toEqual([recipe.id])
      expect(cookbook.favorites.length + cookbook.dueAgain.length).toBe(cookbook.totalFamilyLikedCount)
    })

    it('moves a favorite into dueAgain once 6+ weeks have passed since it was last cooked', async () => {
      const recipe = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, { ...baseRecipe, title: 'Meatballs' })
      await upsertMealFeedback(db, fakeAccessToken(userA), userA, householdAId, recipe.id, { vote: 'up' })
      await seedWeek('2026-05-25', [recipe.id])

      const cookbook = await getFamilyCookbook(db, fakeAccessToken(userA), userA, householdAId, '2026-07-06')

      expect(cookbook.favorites).toEqual([])
      expect(cookbook.dueAgain).toEqual([{ recipeId: recipe.id, title: 'Meatballs', timesCooked: 1, weeksSinceCooked: 6 }])
    })

    it('sorts favorites by times cooked, most first', async () => {
      const often = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, { ...baseRecipe, title: 'Weeknight Pasta' })
      const rarely = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, { ...baseRecipe, title: 'Sunday Roast' })
      await upsertMealFeedback(db, fakeAccessToken(userA), userA, householdAId, often.id, { vote: 'up' })
      await upsertMealFeedback(db, fakeAccessToken(userA), userA, householdAId, rarely.id, { vote: 'up' })
      await seedWeek('2026-06-22', [often.id])
      await seedWeek('2026-06-29', [often.id, rarely.id])
      await seedWeek('2026-07-06', [often.id])

      const cookbook = await getFamilyCookbook(db, fakeAccessToken(userA), userA, householdAId, '2026-07-06')

      expect(cookbook.favorites.map((f) => f.recipeId)).toEqual([often.id, rarely.id])
    })

    it('sorts favorite and due-again ties consistently by Swedish title', async () => {
      const zebra = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, { ...baseRecipe, title: 'Zucchini' })
      const apple = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, { ...baseRecipe, title: 'Äppelpaj' })
      const meatballs = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, { ...baseRecipe, title: 'Köttbullar' })
      const stew = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, { ...baseRecipe, title: 'Örtgryta' })
      for (const recipe of [zebra, apple, meatballs, stew]) {
        await upsertMealFeedback(db, fakeAccessToken(userA), userA, householdAId, recipe.id, { vote: 'up' })
      }
      await seedWeek('2026-05-25', [meatballs.id, stew.id])

      const cookbook = await getFamilyCookbook(db, fakeAccessToken(userA), userA, householdAId, '2026-07-06')

      expect(cookbook.favorites.map((recipe) => recipe.title)).toEqual(['Zucchini', 'Äppelpaj'])
      expect(cookbook.dueAgain.map((recipe) => recipe.title)).toEqual(['Köttbullar', 'Örtgryta'])
    })

    it('does not expose another household\'s cookbook across RLS', async () => {
      const recipe = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, { ...baseRecipe, title: 'Pasta' })
      await upsertMealFeedback(db, fakeAccessToken(userA), userA, householdAId, recipe.id, { vote: 'up' })
      await seedWeek('2026-07-06', [recipe.id])

      const cookbook = await getFamilyCookbook(db, fakeAccessToken(userB), userB, householdBId, '2026-07-06')

      expect(cookbook).toEqual({ totalFamilyLikedCount: 0, favorites: [], dueAgain: [] })
    })

    it('treats a liked recipe as never-cooked once its only history is older than the 3-year lookback window', async () => {
      const recipe = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, { ...baseRecipe, title: 'Pasta' })
      await upsertMealFeedback(db, fakeAccessToken(userA), userA, householdAId, recipe.id, { vote: 'up' })
      await seedWeek('2020-01-06', [recipe.id]) // well over 3 years before the reference week

      const cookbook = await getFamilyCookbook(db, fakeAccessToken(userA), userA, householdAId, '2026-07-06')

      expect(cookbook.totalFamilyLikedCount).toBe(1)
      expect(cookbook.favorites).toEqual([
        { recipeId: recipe.id, title: 'Pasta', timesCooked: 0, weeksSinceCooked: null },
      ])
      expect(cookbook.dueAgain).toEqual([])
    })

    it('returns 401 from the route when no bearer token is supplied', async () => {
      const app = buildApp(db)

      const response = await app.request(`/households/${householdAId}/family-cookbook?weekStartDate=2026-07-06`)

      expect(response.status).toBe(401)
    })
  })
})
