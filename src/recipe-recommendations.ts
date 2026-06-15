import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { requireAuth, requireInternalAuth, type AuthedUser } from './auth.js'

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

const recommendationRateLimitHits = new Map<string, number>()
let generator: TGenerator = generateStructuredJSON

export function setRecipeRecommendationGeneratorForTests(next: TGenerator | null) {
  generator = next ?? generateStructuredJSON
  recommendationRateLimitHits.clear()
}

const SYSTEM_PROMPT = `You are a meal recommendation assistant for a family meal planning app.
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
- "reason" must be one concise sentence, max 12 words, in the same language as the meal title
- 8 to 12 recommendations total
- Do not include meals with explicit negative feedback unless no better option exists`

function isRateLimited(userId: string, now = Date.now()) {
  const previous = recommendationRateLimitHits.get(userId)
  if (previous !== undefined && now - previous < 30_000) return true
  recommendationRateLimitHits.set(userId, now)
  return false
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
      temperature: 0.2,
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

async function handleRecommend(userId: string, body: TRecommendBody) {
  if (isRateLimited(userId)) return { body: { error: 'RATE_LIMITED' }, status: 429 as const }

  let aiText: string
  try {
    aiText = await generator(SYSTEM_PROMPT, buildUserMessage(body))
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
  return {
    body: { recommendations: validated.data.recommendations.filter((r) => validIds.has(r.mealId)) },
    status: 200 as const,
  }
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

export function buildRecipeRecommendationRoutes() {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()

  app.use('/recipes/*', requireAuth)

  app.openapi(recommendRoute, async (c) => {
    const user = c.get('user')
    const body = c.req.valid('json')
    const result = await handleRecommend(user.id, body)
    return c.json(result.body as never, result.status)
  })

  return app
}

export function buildInternalRecipeRecommendationRoutes() {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()

  app.use('/internal/*', requireInternalAuth)

  app.post('/internal/recipes/recommend', async (c) => {
    const user = c.get('user')
    const parsed = RecommendBodySchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_PAYLOAD' }, 400)
    const result = await handleRecommend(user.id, parsed.data)
    return c.json(result.body, result.status)
  })

  return app
}
