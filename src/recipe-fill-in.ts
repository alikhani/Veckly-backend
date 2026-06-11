import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { requireAuth, requireInternalAuth, type AuthedUser } from './auth.js'

const SYSTEM_PROMPT = `You are a recipe data generator for a family meal planning app.
Your only job is to return a single valid JSON object — no explanation, no markdown, no preamble.

The recipe must be:
- Realistic for a weeknight family dinner (2 adults, 1 young child is the reference household)
- Completable in under 45 minutes unless the dish name implies otherwise
- Written in the same language as the dish title (Swedish title → Swedish recipe, English title → English recipe)
- Child-friendly by default unless the dish name implies otherwise

Return this exact JSON structure:
{
  "title": "<same as input>",
  "prepTimeMinutes": <integer>,
  "difficulty": "easy" | "medium" | "hard",
  "tags": ["child-friendly"?, "quick"?, "vegetarian"?, "batch-friendly"?],
  "cuisine": "italian" | "asian" | "nordic" | "mexican" | "middle-eastern" | "comfort",
  "proteinSource": "chicken" | "beef" | "pork" | "lamb" | "fish" | "seafood" | "vegetarian" | "legumes" | "mixed",
  "mealWeight": "light" | "medium" | "hearty",
  "ingredients": [
    {
      "name": "<ingredient name, lowercase>",
      "amount": <number>,
      "unit": "<g | kg | ml | l | tsp | tbsp | st | dl | krm>",
      "category": "<produce | dairy | protein | pantry | frozen | other>"
    }
  ],
  "steps": [
    "<step as a complete, actionable sentence>"
  ],
  "notes": "<optional one-sentence family tip, omit key if nothing useful>"
}

cuisine: pick the closest style match. proteinSource: the main protein (use "legumes" for bean/lentil dishes, "vegetarian" if no notable protein beyond dairy/eggs). mealWeight: "light" = soups/salads/simple dishes, "hearty" = stews/roasts/heavy pasta, "medium" = everything in between.

Rules:
- 4–8 ingredients target range
- 3–6 steps maximum
- amount must be a number, never a string
- steps must be actionable ("Fry the onion in butter over medium heat for 3 minutes", not "Cook the onion")
- If the title is ambiguous, pick the most family-friendly common interpretation`

const FillInIngredientSchema = z.object({
  name: z.string().min(1).max(120),
  amount: z.number().positive(),
  unit: z.string().min(1).max(20),
  category: z.enum(['produce', 'dairy', 'protein', 'pantry', 'frozen', 'other']).optional(),
}).openapi('RecipeFillInIngredient')

const FillInResponseSchema = z.object({
  title: z.string().min(1).max(120),
  prepTimeMinutes: z.number().int().min(1).max(600),
  difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
  tags: z.array(z.string().max(30)).max(20).optional(),
  cuisine: z.enum(['italian', 'asian', 'nordic', 'mexican', 'middle-eastern', 'comfort']).optional(),
  proteinSource: z
    .enum(['chicken', 'beef', 'pork', 'lamb', 'fish', 'seafood', 'vegetarian', 'legumes', 'mixed'])
    .optional(),
  mealWeight: z.enum(['light', 'medium', 'hearty']).optional(),
  ingredients: z.array(FillInIngredientSchema).min(1).max(100),
  steps: z.array(z.string().min(1).max(2000)).min(1).max(100),
  notes: z.string().max(500).optional(),
}).openapi('RecipeFillInResult')

const FillInBodySchema = z.object({
  title: z.string().min(1).max(120),
  householdProfile: z.object({
    adults: z.number(),
    children: z.number(),
  }).optional(),
}).openapi('RecipeFillInRequest')

const FillInEnvelopeSchema = z.object({ recipe: FillInResponseSchema }).openapi('RecipeFillInEnvelope')

type TGenerator = (systemPrompt: string, userMessage: string) => Promise<string>

const rateLimitHits = new Map<string, number>()
let generator: TGenerator = generateStructuredJSON

export function setRecipeFillInGeneratorForTests(next: TGenerator | null) {
  generator = next ?? generateStructuredJSON
  rateLimitHits.clear()
}

function isRateLimited(userId: string, now = Date.now()) {
  const previous = rateLimitHits.get(userId)
  if (previous !== undefined && now - previous < 10_000) return true
  rateLimitHits.set(userId, now)
  return false
}

function buildUserMessage(title: string, profile: { adults: number; children: number } | undefined): string {
  if (!profile) return title
  return `${title}\n\nHousehold context: ${profile.adults} adults, ${profile.children} children. Adjust complexity accordingly.`
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

  if (!response.ok) throw new Error(`Anthropic request failed: HTTP ${response.status}`)
  const body = await response.json() as { content?: Array<{ type: string; text?: string }> }
  const text = body.content?.find((part) => part.type === 'text')?.text
  if (!text) throw new Error('Anthropic response did not include text content')
  return text
}

async function handleFillIn(userId: string, body: z.infer<typeof FillInBodySchema>) {
  if (body.title.trim().length === 0 || body.title.trim().length > 120) {
    return { body: { error: 'INVALID_PAYLOAD' }, status: 400 as const }
  }

  if (isRateLimited(userId)) return { body: { error: 'RATE_LIMITED' }, status: 429 as const }

  let raw: string
  try {
    raw = await generator(SYSTEM_PROMPT, buildUserMessage(body.title.trim(), body.householdProfile))
  } catch (error) {
    console.error('[fill-in] AI generation failed', error)
    return { body: { error: 'AI_UNAVAILABLE' }, status: 500 as const }
  }

  let parsed: unknown
  try {
    parsed = parseAiJson(raw)
  } catch {
    console.error('[fill-in] AI returned non-JSON response')
    return { body: { error: 'INVALID_AI_RESPONSE' }, status: 422 as const }
  }

  const validated = FillInResponseSchema.safeParse(parsed)
  if (!validated.success) {
    console.error('[fill-in] AI response failed schema validation', validated.error.issues)
    return { body: { error: 'INVALID_AI_RESPONSE' }, status: 422 as const }
  }

  return { body: { recipe: validated.data }, status: 200 as const }
}

const fillInRoute = createRoute({
  method: 'post',
  path: '/recipes/fill-in',
  operationId: 'fillInRecipe',
  summary: 'Generate recipe details from a title',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: FillInBodySchema } } },
  },
  responses: {
    200: { description: 'Generated recipe details', content: { 'application/json': { schema: FillInEnvelopeSchema } } },
    400: { description: 'Invalid payload' },
    401: { description: 'Missing or invalid session' },
    422: { description: 'AI response did not match the recipe schema' },
    429: { description: 'Rate limited' },
    500: { description: 'AI provider unavailable' },
  },
})

export function buildRecipeFillInRoutes() {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()

  app.use('/recipes/*', requireAuth)

  app.openapi(fillInRoute, async (c) => {
    const user = c.get('user')
    const body = c.req.valid('json')
    const result = await handleFillIn(user.id, body)
    return c.json(result.body as never, result.status)
  })

  return app
}

export function buildInternalRecipeFillInRoutes() {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()

  app.use('/internal/*', requireInternalAuth)

  app.post('/internal/recipes/fill-in', async (c) => {
    const user = c.get('user')
    const parsed = FillInBodySchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_PAYLOAD' }, 400)
    const result = await handleFillIn(user.id, parsed.data)
    return c.json(result.body, result.status)
  })

  return app
}
