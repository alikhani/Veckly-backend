import Anthropic from '@anthropic-ai/sdk'
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { requireAuth, requireInternalAuth, type AuthedUser } from './auth.js'
import type { Db } from './db.js'
import { isRateLimited } from './rate-limit.js'
import { assertMembership } from './membership.js'
import { resolveEntitlementForHousehold } from './entitlements.js'
import { evaluatePremiumGate } from './premium-gates.js'

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
- If the title is ambiguous, pick the most family-friendly common interpretation
- If existing ingredients or steps are provided in the user message, treat them as fixed constraints: always include them in your output and build the rest of the recipe around them. Do not drop or rename existing items.`

const FillInIngredientSchema = z.object({
  name: z.string().min(1).max(120),
  amount: z.number().min(0.001),
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
  householdId: z.string().uuid().optional(),
  title: z.string().min(1).max(120),
  householdProfile: z.object({
    adults: z.number(),
    children: z.number(),
  }).optional(),
  existingIngredients: z.array(z.object({
    name: z.string().max(120),
    amount: z.string().max(20).optional(),
    unit: z.string().max(20).optional(),
  })).max(50).optional(),
  existingSteps: z.array(z.string().max(1000)).max(30).optional(),
}).openapi('RecipeFillInRequest')

const FillInEnvelopeSchema = z.object({ recipe: FillInResponseSchema }).openapi('RecipeFillInEnvelope')

type TGenerator = (systemPrompt: string, userMessage: string) => Promise<string>

let generator: TGenerator = generateStructuredJSON

export function setRecipeFillInGeneratorForTests(next: TGenerator | null) {
  generator = next ?? generateStructuredJSON
}

function buildUserMessage(title: string, body: z.infer<typeof FillInBodySchema>): string {
  const parts: string[] = [title]

  if (body.householdProfile) {
    parts.push(`\nHousehold context: ${body.householdProfile.adults} adults, ${body.householdProfile.children} children. Adjust complexity accordingly.`)
  }

  if (body.existingIngredients && body.existingIngredients.length > 0) {
    const list = body.existingIngredients
      .map((i) => [i.amount, i.unit, i.name].filter(Boolean).join(' '))
      .join('\n  - ')
    parts.push(`\nExisting ingredients (keep all of these, build the recipe around them):\n  - ${list}`)
  }

  if (body.existingSteps && body.existingSteps.length > 0) {
    const list = body.existingSteps.map((s, i) => `${i + 1}. ${s}`).join('\n  ')
    parts.push(`\nExisting steps (keep these, expand or refine if needed):\n  ${list}`)
  }

  return parts.join('')
}

function parseAiJson(raw: string) {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
  return JSON.parse(cleaned) as unknown
}

async function generateStructuredJSON(systemPrompt: string, userMessage: string) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured')

  const client = new Anthropic({ apiKey, timeout: 25_000, maxRetries: 0 })
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

async function handleFillIn(db: Db, userId: string, body: z.infer<typeof FillInBodySchema>) {
  if (body.title.trim().length === 0 || body.title.trim().length > 120) {
    return { body: { error: 'INVALID_PAYLOAD' }, status: 400 as const }
  }

  if (await isRateLimited(db, userId, 'recipe-fill-in', 10)) return { body: { error: 'RATE_LIMITED' }, status: 429 as const }

  let raw: string
  try {
    raw = await generator(SYSTEM_PROMPT, buildUserMessage(body.title.trim(), body))
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

export function buildRecipeFillInRoutes(db: Db) {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()

  app.use('/recipes/*', requireAuth)

  app.openapi(fillInRoute, async (c) => {
    const user = c.get('user')
    const accessToken = c.get('accessToken')
    const body = c.req.valid('json')
    if (body.householdId) {
      if (!await assertMembership(db, accessToken, body.householdId, user.id)) return c.json({ error: 'NOT_MEMBER' } as never, 404)
      evaluatePremiumGate(await resolveEntitlementForHousehold(db, user.id, body.householdId), 'recipe_ai_fill_in')
    }
    const result = await handleFillIn(db, user.id, body)
    return c.json(result.body as never, result.status)
  })

  return app
}

export function buildInternalRecipeFillInRoutes(db: Db) {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()

  app.use('/internal/*', requireInternalAuth)

  app.post('/internal/recipes/fill-in', async (c) => {
    const user = c.get('user')
    const parsed = FillInBodySchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_PAYLOAD' }, 400)
    const result = await handleFillIn(db, user.id, parsed.data)
    return c.json(result.body, result.status)
  })

  return app
}
