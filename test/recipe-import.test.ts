import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { createDb } from '../src/db.js'
import { setRecipeImportDependenciesForTests } from '../src/recipe-import.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const describeWithDb = testDatabaseUrl ? describe : describe.skip

const VALID_URL = 'https://www.ica.se/recept/kycklinggryta-12345'
const MOCK_RECIPE = {
  title: 'Kycklinggryta',
  prepTimeMinutes: 30,
  ingredients: [{ name: 'kycklingfilé', amount: 400, unit: 'g', category: 'protein' }],
  cuisine: null,
  proteinSource: null,
  mealWeight: null,
  tags: [],
  sourceUrl: VALID_URL,
}

const SCHEMA_ORG_HTML = `<html><head>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Recipe",
  "name": "Kycklinggryta",
  "prepTime": "PT30M",
  "recipeIngredient": ["400 g kycklingfilé"],
  "keywords": "middag, gryta"
}
</script>
</head></html>`

describeWithDb('Recipe URL import routes', () => {
  const db = createDb(testDatabaseUrl!)
  const previousInternalKey = process.env.VECKLY_INTERNAL_API_KEY

  beforeEach(() => {
    process.env.VECKLY_INTERNAL_API_KEY = 'test-internal-key'
    setRecipeImportDependenciesForTests({
      pageFetcher: async () => SCHEMA_ORG_HTML,
      aiExtractor: async () => MOCK_RECIPE,
    })
  })

  afterEach(() => {
    setRecipeImportDependenciesForTests(null)
    if (previousInternalKey === undefined) {
      delete process.env.VECKLY_INTERNAL_API_KEY
    } else {
      process.env.VECKLY_INTERNAL_API_KEY = previousInternalKey
    }
  })

  function request(body: unknown, userId = '11111111-1111-1111-1111-111111111111') {
    const app = buildApp(db)
    return app.request('/internal/recipes/import-from-url', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.VECKLY_INTERNAL_API_KEY}`,
        'Content-Type': 'application/json',
        'X-User-Id': userId,
      },
      body: JSON.stringify(body),
    })
  }

  it('imports recipe data from schema.org JSON-LD first', async () => {
    const response = await request({ url: VALID_URL }, 'user-schema')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      recipe: {
        title: 'Kycklinggryta',
        prepTimeMinutes: 30,
        ingredients: [{ name: 'kycklingfilé', amount: 400, unit: 'g', category: null }],
        tags: ['middag', 'gryta'],
        sourceUrl: VALID_URL,
      },
    })
  })

  it('falls back to AI when schema.org data is missing', async () => {
    setRecipeImportDependenciesForTests({
      pageFetcher: async () => '<html><body><h1>Kycklinggryta</h1></body></html>',
      aiExtractor: async () => MOCK_RECIPE,
    })

    const response = await request({ url: VALID_URL }, 'user-ai')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ recipe: MOCK_RECIPE })
  })

  it('rejects invalid and private URLs', async () => {
    const invalid = await request({ url: 'ftp://example.com/recipe' }, 'user-invalid-url')
    const privateIp = await request({ url: 'http://192.168.1.1/recipe' }, 'user-private-ip')

    expect(invalid.status).toBe(400)
    await expect(invalid.json()).resolves.toEqual({ error: 'INVALID_URL' })
    expect(privateIp.status).toBe(400)
    await expect(privateIp.json()).resolves.toEqual({ error: 'INVALID_URL' })
  })

  it('rate-limits repeat calls by user', async () => {
    await request({ url: VALID_URL }, 'user-rate-limit-import')
    const response = await request({ url: VALID_URL }, 'user-rate-limit-import')

    expect(response.status).toBe(429)
    await expect(response.json()).resolves.toEqual({ error: 'RATE_LIMITED' })
  })

  it('does not rate-limit different users', async () => {
    await request({ url: VALID_URL }, 'user-import-a')
    const response = await request({ url: VALID_URL }, 'user-import-b')

    expect(response.status).toBe(200)
  })

  it('returns fetch failure when page fetch fails', async () => {
    setRecipeImportDependenciesForTests({
      pageFetcher: async () => {
        throw new Error('timeout')
      },
      aiExtractor: async () => MOCK_RECIPE,
    })

    const response = await request({ url: VALID_URL }, 'user-fetch-fail')

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: 'FETCH_FAILED' })
  })

  it('returns no-recipe-found when schema.org and AI both fail', async () => {
    setRecipeImportDependenciesForTests({
      pageFetcher: async () => '<html/>',
      aiExtractor: async () => {
        throw new Error('AI_VALIDATION_FAILED')
      },
    })

    const response = await request({ url: VALID_URL }, 'user-parse-fail')

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toEqual({ error: 'NO_RECIPE_FOUND' })
  })

  it('requires internal auth on the MealPlanner strangle route', async () => {
    const app = buildApp(db)
    const response = await app.request('/internal/recipes/import-from-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: VALID_URL }),
    })

    expect(response.status).toBe(401)
  })
})
