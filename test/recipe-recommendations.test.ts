import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { createDb } from '../src/db.js'
import { setRecipeRecommendationGeneratorForTests } from '../src/recipe-recommendations.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const describeWithDb = testDatabaseUrl ? describe : describe.skip

const validBody = {
  householdProfile: { adults: 2, children: 1, priorities: ['quick'], avoidIngredients: [] },
  feedbackSummary: [{ mealId: 'tacos', mealTitle: 'Tacos', vote: 'up' as const }],
  candidateMeals: [
    { id: 'tacos', title: 'Tacos' },
    { id: 'pasta', title: 'Pasta' },
    { id: 'soup', title: 'Soup' },
  ],
}

const validAiResponse = JSON.stringify({
  recommendations: [
    { mealId: 'tacos', reason: 'Family loves quick Mexican dishes.' },
    { mealId: 'pasta', reason: 'Easy weeknight favourite.' },
  ],
})

describeWithDb('Recipe recommendation routes', () => {
  const db = createDb(testDatabaseUrl!)
  const previousInternalKey = process.env.VECKLY_INTERNAL_API_KEY

  beforeEach(async () => {
    process.env.VECKLY_INTERNAL_API_KEY = 'test-internal-key'
    setRecipeRecommendationGeneratorForTests(async () => validAiResponse)
    await db.execute(sql`delete from "rate_limit_hits"`)
  })

  afterEach(() => {
    setRecipeRecommendationGeneratorForTests(null)
    if (previousInternalKey === undefined) {
      delete process.env.VECKLY_INTERNAL_API_KEY
    } else {
      process.env.VECKLY_INTERNAL_API_KEY = previousInternalKey
    }
  })

  function request(body: unknown, userId = '11111111-1111-1111-1111-111111111111') {
    const app = buildApp(db)
    return app.request('/internal/recipes/recommend', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.VECKLY_INTERNAL_API_KEY}`,
        'Content-Type': 'application/json',
        'X-User-Id': userId,
      },
      body: JSON.stringify(body),
    })
  }

  it('returns filtered recommendations from the AI response', async () => {
    const response = await request(validBody, 'user-happy')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      recommendations: [
        { mealId: 'tacos', reason: 'Family loves quick Mexican dishes.' },
        { mealId: 'pasta', reason: 'Easy weeknight favourite.' },
      ],
    })
  })

  it('rejects invalid payloads', async () => {
    const response = await request({ ...validBody, candidateMeals: [] }, 'user-invalid')

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'INVALID_PAYLOAD' })
  })

  it('falls back deterministically instead of calling AI twice inside the rate-limit window', async () => {
    await request(validBody, 'user-rate-limit')
    const response = await request(validBody, 'user-rate-limit')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      recommendations: [
        { mealId: 'tacos', reason: 'A meal your family already enjoys.' },
        { mealId: 'pasta', reason: "Fits your preferences and this week's plan." },
        { mealId: 'soup', reason: "Fits your preferences and this week's plan." },
      ],
    })
  })

  it('does not rate-limit different users', async () => {
    await request(validBody, 'user-a')
    const response = await request(validBody, 'user-b')

    expect(response.status).toBe(200)
  })

  it('returns deterministic recommendations when generation fails', async () => {
    setRecipeRecommendationGeneratorForTests(async () => {
      throw new Error('AI timeout')
    })

    const response = await request(validBody, 'user-ai-error')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      recommendations: [
        { mealId: 'tacos', reason: 'A meal your family already enjoys.' },
        { mealId: 'pasta' },
        { mealId: 'soup' },
      ],
    })
  })

  it('returns deterministic recommendations when AI output is invalid', async () => {
    setRecipeRecommendationGeneratorForTests(async () => 'Not JSON')

    const response = await request(validBody, 'user-non-json')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      recommendations: [{ mealId: 'tacos' }, { mealId: 'pasta' }, { mealId: 'soup' }],
    })
  })

  it('filters AI-invented meal IDs', async () => {
    setRecipeRecommendationGeneratorForTests(async () => JSON.stringify({
      recommendations: [
        { mealId: 'tacos', reason: 'Good fit.' },
        { mealId: 'invented-meal-xyz', reason: 'This does not exist.' },
      ],
    }))

    const response = await request(validBody, 'user-filter')
    const body = await response.json() as { recommendations: { mealId: string }[] }

    expect(response.status).toBe(200)
    expect(body.recommendations).toEqual([{ mealId: 'tacos', reason: 'Good fit.' }])
  })

  it('filters AI recommendations that conflict with avoid ingredients when recipe metadata is supplied', async () => {
    setRecipeRecommendationGeneratorForTests(async () => JSON.stringify({
      recommendations: [
        { mealId: 'tacos', reason: 'Good fit.' },
        { mealId: 'pasta', reason: 'AI ignored the avoid preference.' },
      ],
    }))
    const body = {
      ...validBody,
      householdProfile: { ...validBody.householdProfile, avoidIngredients: ['peanut'] },
      candidateMeals: [
        { id: 'tacos', title: 'Tacos', tags: ['weekday'], ingredients: ['tortilla', 'beans'] },
        { id: 'pasta', title: 'Pasta', tags: [], ingredients: ['pasta', 'peanut butter'] },
      ],
    }

    const response = await request(body, 'user-avoid-filter')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      recommendations: [{ mealId: 'tacos', reason: 'Good fit.' }],
    })
  })

  it('does not reintroduce title substring false positives when recipe metadata is supplied', async () => {
    setRecipeRecommendationGeneratorForTests(async () => JSON.stringify({
      recommendations: [{ mealId: 'roasted', reason: 'Good fit.' }],
    }))
    const body = {
      ...validBody,
      householdProfile: { ...validBody.householdProfile, avoidIngredients: ['ost'] },
      candidateMeals: [
        { id: 'roasted', title: 'Rostad kyckling', tags: [], ingredients: ['kyckling', 'potatis'] },
      ],
    }

    const response = await request(body, 'user-avoid-title')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      recommendations: [{ mealId: 'roasted', reason: 'Good fit.' }],
    })
  })

  it('includes household, feedback, prep, swap, recency, and candidate metadata in the prompt', async () => {
    let userMessage = ''
    setRecipeRecommendationGeneratorForTests(async (_, message) => {
      userMessage = message
      return validAiResponse
    })

    await request({
      ...validBody,
      recentMealIds: { lastWeek: ['soup'], twoWeeksAgo: ['pasta'] },
      prepContext: { isCookDay: true, leftoversDesired: true },
      swapContext: { intent: 'quicker' as const, currentMealId: 'soup' },
      candidateMeals: [
        {
          id: 'tacos',
          title: 'Tacos',
          tags: ['quick', 'leftovers'],
          ingredients: [' Tortilla ', 'BLACK   BEANS'],
          prepTimeMinutes: 10,
          cookTimeMinutes: 15,
          cuisine: 'Mexican',
          proteinSource: 'legumes',
          mealWeight: 'medium',
        },
      ],
    }, 'user-prompt')

    expect(userMessage).toContain('2 adults')
    expect(userMessage).toContain('Tacos')
    expect(userMessage).toContain('batch cook day')
    expect(userMessage).toContain('Leftovers are wanted')
    expect(userMessage).toContain('Swap intent: quicker')
    expect(userMessage).toContain('Confirmed cooked last week: soup')
    expect(userMessage).toContain('time=25m')
    expect(userMessage).toContain('protein=legumes')
    expect(userMessage).toContain('ingredients=tortilla,black beans')
  })

  it('keeps avoid filtering in the deterministic fallback', async () => {
    setRecipeRecommendationGeneratorForTests(async () => { throw new Error('AI down') })
    const response = await request({
      ...validBody,
      householdProfile: { ...validBody.householdProfile, avoidIngredients: ['peanut'] },
      candidateMeals: [
        { id: 'tacos', title: 'Tacos', tags: ['quick'], ingredients: ['beans'] },
        { id: 'pasta', title: 'Pasta', tags: [], ingredients: ['peanut butter'] },
      ],
    }, 'user-fallback-avoid')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      recommendations: [{ mealId: 'tacos', reason: 'A meal your family already enjoys.' }],
    })
  })

  it('falls back deterministically when every AI recommendation is filtered out', async () => {
    setRecipeRecommendationGeneratorForTests(async () => JSON.stringify({
      recommendations: [{ mealId: 'invented', reason: 'Not allowed.' }],
    }))

    const response = await request(validBody, 'user-filtered-empty')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      recommendations: [{ mealId: 'tacos' }, { mealId: 'pasta' }, { mealId: 'soup' }],
    })
  })

  it('bounds candidate metadata included in the AI prompt', async () => {
    let userMessage = ''
    setRecipeRecommendationGeneratorForTests(async (_, message) => {
      userMessage = message
      return validAiResponse
    })
    const candidates = Array.from({ length: 61 }, (_, index) => ({
      id: `candidate-${index + 1}`,
      title: `Candidate ${index + 1}`,
      tags: Array.from({ length: 13 }, (_value, tagIndex) => `tag-${tagIndex + 1}`),
      ingredients: Array.from({ length: 17 }, (_value, ingredientIndex) => `Ingredient ${ingredientIndex + 1}`),
    }))

    await request({ ...validBody, candidateMeals: candidates }, 'user-bounded-prompt')

    expect(userMessage).toContain('candidate-60 | Candidate 60')
    expect(userMessage).not.toContain('candidate-61 | Candidate 61')
    expect(userMessage).toContain('tag-12')
    expect(userMessage).not.toContain('tag-13')
    expect(userMessage).toContain('ingredient 16')
    expect(userMessage).not.toContain('ingredient 17')
  })

  it('writes recommendation reasons in Swedish when the caller sends Accept-Language: sv', async () => {
    let capturedSystemPrompt = ''
    setRecipeRecommendationGeneratorForTests(async (systemPrompt) => {
      capturedSystemPrompt = systemPrompt
      return validAiResponse
    })

    const app = buildApp(db)
    await app.request('/internal/recipes/recommend', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.VECKLY_INTERNAL_API_KEY}`,
        'Content-Type': 'application/json',
        'X-User-Id': 'user-swedish',
        'Accept-Language': 'sv-SE,sv;q=0.9,en;q=0.8',
      },
      body: JSON.stringify(validBody),
    })

    expect(capturedSystemPrompt).toContain('written in Swedish')
    expect(capturedSystemPrompt).not.toContain('written in English')
  })

  it('defaults recommendation reasons to English when no Accept-Language is sent', async () => {
    let capturedSystemPrompt = ''
    setRecipeRecommendationGeneratorForTests(async (systemPrompt) => {
      capturedSystemPrompt = systemPrompt
      return validAiResponse
    })

    await request(validBody, 'user-default-language')

    expect(capturedSystemPrompt).toContain('written in English')
  })

  it('requires internal auth on the MealPlanner strangle route', async () => {
    const app = buildApp(db)
    const response = await app.request('/internal/recipes/recommend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })

    expect(response.status).toBe(401)
  })
})
