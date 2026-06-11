import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { createDb } from '../src/db.js'
import { setRecipeFillInGeneratorForTests } from '../src/recipe-fill-in.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const describeWithDb = testDatabaseUrl ? describe : describe.skip

const validAIResponse = JSON.stringify({
  title: 'Kycklinggryta',
  prepTimeMinutes: 30,
  ingredients: [{ name: 'kycklingfilé', amount: 400, unit: 'g', category: 'protein' }],
  steps: ['Stek kycklingen i smör på medelhög värme i 5 minuter.'],
})

describeWithDb('Recipe fill-in routes', () => {
  const db = createDb(testDatabaseUrl!)
  const previousInternalKey = process.env.VECKLY_INTERNAL_API_KEY

  beforeEach(() => {
    process.env.VECKLY_INTERNAL_API_KEY = 'test-internal-key'
    setRecipeFillInGeneratorForTests(async () => validAIResponse)
  })

  afterEach(() => {
    setRecipeFillInGeneratorForTests(null)
    if (previousInternalKey === undefined) {
      delete process.env.VECKLY_INTERNAL_API_KEY
    } else {
      process.env.VECKLY_INTERNAL_API_KEY = previousInternalKey
    }
  })

  function request(body: unknown, userId = '11111111-1111-1111-1111-111111111111') {
    const app = buildApp(db)
    return app.request('/internal/recipes/fill-in', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.VECKLY_INTERNAL_API_KEY}`,
        'Content-Type': 'application/json',
        'X-User-Id': userId,
      },
      body: JSON.stringify(body),
    })
  }

  it('returns a validated raw recipe envelope', async () => {
    const response = await request({ title: 'Kycklinggryta' }, 'user-happy')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      recipe: {
        title: 'Kycklinggryta',
        prepTimeMinutes: 30,
        ingredients: [{ name: 'kycklingfilé', amount: 400, unit: 'g', category: 'protein' }],
        steps: ['Stek kycklingen i smör på medelhög värme i 5 minuter.'],
      },
    })
  })

  it('includes household context in the generator message when provided', async () => {
    let userMessage = ''
    setRecipeFillInGeneratorForTests(async (_, message) => {
      userMessage = message
      return validAIResponse
    })

    await request({ title: 'Pasta', householdProfile: { adults: 2, children: 2 } }, 'user-profile')

    expect(userMessage).toContain('2 adults')
    expect(userMessage).toContain('2 children')
  })

  it('rejects invalid payloads', async () => {
    const response = await request({ title: '   ' }, 'user-invalid')

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'INVALID_PAYLOAD' })
  })

  it('rate-limits repeat calls by user', async () => {
    await request({ title: 'Tacos' }, 'user-rate-limit')
    const response = await request({ title: 'Pasta' }, 'user-rate-limit')

    expect(response.status).toBe(429)
    await expect(response.json()).resolves.toEqual({ error: 'RATE_LIMITED' })
  })

  it('does not rate-limit different users', async () => {
    await request({ title: 'Tacos' }, 'user-a')
    const response = await request({ title: 'Pasta' }, 'user-b')

    expect(response.status).toBe(200)
  })

  it('returns 500 when generation fails', async () => {
    setRecipeFillInGeneratorForTests(async () => {
      throw new Error('AI timeout')
    })

    const response = await request({ title: 'Pasta' }, 'user-ai-error')

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: 'AI_UNAVAILABLE' })
  })

  it('returns 422 when generation returns invalid output', async () => {
    setRecipeFillInGeneratorForTests(async () => 'Not JSON')

    const response = await request({ title: 'Pasta' }, 'user-non-json')

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toEqual({ error: 'INVALID_AI_RESPONSE' })
  })

  it('requires internal auth on the MealPlanner strangle route', async () => {
    const app = buildApp(db)
    const response = await app.request('/internal/recipes/fill-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Pasta' }),
    })

    expect(response.status).toBe(401)
  })
})
