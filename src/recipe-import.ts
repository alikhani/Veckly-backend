import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { requireAuth, requireInternalAuth, type AuthedUser } from './auth.js'

const PRIVATE_IP_PATTERN =
  /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|0\.0\.0\.0)/
const MAX_CONTENT_BYTES = 500 * 1024
const FETCH_TIMEOUT_MS = 8_000
const ROBOTS_TIMEOUT_MS = 3_000
const MAX_TEXT_LENGTH = 3_000
const MAX_REDIRECT_HOPS = 5
const TIKTOK_OEMBED_URL = 'https://www.tiktok.com/oembed'
const TIKTOK_HOSTS = new Set(['tiktok.com', 'www.tiktok.com', 'vm.tiktok.com', 'm.tiktok.com'])
const INSTAGRAM_HOSTS = new Set(['instagram.com', 'www.instagram.com'])

const RawRecipeIngredientSchema = z.object({
  amount: z.number().nullable(),
  category: z.string().nullable(),
  name: z.string(),
  unit: z.string().nullable(),
}).openapi('ImportedRecipeIngredient')

const RawRecipeSchema = z.object({
  cuisine: z.string().nullable(),
  ingredients: z.array(RawRecipeIngredientSchema),
  mealWeight: z.string().nullable(),
  prepTimeMinutes: z.number().int().nullable(),
  proteinSource: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  tags: z.array(z.string()),
  title: z.string(),
}).openapi('ImportedRecipe')

const ImportBodySchema = z.object({ url: z.string() }).openapi('RecipeImportRequest')
const TextImportBodySchema = z.object({
  text: z.string(),
  sourceUrl: z.string().optional(),
}).openapi('RecipeTextImportRequest')
const ImportSourceSchema = z.object({
  kind: z.enum(['web', 'tiktok', 'instagram']),
  url: z.string(),
  title: z.string().optional(),
  authorName: z.string().optional(),
  thumbnailUrl: z.string().optional(),
}).openapi('ImportSource')

const ImportEnvelopeSchema = z.object({
  recipe: RawRecipeSchema,
  source: ImportSourceSchema.optional(),
  warnings: z.array(z.string()),
  confidence: z.enum(['high', 'medium', 'low']),
}).openapi('RecipeImportEnvelope')
const RecipeImportErrorSchema = z.object({
  error: z.enum([
    'INVALID_URL',
    'UNSUPPORTED_URL',
    'FETCH_FAILED',
    'NO_RECIPE_FOUND',
    'RATE_LIMITED',
    'IMPORT_FAILED',
    'UNSUPPORTED_SOCIAL_SOURCE',
    'CAPTION_REQUIRED',
  ]),
}).openapi('RecipeImportError')

const ImportIngredientSchema = z.object({
  amount: z.number().positive().nullable().optional(),
  category: z.enum(['produce', 'dairy', 'protein', 'pantry', 'frozen', 'other']).nullable().optional(),
  name: z.string().min(1).max(200),
  unit: z.string().max(20).nullable().optional(),
})

const ImportExtractionSchema = z.object({
  cuisine: z.enum(['italian', 'asian', 'nordic', 'mexican', 'middle-eastern', 'comfort']).nullable().optional(),
  ingredients: z.array(ImportIngredientSchema).min(1).max(100),
  mealWeight: z.enum(['light', 'medium', 'hearty']).nullable().optional(),
  prepTimeMinutes: z.number().int().min(1).max(600).nullable().optional(),
  proteinSource: z.enum(['chicken', 'beef', 'pork', 'lamb', 'fish', 'seafood', 'vegetarian', 'legumes', 'mixed']).nullable().optional(),
  tags: z.array(z.string().max(30)).max(20).optional(),
  title: z.string().min(1).max(120),
})

type TRawRecipeIngredient = z.infer<typeof RawRecipeIngredientSchema>
type TRawRecipe = z.infer<typeof RawRecipeSchema>
type TPageFetcher = (url: string) => Promise<string>
type TImportExtractor = (html: string, sourceUrl: string) => Promise<TRawRecipe>
type TTextImportExtractor = (text: string, sourceUrl: string | null) => Promise<TRawRecipe>
type TSocialImportExtractor = (metadata: TImportSourceMetadata) => Promise<TRawRecipe>

type TImportPlatform = 'web' | 'tiktok' | 'instagram'

type TImportSourceMetadata = {
  platform: TImportPlatform
  canonicalUrl: string
  title?: string
  description?: string
  authorName?: string
  authorUrl?: string
  thumbnailUrl?: string
  rawTextForDraft?: string
}

type TTikTokOEmbed = {
  title?: string
  author_name?: string
  author_url?: string
  thumbnail_url?: string
  provider_name?: string
}

type TOEmbedFetcher = (canonicalUrl: string) => Promise<TTikTokOEmbed>

const importRateLimitHits = new Map<string, number>()
const textImportRateLimitHits = new Map<string, number>()
let pageFetcher: TPageFetcher = fetchRecipePage
let aiExtractor: TImportExtractor = extractRecipeWithAi
let textAiExtractor: TTextImportExtractor = extractRecipeFromTextWithAi
let socialAiExtractor: TSocialImportExtractor = extractRecipeFromSocialWithAi
let tiktokOEmbedFetcher: TOEmbedFetcher = fetchTikTokOEmbed

export class FetchError extends Error {
  code: 'NETWORK_ERROR' | 'TIMEOUT' | 'TOO_LARGE'

  constructor(code: 'NETWORK_ERROR' | 'TIMEOUT' | 'TOO_LARGE') {
    super(code)
    this.code = code
  }
}

export function setRecipeImportDependenciesForTests(deps: {
  aiExtractor?: TImportExtractor
  pageFetcher?: TPageFetcher
  textAiExtractor?: TTextImportExtractor
  socialAiExtractor?: TSocialImportExtractor
  tiktokOEmbedFetcher?: TOEmbedFetcher
} | null) {
  pageFetcher = deps?.pageFetcher ?? fetchRecipePage
  aiExtractor = deps?.aiExtractor ?? extractRecipeWithAi
  textAiExtractor = deps?.textAiExtractor ?? extractRecipeFromTextWithAi
  socialAiExtractor = deps?.socialAiExtractor ?? extractRecipeFromSocialWithAi
  tiktokOEmbedFetcher = deps?.tiktokOEmbedFetcher ?? fetchTikTokOEmbed
  importRateLimitHits.clear()
  textImportRateLimitHits.clear()
}

function isRateLimited(hits: Map<string, number>, userId: string, now = Date.now()) {
  const previous = hits.get(userId)
  if (previous !== undefined && now - previous < 15_000) return true
  hits.set(userId, now)
  return false
}

export function classifyUrlPlatform(url: string): TImportPlatform {
  let hostname: string
  try {
    hostname = new URL(url).hostname.toLowerCase()
  } catch {
    return 'web'
  }
  if (TIKTOK_HOSTS.has(hostname)) return 'tiktok'
  if (INSTAGRAM_HOSTS.has(hostname)) return 'instagram'
  return 'web'
}

function isPrivateHost(hostname: string): boolean {
  return PRIVATE_IP_PATTERN.test(hostname)
}

export async function resolveUrlSafely(
  startUrl: string,
  maxHops = MAX_REDIRECT_HOPS,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<{ url: string } | { error: 'INVALID_URL' | 'FETCH_FAILED' }> {
  let current = startUrl
  for (let hop = 0; hop <= maxHops; hop++) {
    let parsed: URL
    try {
      parsed = new URL(current)
    } catch {
      return { error: 'INVALID_URL' }
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { error: 'INVALID_URL' }
    if (isPrivateHost(parsed.hostname)) return { error: 'INVALID_URL' }

    if (hop === maxHops) {
      // We've already followed maxHops redirects without settling — treat as failure
      return { error: 'FETCH_FAILED' }
    }

    let response: Response
    try {
      response = await fetch(current, {
        method: 'HEAD',
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'User-Agent': 'VecklyBot/1.0' },
      })
    } catch (err) {
      return { error: 'FETCH_FAILED' }
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) return { error: 'FETCH_FAILED' }
      // Resolve relative redirects against current URL
      try {
        current = new URL(location, current).toString()
      } catch {
        return { error: 'FETCH_FAILED' }
      }
      continue
    }

    // Non-redirect response — we've settled on the canonical URL
    return { url: current }
  }

  return { error: 'FETCH_FAILED' }
}

export async function fetchTikTokOEmbed(canonicalUrl: string): Promise<TTikTokOEmbed> {
  const endpoint = `${TIKTOK_OEMBED_URL}?url=${encodeURIComponent(canonicalUrl)}`
  const response = await fetch(endpoint, {
    headers: { 'User-Agent': 'VecklyBot/1.0' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`TikTok oEmbed request failed: HTTP ${response.status}`)
  }
  return response.json() as Promise<TTikTokOEmbed>
}

export async function extractTikTokMetadata(
  url: string,
): Promise<TImportSourceMetadata | { error: 'INVALID_URL' | 'FETCH_FAILED' | 'NO_RECIPE_FOUND' }> {
  // Resolve short links (vm.tiktok.com) safely through SSRF guards
  const resolved = await resolveUrlSafely(url)
  if ('error' in resolved) return resolved

  const canonicalUrl = resolved.url

  // After resolution, ensure the final host is still an allowed TikTok domain
  let finalHostname: string
  try {
    finalHostname = new URL(canonicalUrl).hostname.toLowerCase()
  } catch {
    return { error: 'INVALID_URL' }
  }

  if (!TIKTOK_HOSTS.has(finalHostname)) {
    // Redirect landed on a non-TikTok domain — refuse
    return { error: 'FETCH_FAILED' }
  }

  let oembed: TTikTokOEmbed
  try {
    oembed = await tiktokOEmbedFetcher(canonicalUrl)
  } catch {
    return { error: 'NO_RECIPE_FOUND' }
  }

  const metadata: TImportSourceMetadata = {
    platform: 'tiktok',
    canonicalUrl,
    title: typeof oembed.title === 'string' && oembed.title.trim() ? oembed.title.trim() : undefined,
    authorName: typeof oembed.author_name === 'string' && oembed.author_name.trim() ? oembed.author_name.trim() : undefined,
    authorUrl: typeof oembed.author_url === 'string' && oembed.author_url.trim() ? oembed.author_url.trim() : undefined,
    thumbnailUrl: typeof oembed.thumbnail_url === 'string' && oembed.thumbnail_url.trim() ? oembed.thumbnail_url.trim() : undefined,
  }

  // rawTextForDraft is the caption/title text passed to the AI extraction path
  const captionText = [oembed.title, oembed.author_name].filter(Boolean).join(' — ')
  if (captionText.trim()) {
    metadata.rawTextForDraft = captionText.trim()
  }

  return metadata
}

function validateUrl(raw: unknown): { url: string } | { error: 'INVALID_URL' } {
  if (typeof raw !== 'string' || raw.trim().length === 0) return { error: 'INVALID_URL' }
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    return { error: 'INVALID_URL' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { error: 'INVALID_URL' }
  if (PRIVATE_IP_PATTERN.test(parsed.hostname)) return { error: 'INVALID_URL' }
  return { url: parsed.toString() }
}

function validateOptionalUrl(raw: unknown): { url: string | null } | { error: 'INVALID_URL' } {
  if (raw === undefined || raw === null || raw === '') return { url: null }
  return validateUrl(raw)
}

function parseRobotsText(text: string, origin: string): void {
  let applies = false
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (/^user-agent:/i.test(trimmed)) {
      const agent = trimmed.slice('user-agent:'.length).trim()
      applies = agent === '*' || /vecklybot|mealplannerbot/i.test(agent)
    }
    if (applies && /^disallow:\s*\//i.test(trimmed)) {
      console.warn(`[import-from-url] robots.txt Disallow: / on ${origin}`)
    }
  }
}

async function checkRobotsTxt(url: string): Promise<void> {
  const { origin } = new URL(url)
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { 'User-Agent': 'VecklyBot/1.0' },
      signal: AbortSignal.timeout(ROBOTS_TIMEOUT_MS),
    })
    if (res.ok) parseRobotsText(await res.text(), origin)
  } catch {
    // best-effort only
  }
}

export async function fetchRecipePage(url: string): Promise<string> {
  await checkRobotsTxt(url)

  let response: Response
  try {
    response = await fetch(url, {
      headers: { Accept: 'text/html', 'User-Agent': 'VecklyBot/1.0 (recipe import)' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'TimeoutError'
    throw new FetchError(isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR')
  }

  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (contentLength > MAX_CONTENT_BYTES) throw new FetchError('TOO_LARGE')

  const html = await response.text()
  if (html.length > MAX_CONTENT_BYTES) throw new FetchError('TOO_LARGE')
  return html
}

type TSchemaOrgBlock = Record<string, unknown>

function isRecipeType(type: unknown): boolean {
  if (typeof type === 'string') return type === 'Recipe'
  if (Array.isArray(type)) return (type as unknown[]).includes('Recipe')
  return false
}

function parseIsoDuration(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = value.match(/PT(?:(\d+)H)?(?:(\d+)M)?/)
  if (!match) return null
  const hours = parseInt(match[1] ?? '0', 10)
  const minutes = parseInt(match[2] ?? '0', 10)
  const total = hours * 60 + minutes
  return total > 0 ? total : null
}

function parseIngredientString(raw: unknown): TRawRecipeIngredient | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  const match = raw.trim().match(/^([\d.,/½¼¾]+)\s*([a-zA-ZåäöÅÄÖ]+\.?)\s+(.+)$/)
  if (match) {
    const [, rawAmount, rawUnit, rawName] = match
    if (!rawAmount || !rawUnit || !rawName) return { name: raw.trim(), amount: null, unit: null, category: null }
    const amount = parseFloat(rawAmount.replace(',', '.'))
    return { name: rawName.trim(), amount: isNaN(amount) ? null : amount, unit: rawUnit.replace(/\.$/, ''), category: null }
  }
  return { name: raw.trim(), amount: null, unit: null, category: null }
}

function extractJsonLdBlocks(html: string): TSchemaOrgBlock[] {
  const blocks: TSchemaOrgBlock[] = []
  const regex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let match: RegExpExecArray | null
  while ((match = regex.exec(html)) !== null) {
    try {
      const jsonText = match[1]
      if (!jsonText) continue
      const parsed: unknown = JSON.parse(jsonText)
      if (Array.isArray(parsed)) blocks.push(...(parsed as TSchemaOrgBlock[]))
      else if (parsed && typeof parsed === 'object') blocks.push(parsed as TSchemaOrgBlock)
    } catch {
      // malformed JSON-LD — skip
    }
  }
  return blocks
}

function findRecipeBlock(blocks: TSchemaOrgBlock[]): TSchemaOrgBlock | null {
  for (const block of blocks) {
    if (isRecipeType(block['@type'])) return block
  }
  for (const block of blocks) {
    const graph = block['@graph']
    if (!Array.isArray(graph)) continue
    const recipe = (graph as TSchemaOrgBlock[]).find((item) => isRecipeType(item['@type']))
    if (recipe) return recipe
  }
  return null
}

export function parseSchemaOrgRecipe(html: string, sourceUrl: string): TRawRecipe | null {
  const recipe = findRecipeBlock(extractJsonLdBlocks(html))
  if (!recipe) return null
  if (typeof recipe['name'] !== 'string' || recipe['name'].trim().length === 0) return null

  const rawIngredients = Array.isArray(recipe['recipeIngredient']) ? recipe['recipeIngredient'] : []
  const ingredients = (rawIngredients as unknown[])
    .map(parseIngredientString)
    .filter((i): i is TRawRecipeIngredient => i !== null)

  const rawKeywords = recipe['keywords']
  const tags = typeof rawKeywords === 'string'
    ? rawKeywords.split(',').map((k) => k.trim()).filter(Boolean).slice(0, 10)
    : []

  return {
    title: (recipe['name'] as string).trim(),
    prepTimeMinutes: parseIsoDuration(recipe['prepTime']) ?? parseIsoDuration(recipe['totalTime']),
    ingredients,
    cuisine: typeof recipe['recipeCuisine'] === 'string' ? recipe['recipeCuisine'] : null,
    proteinSource: null,
    mealWeight: null,
    tags,
    sourceUrl,
  }
}

const IMPORT_SYSTEM_PROMPT = `You are a recipe data extractor. Extract recipe data from the provided webpage text.
Return ONLY a single valid JSON object — no markdown, no explanation.

JSON structure:
{
  "title": "<recipe title>",
  "prepTimeMinutes": <integer or null>,
  "tags": ["<tag>"],
  "cuisine": "italian"|"asian"|"nordic"|"mexican"|"middle-eastern"|"comfort"|null,
  "proteinSource": "chicken"|"beef"|"pork"|"lamb"|"fish"|"seafood"|"vegetarian"|"legumes"|"mixed"|null,
  "mealWeight": "light"|"medium"|"hearty"|null,
  "ingredients": [{ "name": "<name>", "amount": <number|null>, "unit": "<unit|null>", "category": "<category|null>" }]
}

Do NOT include cooking steps. Omit amounts and units when uncertain.`

const TEXT_IMPORT_SYSTEM_PROMPT = `You are a recipe data extractor. Extract recipe data from pasted recipe text, a social caption, or notes.
Return ONLY a single valid JSON object — no markdown, no explanation.

JSON structure:
{
  "title": "<recipe title>",
  "prepTimeMinutes": <integer or null>,
  "tags": ["<tag>"],
  "cuisine": "italian"|"asian"|"nordic"|"mexican"|"middle-eastern"|"comfort"|null,
  "proteinSource": "chicken"|"beef"|"pork"|"lamb"|"fish"|"seafood"|"vegetarian"|"legumes"|"mixed"|null,
  "mealWeight": "light"|"medium"|"hearty"|null,
  "ingredients": [{ "name": "<name>", "amount": <number|null>, "unit": "<unit|null>", "category": "<category|null>" }]
}

Extract only when the text contains enough recipe detail to form a useful dinner draft.
Do NOT invent ingredients. Do NOT include cooking steps. Omit amounts and units when uncertain.`

const SOCIAL_DRAFT_SYSTEM_PROMPT = `You are a recipe data extractor working from a social media caption or video title.
The source is a short text from a social platform — not a structured recipe page.
Return ONLY a single valid JSON object — no markdown, no explanation.

JSON structure:
{
  "title": "<recipe title>",
  "prepTimeMinutes": <integer or null>,
  "tags": ["<tag>"],
  "cuisine": "italian"|"asian"|"nordic"|"mexican"|"middle-eastern"|"comfort"|null,
  "proteinSource": "chicken"|"beef"|"pork"|"lamb"|"fish"|"seafood"|"vegetarian"|"legumes"|"mixed"|null,
  "mealWeight": "light"|"medium"|"hearty"|null,
  "ingredients": [{ "name": "<name>", "amount": <number|null>, "unit": "<unit|null>", "category": "<category|null>" }]
}

Rules:
- Infer only what is explicitly supported by the caption or title text.
- Leave ingredient amounts and units as null when not stated — never invent quantities.
- If ingredients can be named but amounts are unclear, include the ingredient with amount null.
- Do NOT include cooking steps.
- Produce a best-effort household recipe draft when enough text exists.
- If the text is too thin to name even a title, still return the structure with a best-guess title and empty ingredients array.`

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function toIngredient(i: z.infer<typeof ImportIngredientSchema>): TRawRecipeIngredient {
  return {
    name: i.name,
    amount: i.amount ?? null,
    unit: i.unit ?? null,
    category: i.category ?? null,
  }
}

async function generateStructuredJSON(systemPrompt: string, userMessage: string) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured')

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
    headers: {
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL ?? 'claude-3-5-haiku-latest',
      max_tokens: 1800,
      temperature: 0,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  })

  if (!response.ok) {
    const errBody = await response.text().catch(() => '(unreadable)')
    throw new Error(`Anthropic request failed: HTTP ${response.status} — ${errBody}`)
  }
  const body = await response.json() as { content?: Array<{ type: string; text?: string }> }
  const text = body.content?.find((part) => part.type === 'text')?.text
  if (!text) throw new Error('Anthropic response did not include text content')
  return text
}

export async function extractRecipeWithAi(html: string, sourceUrl: string): Promise<TRawRecipe> {
  const text = stripHtml(html).slice(0, MAX_TEXT_LENGTH)
  const raw = await generateStructuredJSON(IMPORT_SYSTEM_PROMPT, `URL: ${sourceUrl}\n\n${text}`)

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('AI_PARSE_FAILED')
  }

  const result = ImportExtractionSchema.safeParse(parsed)
  if (!result.success) throw new Error('AI_VALIDATION_FAILED')

  const data = result.data
  return {
    title: data.title,
    prepTimeMinutes: data.prepTimeMinutes ?? null,
    ingredients: data.ingredients.map(toIngredient),
    cuisine: data.cuisine ?? null,
    proteinSource: data.proteinSource ?? null,
    mealWeight: data.mealWeight ?? null,
    tags: data.tags ?? [],
    sourceUrl,
  }
}

export async function extractRecipeFromTextWithAi(text: string, sourceUrl: string | null): Promise<TRawRecipe> {
  const trimmedText = text.trim().slice(0, MAX_TEXT_LENGTH)
  const raw = await generateStructuredJSON(
    TEXT_IMPORT_SYSTEM_PROMPT,
    `Source URL: ${sourceUrl ?? 'none'}\n\n${trimmedText}`
  )

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('AI_PARSE_FAILED')
  }

  const result = ImportExtractionSchema.safeParse(parsed)
  if (!result.success) throw new Error('AI_VALIDATION_FAILED')

  const data = result.data
  return {
    title: data.title,
    prepTimeMinutes: data.prepTimeMinutes ?? null,
    ingredients: data.ingredients.map(toIngredient),
    cuisine: data.cuisine ?? null,
    proteinSource: data.proteinSource ?? null,
    mealWeight: data.mealWeight ?? null,
    tags: data.tags ?? [],
    sourceUrl,
  }
}

export async function extractRecipeFromSocialWithAi(
  metadata: TImportSourceMetadata,
): Promise<TRawRecipe> {
  const captionText = (metadata.rawTextForDraft ?? metadata.title ?? '').slice(0, MAX_TEXT_LENGTH)
  const raw = await generateStructuredJSON(
    SOCIAL_DRAFT_SYSTEM_PROMPT,
    `Source URL: ${metadata.canonicalUrl}\nAuthor: ${metadata.authorName ?? 'unknown'}\n\nCaption/title:\n${captionText}`
  )

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('AI_PARSE_FAILED')
  }

  const result = ImportExtractionSchema.safeParse(parsed)
  if (!result.success) throw new Error('AI_VALIDATION_FAILED')

  const data = result.data
  return {
    title: data.title,
    prepTimeMinutes: data.prepTimeMinutes ?? null,
    ingredients: data.ingredients.map(toIngredient),
    cuisine: data.cuisine ?? null,
    proteinSource: data.proteinSource ?? null,
    mealWeight: data.mealWeight ?? null,
    tags: data.tags ?? [],
    sourceUrl: metadata.canonicalUrl,
  }
}

type TImportConfidence = 'high' | 'medium' | 'low'

function computeTikTokConfidenceAndWarnings(
  metadata: TImportSourceMetadata,
  recipe: TRawRecipe,
): { confidence: TImportConfidence; warnings: string[] } {
  const warnings: string[] = []
  const captionLength = (metadata.rawTextForDraft ?? metadata.title ?? '').length
  const hasIngredients = recipe.ingredients.length > 0
  const anyAmountsMissing = recipe.ingredients.some((i) => i.amount === null)

  if (captionLength < 80) {
    warnings.push('Recipe details are based on a short caption — review before saving.')
  }
  if (!hasIngredients) {
    warnings.push('No ingredients could be identified from the caption.')
  } else if (anyAmountsMissing) {
    warnings.push('Ingredient amounts may be incomplete.')
  }

  let confidence: TImportConfidence
  if (warnings.length === 0) {
    confidence = 'high'
  } else if (!hasIngredients || captionLength < 40) {
    confidence = 'low'
  } else {
    confidence = 'medium'
  }

  return { confidence, warnings }
}

async function handleRecipeImport(userId: string, rawUrl: unknown) {
  if (isRateLimited(importRateLimitHits, userId)) return { body: { error: 'RATE_LIMITED' }, status: 429 as const }

  const validated = validateUrl(rawUrl)
  if ('error' in validated) return { body: { error: 'INVALID_URL' }, status: 400 as const }

  const platform = classifyUrlPlatform(validated.url)

  if (platform === 'instagram') {
    return { body: { error: 'UNSUPPORTED_SOCIAL_SOURCE' }, status: 422 as const }
  }

  if (platform === 'tiktok') {
    const result = await extractTikTokMetadata(validated.url)
    if ('error' in result) {
      const statusMap = {
        INVALID_URL: 400 as const,
        FETCH_FAILED: 500 as const,
        NO_RECIPE_FOUND: 422 as const,
      }
      return { body: { error: result.error }, status: statusMap[result.error] }
    }

    // Feed the social metadata into the social-specific AI extraction path
    let recipe: TRawRecipe
    try {
      recipe = await socialAiExtractor(result)
    } catch {
      return { body: { error: 'NO_RECIPE_FOUND' }, status: 422 as const }
    }

    const { confidence, warnings } = computeTikTokConfidenceAndWarnings(result, recipe)
    const source = {
      kind: 'tiktok' as const,
      url: result.canonicalUrl,
      title: result.title,
      authorName: result.authorName,
      thumbnailUrl: result.thumbnailUrl,
    }
    return { body: { recipe, source, warnings, confidence }, status: 200 as const }
  }

  // General web path
  let html: string
  try {
    html = await pageFetcher(validated.url)
  } catch {
    return { body: { error: 'FETCH_FAILED' }, status: 500 as const }
  }

  const schemaOrgResult = parseSchemaOrgRecipe(html, validated.url)
  if (schemaOrgResult) {
    return {
      body: {
        recipe: schemaOrgResult,
        source: { kind: 'web' as const, url: validated.url },
        warnings: [],
        confidence: 'high' as const,
      },
      status: 200 as const,
    }
  }

  try {
    const recipe = await aiExtractor(html, validated.url)
    return {
      body: {
        recipe,
        source: { kind: 'web' as const, url: validated.url },
        warnings: [],
        confidence: 'high' as const,
      },
      status: 200 as const,
    }
  } catch {
    return { body: { error: 'NO_RECIPE_FOUND' }, status: 422 as const }
  }
}

async function handleRecipeTextImport(userId: string, rawText: unknown, rawSourceUrl: unknown) {
  if (isRateLimited(textImportRateLimitHits, userId)) return { body: { error: 'RATE_LIMITED' }, status: 429 as const }
  if (typeof rawText !== 'string' || rawText.trim().length < 20) {
    return { body: { error: 'NO_RECIPE_FOUND' }, status: 422 as const }
  }

  const sourceUrl = validateOptionalUrl(rawSourceUrl)
  if ('error' in sourceUrl) return { body: { error: 'INVALID_URL' }, status: 400 as const }

  try {
    const recipe = await textAiExtractor(rawText, sourceUrl.url)
    return { body: { recipe, warnings: [], confidence: 'high' as const }, status: 200 as const }
  } catch {
    return { body: { error: 'NO_RECIPE_FOUND' }, status: 422 as const }
  }
}

const importRoute = createRoute({
  method: 'post',
  path: '/recipes/import-from-url',
  operationId: 'importRecipeFromUrl',
  summary: 'Import recipe metadata from a URL',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: ImportBodySchema } } },
  },
  responses: {
    200: { description: 'Imported recipe', content: { 'application/json': { schema: ImportEnvelopeSchema } } },
    400: { description: 'Invalid URL', content: { 'application/json': { schema: RecipeImportErrorSchema } } },
    401: { description: 'Missing or invalid session' },
    422: { description: 'Could not parse recipe from fetched page', content: { 'application/json': { schema: RecipeImportErrorSchema } } },
    429: { description: 'Rate limited', content: { 'application/json': { schema: RecipeImportErrorSchema } } },
    500: { description: 'Could not fetch page', content: { 'application/json': { schema: RecipeImportErrorSchema } } },
  },
})

const textImportRoute = createRoute({
  method: 'post',
  path: '/recipes/import-from-text',
  operationId: 'importRecipeFromText',
  summary: 'Import recipe metadata from pasted text',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: TextImportBodySchema } } },
  },
  responses: {
    200: { description: 'Imported recipe', content: { 'application/json': { schema: ImportEnvelopeSchema } } },
    400: { description: 'Invalid source URL', content: { 'application/json': { schema: RecipeImportErrorSchema } } },
    401: { description: 'Missing or invalid session' },
    422: { description: 'Could not parse recipe from pasted text', content: { 'application/json': { schema: RecipeImportErrorSchema } } },
    429: { description: 'Rate limited', content: { 'application/json': { schema: RecipeImportErrorSchema } } },
    500: { description: 'Could not import pasted text', content: { 'application/json': { schema: RecipeImportErrorSchema } } },
  },
})

export function buildRecipeImportRoutes() {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()

  app.use('/recipes/*', requireAuth)

  app.openapi(importRoute, async (c) => {
    const user = c.get('user')
    const body = c.req.valid('json')
    const result = await handleRecipeImport(user.id, body.url)
    return c.json(result.body as never, result.status)
  })

  app.openapi(textImportRoute, async (c) => {
    const user = c.get('user')
    const body = c.req.valid('json')
    const result = await handleRecipeTextImport(user.id, body.text, body.sourceUrl)
    return c.json(result.body as never, result.status)
  })

  return app
}

export function buildInternalRecipeImportRoutes() {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()

  app.use('/internal/*', requireInternalAuth)

  app.post('/internal/recipes/import-from-url', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => null) as { url?: unknown } | null
    const result = await handleRecipeImport(user.id, body?.url)
    return c.json(result.body, result.status)
  })

  app.post('/internal/recipes/import-from-text', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => null) as { text?: unknown; sourceUrl?: unknown } | null
    const result = await handleRecipeTextImport(user.id, body?.text, body?.sourceUrl)
    return c.json(result.body, result.status)
  })

  return app
}
