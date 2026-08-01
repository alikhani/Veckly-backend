import Anthropic from '@anthropic-ai/sdk'
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, eq } from 'drizzle-orm'
import { requireAuth, requireInternalAuth, type AuthedUser } from './auth.js'
import { languageFromAcceptLanguage, type AppLanguage } from './locale.js'
import { assertMembership } from './membership.js'
import { isRateLimited } from './rate-limit.js'
import { withRls } from './rls.js'
import { householdRecipeRecommendations } from './schema.js'
import { resolveEntitlementForHousehold } from './entitlements.js'
import { observePremiumGate } from './premium-gates.js'
import type { Db } from './db.js'

const RecommendationSchema = z.object({
  mealId: z.string().min(1),
  reason: z.string().min(1),
}).openapi('MealRecommendation')

const RecommendResponseSchema = z.object({
  recommendations: z.array(RecommendationSchema).max(15),
}).openapi('MealRecommendationsResponse')

const FeedbackItemSchema = z.object({
  mealId: z.string(),
  mealTitle: z.string(),
  vote: z.enum(['up', 'down']),
  signal: z.string().optional(),
})

const RecommendBodySchema = z.object({
  // Optional for backward compatibility with the MealPlanner strangle route,
  // which doesn't send it yet — caching only engages when it's present.
  // When present, it's verified against the caller's own membership before
  // being trusted as a cache key (see `resolveCacheableHouseholdId`).
  householdId: z.string().uuid().optional(),
  householdProfile: z.object({
    adults: z.number(),
    children: z.number(),
    priorities: z.array(z.string()),
    avoidIngredients: z.array(z.string()),
  }),
  feedbackSummary: z.array(FeedbackItemSchema),
  candidateMeals: z.array(z.object({ id: z.string(), title: z.string() })).min(1),
  recentMealIds: z.object({
    lastWeek: z.array(z.string()),
    twoWeeksAgo: z.array(z.string()),
  }).optional(),
  prepContext: z.object({ isCookDay: z.boolean() }).optional(),
}).openapi('MealRecommendationsRequest')

type TRecommendBody = z.infer<typeof RecommendBodySchema>
type TFeedbackItem = z.infer<typeof FeedbackItemSchema>
type TGenerator = (systemPrompt: string, userMessage: string) => Promise<string>

let generator: TGenerator = generateStructuredJSON

export function setRecipeRecommendationGeneratorForTests(next: TGenerator | null) {
  generator = next ?? generateStructuredJSON
}

// Built-in recipe titles are stored in English regardless of the caller's
// app language, so "match the meal title's language" (what this used to
// say) meant the reason was always English too — even for a Swedish-language
// caller. The reason is the only free-text part of this response the user
// actually reads; it should follow the caller's language explicitly instead.
function systemPrompt(language: AppLanguage): string {
  const languageInstruction = language === 'sv'
    ? '"reason" must be one concise sentence, max 12 words, written in Swedish — regardless of what language the meal title itself is in'
    : '"reason" must be one concise sentence, max 12 words, written in English — regardless of what language the meal title itself is in'
  return `You are a meal recommendation assistant for a family meal planning app.
Your only job is to return a single valid JSON object — no explanation, no markdown, no preamble.

Given a household profile, their feedback history, and a list of available meals, return a ranked shortlist of 8–12 meals that best fit this family.

Return this exact JSON structure:
{
  "recommendations": [
    { "mealId": "<id from candidate list>", "reason": "<one short sentence why it fits>" }
  ]
}

Rules:
- Only use mealIds from the provided candidate list — never invent IDs
- Rank best match first
- ${languageInstruction}
- 8 to 12 recommendations total
- Do not include meals with explicit negative feedback unless no better option exists`
}

// A household's taste profile and feedback history don't meaningfully shift
// week to week, and the product's own planning cadence is "once a week" (see
// vision.md) — so a week is the natural TTL: recomputing this ~10s AI call on
// every app launch bought nothing beyond cost and latency for something that
// was already correct a day, or several days, ago.
const RECOMMENDATION_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

type TCachedRecommendation = { mealId: string; reason: string }

async function getCachedRecommendations(
  db: Db,
  accessToken: string,
  householdId: string,
  language: AppLanguage,
): Promise<TCachedRecommendation[] | null> {
  return withRls(db, accessToken, async (tx) => {
    const [row] = await tx
      .select()
      .from(householdRecipeRecommendations)
      .where(and(
        eq(householdRecipeRecommendations.householdId, householdId),
        eq(householdRecipeRecommendations.language, language),
      ))
    if (!row) return null
    const isFresh = Date.now() - row.computedAt.getTime() <= RECOMMENDATION_CACHE_TTL_MS
    if (!isFresh) return null
    return row.recommendations as TCachedRecommendation[]
  })
}

async function saveRecommendationsToCache(
  db: Db,
  accessToken: string,
  householdId: string,
  language: AppLanguage,
  recommendations: TCachedRecommendation[],
) {
  await withRls(db, accessToken, async (tx) => {
    await tx
      .insert(householdRecipeRecommendations)
      .values({ householdId, language, recommendations, computedAt: new Date() })
      .onConflictDoUpdate({
        target: [householdRecipeRecommendations.householdId, householdRecipeRecommendations.language],
        set: { recommendations, computedAt: new Date() },
      })
  })
}

// A `householdId` the caller supplied is only trustworthy as a cache key
// once we've confirmed they're actually a member — otherwise treat it as
// absent (skip caching) rather than erroring the whole recommendation
// request over what is fundamentally a performance optimization, not a
// data-access parameter.
async function resolveCacheableHouseholdId(
  db: Db,
  accessToken: string,
  userId: string,
  householdId: string | undefined,
): Promise<string | null> {
  if (!householdId) return null
  const member = await assertMembership(db, accessToken, householdId, userId)
  return member ? householdId : null
}

function formatLikedMeal(f: TFeedbackItem): string {
  const signal = f.signal ? ` (${f.signal})` : ''
  return `"${f.mealTitle}"${signal}`
}

function buildUserMessage(body: TRecommendBody): string {
  const { householdProfile: hp, feedbackSummary, candidateMeals, recentMealIds, prepContext } = body
  const priorityStr = hp.priorities.length > 0 ? hp.priorities.join(', ') : 'none'
  const avoidStr = hp.avoidIngredients.length > 0 ? hp.avoidIngredients.join(', ') : 'none'
  const liked = feedbackSummary.filter((f) => f.vote === 'up').map(formatLikedMeal).join(', ') || 'none'
  const disliked = feedbackSummary.filter((f) => f.vote === 'down').map((f) => `"${f.mealTitle}"`).join(', ') || 'none'
  const recent = (recentMealIds?.lastWeek ?? []).join(', ') || 'none'
  const mealList = candidateMeals.map((m) => `${m.id} | ${m.title}`).join('\n')
  const lines = [
    `Household: ${hp.adults} adults, ${hp.children} children. Priorities: ${priorityStr}. Avoid: ${avoidStr}.`,
    '',
    `Liked: ${liked}`,
    `Disliked: ${disliked}`,
    `Eaten last week: ${recent}`,
    '',
  ]
  if (prepContext?.isCookDay) {
    lines.push('Note: The user is selecting a recipe for a batch cook day. Strongly prefer batch-friendly recipes that scale well and reheat easily (soups, stews, meatballs, curries, braises).', '')
  }
  lines.push('Candidates:', mealList)
  return lines.join('\n')
}

function parseAiJson(raw: string) {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
  return JSON.parse(cleaned) as unknown
}

async function generateStructuredJSON(systemPrompt: string, userMessage: string) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured')

  const client = new Anthropic({ apiKey, timeout: 30_000, maxRetries: 0 })
  const message = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001',
    max_tokens: 1800,
    temperature: 0.2,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  })

  const text = message.content.find((b) => b.type === 'text')?.text
  if (!text) throw new Error('Anthropic response did not include text content')
  return text
}

async function handleRecommend(db: Db, accessToken: string, userId: string, body: TRecommendBody, language: AppLanguage) {
  const cacheableHouseholdId = await resolveCacheableHouseholdId(db, accessToken, userId, body.householdId)

  if (cacheableHouseholdId) {
    const cached = await getCachedRecommendations(db, accessToken, cacheableHouseholdId, language)
    if (cached) {
      const validIds = new Set(body.candidateMeals.map((m) => m.id))
      return { body: { recommendations: cached.filter((r) => validIds.has(r.mealId)) }, status: 200 as const }
    }
  }

  if (await isRateLimited(db, userId, 'recipe-recommendations', 30)) return { body: { error: 'RATE_LIMITED' }, status: 429 as const }

  let aiText: string
  try {
    aiText = await generator(systemPrompt(language), buildUserMessage(body))
  } catch (error) {
    console.error('[recommend] AI generation failed', error)
    return { body: { error: 'AI_UNAVAILABLE' }, status: 500 as const }
  }

  let parsed: unknown
  try {
    parsed = parseAiJson(aiText)
  } catch {
    console.error('[recommend] AI returned non-JSON response')
    return { body: { error: 'INVALID_AI_RESPONSE' }, status: 422 as const }
  }

  const validated = RecommendResponseSchema.safeParse(parsed)
  if (!validated.success) {
    console.error('[recommend] AI response failed schema validation', validated.error.issues)
    return { body: { error: 'INVALID_AI_RESPONSE' }, status: 422 as const }
  }

  const validIds = new Set(body.candidateMeals.map((m) => m.id))
  const recommendations = validated.data.recommendations.filter((r) => validIds.has(r.mealId))

  if (cacheableHouseholdId) {
    await saveRecommendationsToCache(db, accessToken, cacheableHouseholdId, language, recommendations)
  }

  return { body: { recommendations }, status: 200 as const }
}

const recommendRoute = createRoute({
  method: 'post',
  path: '/recipes/recommend',
  operationId: 'recommendMeals',
  summary: 'Rank candidate meals for a household',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: RecommendBodySchema } } },
  },
  responses: {
    200: { description: 'Recommended meals', content: { 'application/json': { schema: RecommendResponseSchema } } },
    400: { description: 'Invalid payload' },
    401: { description: 'Missing or invalid session' },
    422: { description: 'AI response did not match schema' },
    429: { description: 'Rate limited' },
    500: { description: 'AI provider unavailable' },
  },
})

export function buildRecipeRecommendationRoutes(db: Db) {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()

  app.use('/recipes/*', requireAuth)

  app.openapi(recommendRoute, async (c) => {
    const user = c.get('user')
    const accessToken = c.get('accessToken')
    const body = c.req.valid('json')
    if (body.householdId) observePremiumGate(await resolveEntitlementForHousehold(db, user.id, body.householdId), 'ai_recommendations')
    const language = languageFromAcceptLanguage(c.req.header('Accept-Language'))
    const result = await handleRecommend(db, accessToken, user.id, body, language)
    return c.json(result.body as never, result.status)
  })

  return app
}

export function buildInternalRecipeRecommendationRoutes(db: Db) {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()

  app.use('/internal/*', requireInternalAuth)

  app.post('/internal/recipes/recommend', async (c) => {
    const user = c.get('user')
    const accessToken = c.get('accessToken')
    const parsed = RecommendBodySchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_PAYLOAD' }, 400)
    // MealPlanner (the caller of this strangle route) doesn't currently
    // forward its own Accept-Language, so this defaults to 'en' — same as
    // before this language fix, no behavior change for the web app.
    const language = languageFromAcceptLanguage(c.req.header('Accept-Language'))
    const result = await handleRecommend(db, accessToken, user.id, parsed.data, language)
    return c.json(result.body, result.status)
  })

  return app
}
