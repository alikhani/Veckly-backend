import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { createDb } from '../src/db.js'
import {
  FetchError,
  RobotsBlockedError,
  classifyUrlPlatform,
  fetchRecipePage,
  parseRobotsText,
  resolveUrlSafely,
  setRecipeImportDependenciesForTests,
} from '../src/recipe-import.js'

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
const MOCK_TEXT_RECIPE = {
  ...MOCK_RECIPE,
  title: 'Pasta med tomatsås',
  sourceUrl: null,
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

  function textRequest(body: unknown, userId = '22222222-2222-2222-2222-222222222222') {
    const app = buildApp(db)
    return app.request('/internal/recipes/import-from-text', {
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
    await expect(response.json()).resolves.toMatchObject({
      recipe: MOCK_RECIPE,
      confidence: 'high',
      warnings: [],
      source: { kind: 'web', url: VALID_URL },
    })
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

  it('imports recipe data from pasted text', async () => {
    setRecipeImportDependenciesForTests({
      textAiExtractor: async (text, sourceUrl) => ({ ...MOCK_TEXT_RECIPE, title: text.includes('pasta') ? MOCK_TEXT_RECIPE.title : 'Draft', sourceUrl }),
    })

    const response = await textRequest({
      text: 'Snabb pasta med tomatsås, vitlök, olivolja och parmesan. Koka pasta och rör ihop såsen.',
    }, 'user-text-import')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      recipe: {
        title: 'Pasta med tomatsås',
        sourceUrl: null,
      },
    })
  })

  it('passes optional source URL through text imports', async () => {
    setRecipeImportDependenciesForTests({
      textAiExtractor: async (_text, sourceUrl) => ({ ...MOCK_TEXT_RECIPE, sourceUrl }),
    })

    const response = await textRequest({
      text: 'Taco bowl med ris, bönor, majs, sallad, yoghurt och lime. Blanda i skålar och servera.',
      sourceUrl: 'https://www.instagram.com/p/example',
    }, 'user-text-source-url')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      recipe: { sourceUrl: 'https://www.instagram.com/p/example' },
    })
  })

  it('rejects short text and invalid source URLs', async () => {
    const shortText = await textRequest({ text: 'pasta' }, 'user-short-text')
    const invalidSource = await textRequest({
      text: 'Pasta med tomatsås, vitlök, olivolja och parmesan. Koka pasta och rör ihop såsen.',
      sourceUrl: 'ftp://example.com/reel',
    }, 'user-invalid-text-source')

    expect(shortText.status).toBe(422)
    await expect(shortText.json()).resolves.toEqual({ error: 'NO_RECIPE_FOUND' })
    expect(invalidSource.status).toBe(400)
    await expect(invalidSource.json()).resolves.toEqual({ error: 'INVALID_URL' })
  })

  it('returns low confidence and a warning for short pasted text', async () => {
    setRecipeImportDependenciesForTests({
      textAiExtractor: async () => ({ ...MOCK_TEXT_RECIPE, ingredients: [] }),
    })

    const response = await textRequest({
      text: 'Pasta bolognese. Cook and serve.',
    }, 'user-text-low-confidence')

    expect(response.status).toBe(200)
    const body = await response.json() as { confidence: string; warnings: string[] }
    expect(body.confidence).toBe('low')
    expect(body.warnings.length).toBeGreaterThan(0)
  })

  it('returns high confidence for long text with complete ingredients', async () => {
    setRecipeImportDependenciesForTests({
      textAiExtractor: async () => MOCK_TEXT_RECIPE,
    })

    const longText = 'Pasta bolognese: 400g spaghetti, 300g ground beef, 1 can tomatoes, 2 garlic cloves, 1 onion, olive oil, salt, pepper. Fry onion and garlic, add beef and brown, add tomatoes and simmer 20 min. Cook pasta al dente and serve with sauce.'

    const response = await textRequest({ text: longText }, 'user-text-high-confidence')

    expect(response.status).toBe(200)
    const body = await response.json() as { confidence: string; warnings: string[] }
    expect(body.confidence).toBe('high')
    expect(body.warnings).toEqual([])
  })

  it('rate-limits text imports separately from URL imports', async () => {
    setRecipeImportDependenciesForTests({
      pageFetcher: async () => SCHEMA_ORG_HTML,
      textAiExtractor: async () => MOCK_TEXT_RECIPE,
    })

    await request({ url: VALID_URL }, 'user-separate-rate-limit')
    const firstText = await textRequest({
      text: 'Pasta med tomatsås, vitlök, olivolja och parmesan. Koka pasta och rör ihop såsen.',
    }, 'user-separate-rate-limit')
    const secondText = await textRequest({
      text: 'Pasta med tomatsås, vitlök, olivolja och parmesan. Koka pasta och rör ihop såsen.',
    }, 'user-separate-rate-limit')

    expect(firstText.status).toBe(200)
    expect(secondText.status).toBe(429)
    await expect(secondText.json()).resolves.toEqual({ error: 'RATE_LIMITED' })
  })

  it('returns UNSUPPORTED_SOCIAL_SOURCE for Instagram links', async () => {
    const response = await request({ url: 'https://www.instagram.com/p/ABC123' }, 'user-instagram')

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toEqual({ error: 'UNSUPPORTED_SOCIAL_SOURCE' })
  })

  it('returns UNSUPPORTED_SOCIAL_SOURCE for instagram.com subdomain', async () => {
    const response = await request({ url: 'https://instagram.com/reel/XYZ789' }, 'user-instagram-bare')

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toEqual({ error: 'UNSUPPORTED_SOCIAL_SOURCE' })
  })

  it('returns UNSUPPORTED_URL when robots.txt disallows crawling', async () => {
    setRecipeImportDependenciesForTests({
      pageFetcher: async () => { throw new RobotsBlockedError() },
    })

    const response = await request({ url: VALID_URL }, 'user-robots-blocked')

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toEqual({ error: 'UNSUPPORTED_URL' })
  })

  it('handles TikTok oEmbed success and feeds caption to social AI extractor', async () => {
    const mockOEmbed = {
      title: 'Easy pasta recipe with 3 ingredients! #recipe #pasta',
      author_name: 'chefmaria',
      author_url: 'https://www.tiktok.com/@chefmaria',
      thumbnail_url: 'https://p16-sign.tiktokcdn.com/thumb.jpg',
      provider_name: 'TikTok',
    }

    setRecipeImportDependenciesForTests({
      tiktokOEmbedFetcher: async () => mockOEmbed,
      socialAiExtractor: async (metadata) => ({
        ...MOCK_RECIPE,
        title: 'Easy Pasta',
        sourceUrl: metadata.canonicalUrl,
      }),
    })

    const response = await request(
      { url: 'https://www.tiktok.com/@chefmaria/video/123456' },
      'user-tiktok-success',
    )

    expect(response.status).toBe(200)
    const body = await response.json() as { recipe: typeof MOCK_RECIPE; source: unknown; warnings: string[]; confidence: string }
    expect(body.recipe.title).toBe('Easy Pasta')
    expect(body.recipe.sourceUrl).toBe('https://www.tiktok.com/@chefmaria/video/123456')
    expect(body.source).toMatchObject({ kind: 'tiktok', url: 'https://www.tiktok.com/@chefmaria/video/123456' })
    expect(Array.isArray(body.warnings)).toBe(true)
    expect(['high', 'medium', 'low']).toContain(body.confidence)
  })

  it('returns NO_RECIPE_FOUND when TikTok oEmbed fails', async () => {
    setRecipeImportDependenciesForTests({
      tiktokOEmbedFetcher: async () => {
        throw new Error('TikTok oEmbed request failed: HTTP 404')
      },
    })

    const response = await request(
      { url: 'https://www.tiktok.com/@chefmaria/video/404' },
      'user-tiktok-oembed-fail',
    )

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toEqual({ error: 'NO_RECIPE_FOUND' })
  })

  // Phase 5 — social draft generation and warnings

  it('TikTok with thin caption produces confidence:low and at least one warning', async () => {
    const mockOEmbed = {
      title: 'Pasta',
      author_name: 'chef',
      thumbnail_url: 'https://p16-sign.tiktokcdn.com/thumb.jpg',
    }

    setRecipeImportDependenciesForTests({
      tiktokOEmbedFetcher: async () => mockOEmbed,
      socialAiExtractor: async (metadata) => ({
        title: metadata.title ?? 'Pasta',
        prepTimeMinutes: null,
        ingredients: [],
        cuisine: null,
        proteinSource: null,
        mealWeight: null,
        tags: [],
        sourceUrl: metadata.canonicalUrl,
      }),
    })

    const response = await request(
      { url: 'https://www.tiktok.com/@chef/video/111' },
      'user-tiktok-thin-caption',
    )

    expect(response.status).toBe(200)
    const body = await response.json() as { confidence: string; warnings: string[]; source: unknown }
    expect(body.confidence).toBe('low')
    expect(body.warnings.length).toBeGreaterThan(0)
    expect(body.source).toMatchObject({ kind: 'tiktok' })
  })

  it('TikTok with detailed caption produces source, warnings, and confidence fields', async () => {
    const mockOEmbed = {
      title: 'Spaghetti carbonara with guanciale, eggs, pecorino, and black pepper — no cream! Ready in 20 minutes. #pasta #italian',
      author_name: 'pastamaster',
      author_url: 'https://www.tiktok.com/@pastamaster',
      thumbnail_url: 'https://p16-sign.tiktokcdn.com/thumb.jpg',
    }

    setRecipeImportDependenciesForTests({
      tiktokOEmbedFetcher: async () => mockOEmbed,
      socialAiExtractor: async (metadata) => ({
        ...MOCK_RECIPE,
        title: 'Spaghetti Carbonara',
        ingredients: [
          { name: 'spaghetti', amount: 400, unit: 'g', category: 'pantry' },
          { name: 'guanciale', amount: 150, unit: 'g', category: 'protein' },
          { name: 'eggs', amount: 4, unit: null, category: 'dairy' },
        ],
        sourceUrl: metadata.canonicalUrl,
      }),
    })

    const response = await request(
      { url: 'https://www.tiktok.com/@pastamaster/video/999' },
      'user-tiktok-detailed',
    )

    expect(response.status).toBe(200)
    const body = await response.json() as {
      recipe: { title: string; sourceUrl: string }
      source: { kind: string; url: string; authorName?: string; thumbnailUrl?: string }
      warnings: string[]
      confidence: string
    }
    expect(body.recipe.title).toBe('Spaghetti Carbonara')
    expect(body.source.kind).toBe('tiktok')
    expect(body.source.authorName).toBe('pastamaster')
    expect(body.source.thumbnailUrl).toBe('https://p16-sign.tiktokcdn.com/thumb.jpg')
    expect(Array.isArray(body.warnings)).toBe(true)
    expect(['high', 'medium', 'low']).toContain(body.confidence)
  })

  it('general web schema.org path returns confidence:high and empty warnings', async () => {
    const response = await request({ url: VALID_URL }, 'user-web-schemaorg')

    expect(response.status).toBe(200)
    const body = await response.json() as { confidence: string; warnings: string[]; source: unknown }
    expect(body.confidence).toBe('high')
    expect(body.warnings).toEqual([])
    expect(body.source).toMatchObject({ kind: 'web', url: VALID_URL })
  })

  it('general web AI fallback path returns confidence:high and empty warnings', async () => {
    setRecipeImportDependenciesForTests({
      pageFetcher: async () => '<html><body>Pasta recipe</body></html>',
      aiExtractor: async () => MOCK_RECIPE,
    })

    const response = await request({ url: VALID_URL }, 'user-web-ai-fallback')

    expect(response.status).toBe(200)
    const body = await response.json() as { confidence: string; warnings: string[]; source: unknown }
    expect(body.confidence).toBe('high')
    expect(body.warnings).toEqual([])
    expect(body.source).toMatchObject({ kind: 'web', url: VALID_URL })
  })
})

// ---- Unit tests for social classification and SSRF safety ----

describe('classifyUrlPlatform', () => {
  it('classifies tiktok.com as tiktok', () => {
    expect(classifyUrlPlatform('https://www.tiktok.com/@user/video/123')).toBe('tiktok')
  })

  it('classifies vm.tiktok.com short links as tiktok', () => {
    expect(classifyUrlPlatform('https://vm.tiktok.com/abc123')).toBe('tiktok')
  })

  it('classifies m.tiktok.com as tiktok', () => {
    expect(classifyUrlPlatform('https://m.tiktok.com/@user/video/123')).toBe('tiktok')
  })

  it('classifies instagram.com as instagram', () => {
    expect(classifyUrlPlatform('https://www.instagram.com/p/ABC')).toBe('instagram')
  })

  it('classifies bare instagram.com as instagram', () => {
    expect(classifyUrlPlatform('https://instagram.com/reel/XYZ')).toBe('instagram')
  })

  it('classifies general recipe sites as web', () => {
    expect(classifyUrlPlatform('https://www.ica.se/recept/kycklinggryta')).toBe('web')
  })

  it('classifies unknown URLs as web', () => {
    expect(classifyUrlPlatform('https://example.com/recipe')).toBe('web')
  })

  it('returns web for malformed URLs', () => {
    expect(classifyUrlPlatform('not-a-url')).toBe('web')
  })
})

describe('resolveUrlSafely', () => {
  it('returns the URL when there are no redirects', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(null, { status: 200 })
    )
    vi.stubGlobal('fetch', mockFetch)

    const result = await resolveUrlSafely('https://www.tiktok.com/@user/video/123')

    expect('url' in result).toBe(true)
    if ('url' in result) {
      expect(result.url).toBe('https://www.tiktok.com/@user/video/123')
    }

    vi.unstubAllGlobals()
  })

  it('follows a redirect and returns the resolved URL', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { location: 'https://www.tiktok.com/@user/video/456' },
        })
      )
      .mockResolvedValueOnce(
        new Response(null, { status: 200 })
      )

    vi.stubGlobal('fetch', mockFetch)

    const result = await resolveUrlSafely('https://vm.tiktok.com/shortcode')

    expect('url' in result).toBe(true)
    if ('url' in result) {
      expect(result.url).toBe('https://www.tiktok.com/@user/video/456')
    }

    vi.unstubAllGlobals()
  })

  it('blocks redirects to private IP addresses', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 301,
        headers: { location: 'http://192.168.1.1/evil' },
      })
    )

    vi.stubGlobal('fetch', mockFetch)

    const result = await resolveUrlSafely('https://vm.tiktok.com/ssrf-attempt')

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toBe('INVALID_URL')
    }

    vi.unstubAllGlobals()
  })

  it('blocks redirects to localhost', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 301,
        headers: { location: 'http://localhost/secret' },
      })
    )

    vi.stubGlobal('fetch', mockFetch)

    const result = await resolveUrlSafely('https://vm.tiktok.com/ssrf-localhost')

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toBe('INVALID_URL')
    }

    vi.unstubAllGlobals()
  })

  it('blocks redirects to 10.x.x.x private range', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 301,
        headers: { location: 'http://10.0.0.1/internal' },
      })
    )

    vi.stubGlobal('fetch', mockFetch)

    const result = await resolveUrlSafely('https://vm.tiktok.com/ssrf-10x')

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toBe('INVALID_URL')
    }

    vi.unstubAllGlobals()
  })

  it('returns FETCH_FAILED after exceeding max redirect hops', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 301,
        headers: { location: 'https://vm.tiktok.com/loop' },
      })
    )

    vi.stubGlobal('fetch', mockFetch)

    const result = await resolveUrlSafely('https://vm.tiktok.com/start', 3)

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toBe('FETCH_FAILED')
    }

    vi.unstubAllGlobals()
  })

  it('returns FETCH_FAILED when a redirect has no location header', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(null, { status: 302 })
    )

    vi.stubGlobal('fetch', mockFetch)

    const result = await resolveUrlSafely('https://vm.tiktok.com/nolocation')

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toBe('FETCH_FAILED')
    }

    vi.unstubAllGlobals()
  })

  it('returns FETCH_FAILED when fetch throws a network error', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('network error'))

    vi.stubGlobal('fetch', mockFetch)

    const result = await resolveUrlSafely('https://vm.tiktok.com/unreachable')

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toBe('FETCH_FAILED')
    }

    vi.unstubAllGlobals()
  })
})

describe('fetchRecipePage SSRF redirect protection', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('blocks a redirect to a private 192.168.x.x address', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 })) // robots.txt
      .mockResolvedValueOnce(new Response(null, {
        status: 301,
        headers: { location: 'http://192.168.1.1/secret' },
      })),
    )
    await expect(fetchRecipePage('https://example.com/recipe')).rejects.toThrow(FetchError)
  })

  it('blocks a redirect to the AWS metadata endpoint (169.254.169.254)', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 })) // robots.txt
      .mockResolvedValueOnce(new Response(null, {
        status: 301,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      })),
    )
    await expect(fetchRecipePage('https://example.com/recipe')).rejects.toThrow(FetchError)
  })

  it('blocks a redirect to localhost', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 })) // robots.txt
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: 'http://localhost:8080/admin' },
      })),
    )
    await expect(fetchRecipePage('https://example.com/recipe')).rejects.toThrow(FetchError)
  })

  it('follows a safe redirect and returns html', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 })) // robots.txt
      .mockResolvedValueOnce(new Response(null, {
        status: 301,
        headers: { location: 'https://example.com/recipe-final' },
      }))
      .mockResolvedValueOnce(new Response('<html>recipe</html>', { status: 200 })),
    )
    const html = await fetchRecipePage('https://example.com/recipe')
    expect(html).toBe('<html>recipe</html>')
  })

  it('throws NETWORK_ERROR when redirect has no location header', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 })) // robots.txt
      .mockResolvedValueOnce(new Response(null, { status: 301 })),
    )
    const err = await fetchRecipePage('https://example.com/recipe').catch((e) => e)
    expect(err).toBeInstanceOf(FetchError)
    expect((err as FetchError).code).toBe('NETWORK_ERROR')
  })

  it('throws RobotsBlockedError when robots.txt disallows VecklyBot', async () => {
    const robotsTxt = 'User-agent: *\nDisallow: /'
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(robotsTxt, { status: 200 })), // robots.txt
    )
    await expect(fetchRecipePage('https://example.com/recipe')).rejects.toThrow(RobotsBlockedError)
  })
})

describe('parseRobotsText', () => {
  it('throws when wildcard user-agent disallows root', () => {
    expect(() => parseRobotsText('User-agent: *\nDisallow: /')).toThrow(RobotsBlockedError)
  })

  it('throws when VecklyBot is explicitly disallowed', () => {
    expect(() => parseRobotsText('User-agent: VecklyBot\nDisallow: /')).toThrow(RobotsBlockedError)
  })

  it('does not throw when a different bot is disallowed', () => {
    expect(() => parseRobotsText('User-agent: Googlebot\nDisallow: /')).not.toThrow()
  })

  it('does not throw for an empty robots.txt', () => {
    expect(() => parseRobotsText('')).not.toThrow()
  })

  it('does not throw when disallow is for a subpath only', () => {
    expect(() => parseRobotsText('User-agent: *\nDisallow: /private/')).not.toThrow()
  })
})
