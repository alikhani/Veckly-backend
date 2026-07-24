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

  it('rate-limits repeat calls by user', async () => {
    await request(validBody, 'user-rate-limit')
    const response = await request(validBody, 'user-rate-limit')

    expect(response.status).toBe(429)
    await expect(response.json()).resolves.toEqual({ error: 'RATE_LIMITED' })
  })

  it('does not rate-limit different users', async () => {
    await request(validBody, 'user-a')
    const response = await request(validBody, 'user-b')

    expect(response.status).toBe(200)
  })

  it('returns 500 when generation fails', async () => {
    setRecipeRecommendationGeneratorForTests(async () => {
      throw new Error('AI timeout')
    })

    const response = await request(validBody, 'user-ai-error')

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: 'AI_UNAVAILABLE' })
  })

  it('returns 422 when AI output is invalid', async () => {
    setRecipeRecommendationGeneratorForTests(async () => 'Not JSON')

    const response = await request(validBody, 'user-non-json')

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toEqual({ error: 'INVALID_AI_RESPONSE' })
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

  it('includes household, feedback, and prep context in the prompt', async () => {
    let userMessage = ''
    setRecipeRecommendationGeneratorForTests(async (_, message) => {
      userMessage = message
      return validAiResponse
    })

    await request({ ...validBody, prepContext: { isCookDay: true } }, 'user-prompt')

    expect(userMessage).toContain('2 adults')
    expect(userMessage).toContain('Tacos')
    expect(userMessage).toContain('batch cook day')
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
