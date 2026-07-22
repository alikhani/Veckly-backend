import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { createDb } from '../src/db.js'
import { setRecipeRecommendationGeneratorForTests } from '../src/recipe-recommendations.js'
import { households, householdMemberships } from '../src/schema.js'

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
    await db.execute(sql`delete from "household_memberships"`)
    await db.execute(sql`delete from "households"`)

    const [household] = await db.insert(households).values({ name: 'Cache household' }).returning({ id: households.id })
    householdId = household!.id
    await db.insert(householdMemberships).values({ householdId, userId, role: 'owner', status: 'active' })
  })

  afterAll(async () => {
    await db.execute(sql`delete from "household_recipe_recommendations"`)
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
    // entry (`setRecipeRecommendationGeneratorForTests` also resets the
    // per-user rate limit, isolating this from the 30s throttle).
    let secondCallHappened = false
    setRecipeRecommendationGeneratorForTests(async () => {
      secondCallHappened = true
      return aiResponse('Second call.')
    })
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
    const response = await request({ ...validBody, householdId })

    expect(refetched).toBe(true)
    await expect(response.json()).resolves.toEqual({ recommendations: [{ mealId: 'tacos', reason: 'Refetched reason.' }] })
  })
})
