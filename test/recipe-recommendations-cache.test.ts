import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { createDb } from '../src/db.js'
import { setRecipeRecommendationGeneratorForTests } from '../src/recipe-recommendations.js'
import {
  householdMealOutcomes,
  householdMealSignals,
  householdRecipeRecommendations,
  households,
  householdMemberships,
  mealFeedback,
} from '../src/schema.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const describeWithDb = testDatabaseUrl ? describe : describe.skip

const validBody = {
  householdProfile: { adults: 2, children: 1, priorities: ['quick'], avoidIngredients: [] },
  feedbackSummary: [],
  candidateMeals: [
    { id: 'tacos', title: 'Tacos' },
    { id: 'pasta', title: 'Pasta' },
  ],
}

const aiResponse = (reason: string) => JSON.stringify({
  recommendations: [{ mealId: 'tacos', reason }],
})

describeWithDb('Recipe recommendation server-side cache', () => {
  const db = createDb(testDatabaseUrl!)
  const previousInternalKey = process.env.VECKLY_INTERNAL_API_KEY
  const userId = '11111111-1111-1111-1111-111111111111'
  const outsiderId = '22222222-2222-2222-2222-222222222222'
  let householdId: string

  beforeEach(async () => {
    process.env.VECKLY_INTERNAL_API_KEY = 'test-internal-key'
    await db.execute(sql`delete from "household_recipe_recommendations"`)
    await db.execute(sql`delete from "household_meal_outcomes"`)
    await db.execute(sql`delete from "household_meal_signals"`)
    await db.execute(sql`delete from "meal_feedback"`)
    await db.execute(sql`delete from "rate_limit_hits"`)
    await db.execute(sql`delete from "household_memberships"`)
    await db.execute(sql`delete from "households"`)

    const [household] = await db.insert(households).values({ name: 'Cache household' }).returning({ id: households.id })
    householdId = household!.id
    await db.insert(householdMemberships).values({ householdId, userId, role: 'owner', status: 'active' })
  })

  afterAll(async () => {
    await db.execute(sql`delete from "household_recipe_recommendations"`)
    await db.execute(sql`delete from "household_meal_outcomes"`)
    await db.execute(sql`delete from "household_meal_signals"`)
    await db.execute(sql`delete from "meal_feedback"`)
    await db.execute(sql`delete from "rate_limit_hits"`)
    await db.execute(sql`delete from "household_memberships"`)
    await db.execute(sql`delete from "households"`)
    if (previousInternalKey === undefined) {
      delete process.env.VECKLY_INTERNAL_API_KEY
    } else {
      process.env.VECKLY_INTERNAL_API_KEY = previousInternalKey
    }
  })

  function request(body: unknown, callerId = userId) {
    const app = buildApp(db)
    return app.request('/internal/recipes/recommend', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.VECKLY_INTERNAL_API_KEY}`,
        'Content-Type': 'application/json',
        'X-User-Id': callerId,
      },
      body: JSON.stringify(body),
    })
  }

  it('serves the second request from cache without calling the AI generator again', async () => {
    let generatorCallCount = 0
    setRecipeRecommendationGeneratorForTests(async () => {
      generatorCallCount += 1
      return aiResponse('First reason.')
    })

    const first = await request({ ...validBody, householdId })
    await expect(first.json()).resolves.toEqual({ recommendations: [{ mealId: 'tacos', reason: 'First reason.' }] })

    // A fresh generator that would return something different if it were
    // ever actually called — proves the second response came from cache.
    setRecipeRecommendationGeneratorForTests(async () => {
      generatorCallCount += 1
      return aiResponse('Second reason — should never be seen.')
    })

    const second = await request({ ...validBody, householdId })
    await expect(second.json()).resolves.toEqual({ recommendations: [{ mealId: 'tacos', reason: 'First reason.' }] })

    expect(generatorCallCount).toBe(1)
  })

  it('does not cache across households', async () => {
    const [otherHousehold] = await db.insert(households).values({ name: 'Other household' }).returning({ id: households.id })
    await db.insert(householdMemberships).values({ householdId: otherHousehold!.id, userId: outsiderId, role: 'owner', status: 'active' })

    setRecipeRecommendationGeneratorForTests(async () => aiResponse('Household A reason.'))
    await request({ ...validBody, householdId })

    let secondHouseholdSawTheCall = false
    setRecipeRecommendationGeneratorForTests(async () => {
      secondHouseholdSawTheCall = true
      return aiResponse('Household B reason.')
    })
    const response = await request({ ...validBody, householdId: otherHousehold!.id }, outsiderId)

    expect(secondHouseholdSawTheCall).toBe(true)
    await expect(response.json()).resolves.toEqual({ recommendations: [{ mealId: 'tacos', reason: 'Household B reason.' }] })
  })

  it('does not cache across languages for the same household', async () => {
    setRecipeRecommendationGeneratorForTests(async () => aiResponse('English reason.'))
    const app = buildApp(db)
    const englishResponse = await app.request('/internal/recipes/recommend', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.VECKLY_INTERNAL_API_KEY}`,
        'Content-Type': 'application/json',
        'X-User-Id': userId,
        'Accept-Language': 'en-US',
      },
      body: JSON.stringify({ ...validBody, householdId }),
    })
    await expect(englishResponse.json()).resolves.toEqual({ recommendations: [{ mealId: 'tacos', reason: 'English reason.' }] })

    let swedishCallHappened = false
    setRecipeRecommendationGeneratorForTests(async () => {
      swedishCallHappened = true
      return aiResponse('Svensk anledning.')
    })
    // The English call above already consumed this user's rate-limit slot —
    // clear it so this second, uncached (different language) call isn't
    // blocked by the 30s throttle. Not what this test is checking.
    await db.execute(sql`delete from "rate_limit_hits"`)
    const swedishResponse = await app.request('/internal/recipes/recommend', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.VECKLY_INTERNAL_API_KEY}`,
        'Content-Type': 'application/json',
        'X-User-Id': userId,
        'Accept-Language': 'sv-SE',
      },
      body: JSON.stringify({ ...validBody, householdId }),
    })

    expect(swedishCallHappened).toBe(true)
    await expect(swedishResponse.json()).resolves.toEqual({ recommendations: [{ mealId: 'tacos', reason: 'Svensk anledning.' }] })
  })

  it('ignores a householdId the caller is not an active member of, without failing the request', async () => {
    const [otherHousehold] = await db.insert(households).values({ name: 'Not mine' }).returning({ id: households.id })

    setRecipeRecommendationGeneratorForTests(async () => aiResponse('First call.'))
    const first = await request({ ...validBody, householdId: otherHousehold!.id })
    expect(first.status).toBe(200)
    await expect(first.json()).resolves.toEqual({ recommendations: [{ mealId: 'tacos', reason: 'First call.' }] })

    // Not a member of `otherHousehold`, so caching never engages — a second
    // call still reaches the generator instead of finding a stale cache
    // entry. Clear the rate-limit table so this uncached second call isn't
    // blocked by the 30s throttle from the first — not what this test checks.
    let secondCallHappened = false
    setRecipeRecommendationGeneratorForTests(async () => {
      secondCallHappened = true
      return aiResponse('Second call.')
    })
    await db.execute(sql`delete from "rate_limit_hits"`)
    const second = await request({ ...validBody, householdId: otherHousehold!.id })
    expect(second.status).toBe(200)
    expect(secondCallHappened).toBe(true)
    await expect(second.json()).resolves.toEqual({ recommendations: [{ mealId: 'tacos', reason: 'Second call.' }] })
  })

  it('refetches once the cached entry is older than the freshness window', async () => {
    setRecipeRecommendationGeneratorForTests(async () => aiResponse('Fresh reason.'))
    await request({ ...validBody, householdId })

    await db.execute(sql`
      update "household_recipe_recommendations"
      set "computed_at" = now() - interval '8 days'
      where "household_id" = ${householdId}
    `)

    let refetched = false
    setRecipeRecommendationGeneratorForTests(async () => {
      refetched = true
      return aiResponse('Refetched reason.')
    })
    // The first call above already consumed this user's rate-limit slot —
    // clear it so this refetch (cache is stale, so uncached) isn't blocked
    // by the 30s throttle. Not what this test is checking.
    await db.execute(sql`delete from "rate_limit_hits"`)
    const response = await request({ ...validBody, householdId })

    expect(refetched).toBe(true)
    await expect(response.json()).resolves.toEqual({ recommendations: [{ mealId: 'tacos', reason: 'Refetched reason.' }] })
  })

  it('misses cache when prep, swap, or candidate metadata changes', async () => {
    let calls = 0
    setRecipeRecommendationGeneratorForTests(async () => aiResponse(`Call ${++calls}.`))
    const firstBody = {
      ...validBody,
      householdId,
      prepContext: { isCookDay: false },
      swapContext: { intent: 'any' as const },
      candidateMeals: [
        { id: 'tacos', title: 'Tacos', tags: ['quick'], ingredients: ['beans'], prepTimeMinutes: 20 },
        { id: 'pasta', title: 'Pasta', tags: [], ingredients: ['pasta'], prepTimeMinutes: 30 },
      ],
    }
    await request(firstBody)

    await db.execute(sql`delete from "rate_limit_hits"`)
    await request({
      ...firstBody,
      prepContext: { isCookDay: true },
      swapContext: { intent: 'quicker' as const, currentMealId: 'pasta' },
      candidateMeals: firstBody.candidateMeals.map((candidate) => (
        candidate.id === 'tacos' ? { ...candidate, prepTimeMinutes: 15 } : candidate
      )),
    })

    expect(calls).toBe(2)
  })

  it('treats legacy bare-array cache rows as a miss', async () => {
    await db.insert(householdRecipeRecommendations).values({
      householdId,
      language: 'en',
      recommendations: [{ mealId: 'tacos', reason: 'Legacy stale reason.' }],
    })
    let called = false
    setRecipeRecommendationGeneratorForTests(async () => {
      called = true
      return aiResponse('Fresh versioned reason.')
    })

    const response = await request({ ...validBody, householdId })

    expect(called).toBe(true)
    await expect(response.json()).resolves.toEqual({ recommendations: [{ mealId: 'tacos', reason: 'Fresh versioned reason.' }] })
  })

  it('uses fresh server feedback and confirmed outcomes in prompt and deterministic fallback', async () => {
    const tacosId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const pastaId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    await db.insert(mealFeedback).values({ householdId, userId, mealId: tacosId, vote: 'down' })
    await db.insert(householdMealSignals).values({
      householdId,
      mealId: pastaId,
      signal: 'works_for_family',
      updatedBy: userId,
    })
    await db.insert(householdMealOutcomes).values({
      householdId,
      weekStartDate: '2026-09-21',
      date: '2026-09-22',
      plannedRecipeId: pastaId,
      status: 'cooked',
      reason: 'family_approved',
      updatedBy: userId,
    })
    let prompt = ''
    setRecipeRecommendationGeneratorForTests(async (_, message) => {
      prompt = message
      throw new Error('Provider unavailable')
    })

    const response = await request({
      ...validBody,
      householdId,
      referenceWeekStartDate: '2026-09-28',
      feedbackSummary: [],
      candidateMeals: [
        { id: tacosId, title: 'Tacos' },
        { id: pastaId, title: 'Pasta' },
      ],
    })

    expect(prompt).toContain('Personally disliked: "Tacos"')
    expect(prompt).toContain(`${pastaId}:works_for_family`)
    expect(prompt).toContain(`${pastaId}:family_approved`)
    expect(prompt).toContain(`Confirmed cooked last week: ${pastaId}`)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      recommendations: [{ mealId: pastaId, reason: 'A meal your family already enjoys.' }],
    })
  })
})
