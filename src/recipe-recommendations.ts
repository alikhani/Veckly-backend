import Anthropic from '@anthropic-ai/sdk'
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { createHash } from 'node:crypto'
import { and, eq, gte, lt } from 'drizzle-orm'
import { requireAuth, requireInternalAuth, type AuthedUser } from './auth.js'
import { languageFromAcceptLanguage, type AppLanguage } from './locale.js'
import { assertMembership } from './membership.js'
import { isRateLimited } from './rate-limit.js'
import { withRls } from './rls.js'
import {
  householdActiveWeeks,
  householdMealOutcomes,
  householdMealSignals,
  householdRecipeRecommendations,
  mealFeedback,
} from './schema.js'
import { resolveEntitlementForHousehold } from './entitlements.js'
import { observePremiumGate, PremiumRequiredResponseSchema } from './premium-gates.js'
import { addDays, recipeMatchesAvoided } from './week-plan.js'
import { cookedRecipeIdFromOutcome } from './meal-history.js'
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

const CandidateMealSchema = z.object({
  id: z.string(),
  title: z.string(),
  tags: z.array(z.string()).optional(),
  ingredients: z.array(z.string()).optional(),
  prepTimeMinutes: z.number().int().nonnegative().nullable().optional(),
  cookTimeMinutes: z.number().int().nonnegative().nullable().optional(),
  cuisine: z.string().nullable().optional(),
  proteinSource: z.string().nullable().optional(),
  mealWeight: z.string().nullable().optional(),
})

const SwapIntentSchema = z.enum(['any', 'quicker', 'childFriendly', 'simplerShopping', 'moreVariation', 'sameFeel'])

const RecommendBodyFields = {
  householdProfile: z.object({
    adults: z.number(),
    children: z.number(),
    priorities: z.array(z.string()),
    avoidIngredients: z.array(z.string()),
  }),
  feedbackSummary: z.array(FeedbackItemSchema),
  candidateMeals: z.array(CandidateMealSchema).min(1).max(200),
  recentMealIds: z.object({
    lastWeek: z.array(z.string()),
    twoWeeksAgo: z.array(z.string()),
  }).optional(),
  prepContext: z.object({
    isCookDay: z.boolean(),
    leftoversDesired: z.boolean().optional(),
  }).optional(),
  swapContext: z.object({
    intent: SwapIntentSchema,
    currentMealId: z.string().optional(),
  }).optional(),
  referenceWeekStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}

const RecommendBodySchema = z.object({
  // Optional only for the MealPlanner strangle route, which does not send it yet.
  householdId: z.string().uuid().optional(),
  ...RecommendBodyFields,
})

const PublicRecommendBodySchema = z.object({
  householdId: z.string().uuid(),
  ...RecommendBodyFields,
}).openapi('MealRecommendationsRequest')

type TRecommendBody = z.infer<typeof RecommendBodySchema>
type TFeedbackItem = z.infer<typeof FeedbackItemSchema>
type TCandidateMeal = z.infer<typeof CandidateMealSchema>
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
- Ground each reason in supplied facts such as time, tags, family signals, leftovers, or cuisine; never invent a property
- 8 to 12 recommendations total
- Do not include meals with explicit negative feedback unless no better option exists`
}

const RECOMMENDATION_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const RECOMMENDATION_CACHE_VERSION = 2
const MAX_PROMPT_CANDIDATES = 60
const MAX_PROMPT_TAGS = 12
const MAX_PROMPT_INGREDIENTS = 16
const MAX_PROMPT_TEXT_LENGTH = 80

type TCachedRecommendation = { mealId: string; reason: string }
type TCachedRecommendationPayload = {
  version: number
  fingerprint: string
  recommendations: TCachedRecommendation[]
}

type TServerRecommendationContext = {
  feedbackSummary: TFeedbackItem[]
  householdSignals: Record<string, 'works_for_family' | 'not_for_us'>
  outcomeSignals: Array<{
    mealId: string
    reason: string | null
    portionOutcome: string | null
  }>
  recentMealIds: { lastWeek: string[]; twoWeeksAgo: string[] }
}

async function getCachedRecommendations(
  db: Db,
  accessToken: string,
  householdId: string,
  language: AppLanguage,
  fingerprint: string,
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
    const payload = row.recommendations as Partial<TCachedRecommendationPayload>
    // Cache v1 stored a bare array. It cannot prove which prep/swap context or
    // candidate metadata produced it, so it is deliberately a miss.
    if (
      payload.version !== RECOMMENDATION_CACHE_VERSION
      || payload.fingerprint !== fingerprint
      || !Array.isArray(payload.recommendations)
    ) return null
    return payload.recommendations
  })
}

async function saveRecommendationsToCache(
  db: Db,
  accessToken: string,
  householdId: string,
  language: AppLanguage,
  fingerprint: string,
  recommendations: TCachedRecommendation[],
) {
  const payload: TCachedRecommendationPayload = {
    version: RECOMMENDATION_CACHE_VERSION,
    fingerprint,
    recommendations,
  }
  await withRls(db, accessToken, async (tx) => {
    await tx
      .insert(householdRecipeRecommendations)
      .values({ householdId, language, recommendations: payload, computedAt: new Date() })
      .onConflictDoUpdate({
        target: [householdRecipeRecommendations.householdId, householdRecipeRecommendations.language],
        set: { recommendations: payload, computedAt: new Date() },
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

function currentUtcWeekStart(): string {
  const now = new Date()
  const day = now.getUTCDay()
  const mondayOffset = day === 0 ? -6 : 1 - day
  now.setUTCDate(now.getUTCDate() + mondayOffset)
  return now.toISOString().slice(0, 10)
}

async function loadServerRecommendationContext(
  db: Db,
  accessToken: string,
  userId: string,
  householdId: string,
  requestedWeekStartDate: string | undefined,
  candidates: TCandidateMeal[],
): Promise<TServerRecommendationContext> {
  return withRls(db, accessToken, async (tx) => {
    const [[activeWeek], feedbackRows, signalRows] = await Promise.all([
      tx.select({ weekStartDate: householdActiveWeeks.weekStartDate })
        .from(householdActiveWeeks)
        .where(eq(householdActiveWeeks.householdId, householdId))
        .limit(1),
      tx.select({ mealId: mealFeedback.mealId, vote: mealFeedback.vote, signal: mealFeedback.signal })
        .from(mealFeedback)
        .where(and(eq(mealFeedback.householdId, householdId), eq(mealFeedback.userId, userId))),
      tx.select({ mealId: householdMealSignals.mealId, signal: householdMealSignals.signal })
        .from(householdMealSignals)
        .where(eq(householdMealSignals.householdId, householdId)),
    ])

    const referenceWeekStartDate = requestedWeekStartDate ?? activeWeek?.weekStartDate ?? currentUtcWeekStart()
    const lastWeekStartDate = addDays(referenceWeekStartDate, -7)
    const twoWeeksAgoStartDate = addDays(referenceWeekStartDate, -14)
    const outcomeSignalCutoff = addDays(referenceWeekStartDate, -56)
    const outcomeRows = await tx.select({
      weekStartDate: householdMealOutcomes.weekStartDate,
      plannedRecipeId: householdMealOutcomes.plannedRecipeId,
      status: householdMealOutcomes.status,
      actualRecipeId: householdMealOutcomes.actualRecipeId,
      reason: householdMealOutcomes.reason,
      portionOutcome: householdMealOutcomes.portionOutcome,
    })
      .from(householdMealOutcomes)
      .where(and(
        eq(householdMealOutcomes.householdId, householdId),
        gte(householdMealOutcomes.weekStartDate, outcomeSignalCutoff),
        lt(householdMealOutcomes.weekStartDate, referenceWeekStartDate),
      ))

    const titlesById = new Map(candidates.map((candidate) => [candidate.id, candidate.title]))
    const feedbackSummary = feedbackRows.map((row) => ({
      mealId: row.mealId,
      mealTitle: titlesById.get(row.mealId) ?? row.mealId,
      vote: row.vote,
      ...(row.signal ? { signal: row.signal } : {}),
    })).sort((left, right) => left.mealId.localeCompare(right.mealId))
    const recentMealIds = { lastWeek: [] as string[], twoWeeksAgo: [] as string[] }
    const outcomeSignals: TServerRecommendationContext['outcomeSignals'] = []
    for (const outcome of outcomeRows) {
      const mealId = cookedRecipeIdFromOutcome(outcome)
      if (!mealId) continue
      if (outcome.weekStartDate === lastWeekStartDate) recentMealIds.lastWeek.push(mealId)
      else if (outcome.weekStartDate === twoWeeksAgoStartDate) recentMealIds.twoWeeksAgo.push(mealId)
      if (outcome.reason || outcome.portionOutcome) {
        outcomeSignals.push({ mealId, reason: outcome.reason, portionOutcome: outcome.portionOutcome })
      }
    }
    recentMealIds.lastWeek.sort()
    recentMealIds.twoWeeksAgo.sort()
    outcomeSignals.sort((left, right) => left.mealId.localeCompare(right.mealId)
      || (left.reason ?? '').localeCompare(right.reason ?? '')
      || (left.portionOutcome ?? '').localeCompare(right.portionOutcome ?? ''))

    return {
      feedbackSummary,
      householdSignals: Object.fromEntries(signalRows.sort((left, right) => left.mealId.localeCompare(right.mealId)).map((row) => [row.mealId, row.signal])),
      outcomeSignals,
      recentMealIds,
    }
  })
}

function normalizedPromptText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, MAX_PROMPT_TEXT_LENGTH)
}

function candidatePromptLine(candidate: TCandidateMeal): string {
  const tags = (candidate.tags ?? []).slice(0, MAX_PROMPT_TAGS).map(normalizedPromptText)
  const tagKeys = new Set(tags.map((tag) => tag.toLocaleLowerCase('en')))
  const ingredients = (candidate.ingredients ?? []).slice(0, MAX_PROMPT_INGREDIENTS).map((item) => normalizedPromptText(item).toLocaleLowerCase('en'))
  const totalMinutes = (candidate.prepTimeMinutes ?? 0) + (candidate.cookTimeMinutes ?? 0)
  const metadata = [
    totalMinutes > 0 ? `time=${totalMinutes}m` : null,
    tags.length > 0 ? `tags=${tags.join(',')}` : null,
    candidate.proteinSource ? `protein=${normalizedPromptText(candidate.proteinSource)}` : null,
    candidate.cuisine ? `cuisine=${normalizedPromptText(candidate.cuisine)}` : null,
    candidate.mealWeight ? `weight=${normalizedPromptText(candidate.mealWeight)}` : null,
    tagKeys.has('leftovers') ? 'leftovers=yes' : null,
    tagKeys.has('meal-prep') ? 'mealPrep=yes' : null,
    ingredients.length > 0 ? `ingredients=${ingredients.join(',')}` : null,
  ].filter((value): value is string => Boolean(value))
  return `${candidate.id} | ${normalizedPromptText(candidate.title)}${metadata.length > 0 ? ` | ${metadata.join(' | ')}` : ''}`
}

function formatLikedMeal(f: TFeedbackItem): string {
  const signal = f.signal ? ` (${f.signal})` : ''
  return `"${f.mealTitle}"${signal}`
}

function buildUserMessage(body: TRecommendBody, serverContext?: TServerRecommendationContext): string {
  const { householdProfile: hp, candidateMeals, prepContext, swapContext } = body
  const feedbackSummary = serverContext?.feedbackSummary ?? body.feedbackSummary
  const recentMealIds = serverContext?.recentMealIds ?? body.recentMealIds
  const priorityStr = hp.priorities.length > 0 ? hp.priorities.join(', ') : 'none'
  const avoidStr = hp.avoidIngredients.length > 0 ? hp.avoidIngredients.join(', ') : 'none'
  const liked = feedbackSummary.filter((f) => f.vote === 'up').map(formatLikedMeal).join(', ') || 'none'
  const disliked = feedbackSummary.filter((f) => f.vote === 'down').map((f) => `"${f.mealTitle}"`).join(', ') || 'none'
  const recentLastWeek = (recentMealIds?.lastWeek ?? []).join(', ') || 'none confirmed'
  const recentTwoWeeksAgo = (recentMealIds?.twoWeeksAgo ?? []).join(', ') || 'none confirmed'
  const householdSignals = Object.entries(serverContext?.householdSignals ?? {})
    .map(([mealId, signal]) => `${mealId}:${signal}`).join(', ') || 'none'
  const outcomeSignals = (serverContext?.outcomeSignals ?? [])
    .map((signal) => `${signal.mealId}:${[signal.reason, signal.portionOutcome].filter(Boolean).join('+')}`)
    .join(', ') || 'none'
  const mealList = candidateMeals.slice(0, MAX_PROMPT_CANDIDATES).map(candidatePromptLine).join('\n')
  const lines = [
    `Household: ${hp.adults} adults, ${hp.children} children. Priorities: ${priorityStr}. Avoid: ${avoidStr}.`,
    '',
    `Personally liked: ${liked}`,
    `Personally disliked: ${disliked}`,
    `Shared household signals: ${householdSignals}`,
    `Confirmed outcome signals: ${outcomeSignals}`,
    `Confirmed cooked last week: ${recentLastWeek}`,
    `Confirmed cooked two weeks ago: ${recentTwoWeeksAgo}`,
    '',
  ]
  if (prepContext?.isCookDay) {
    lines.push('Note: The user is selecting a recipe for a batch cook day. Strongly prefer batch-friendly recipes that scale well and reheat easily (soups, stews, meatballs, curries, braises).', '')
  }
  if (prepContext?.leftoversDesired) {
    lines.push('Note: Leftovers are wanted. Prefer candidates explicitly tagged for leftovers or meal prep.', '')
  }
  if (swapContext) {
    lines.push(`Swap intent: ${swapContext.intent}. Current meal: ${swapContext.currentMealId ?? 'not specified'}.`, '')
  }
  lines.push('Candidates:', mealList)
  return lines.join('\n')
}

function parseAiJson(raw: string) {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
  return JSON.parse(cleaned) as unknown
}

function allowedRecommendationIds(body: TRecommendBody) {
  const allowed = new Set<string>()
  for (const candidate of body.candidateMeals) {
    // Older/internal clients only send id + title. Keep those compatible:
    // title-only substring matching would reintroduce false positives such as
    // avoid="ost" excluding "Rostad kyckling". Native clients send both
    // arrays, which lets us apply the same fail-safe matcher as generation.
    if (candidate.tags === undefined || candidate.ingredients === undefined) {
      allowed.add(candidate.id)
      continue
    }
    const recipe = {
      title: candidate.title,
      tags: candidate.tags,
      ingredients: candidate.ingredients.map((item) => ({ item })),
    }
    if (!recipeMatchesAvoided(recipe, body.householdProfile.avoidIngredients)) {
      allowed.add(candidate.id)
    }
  }
  return allowed
}

function normalizedTags(candidate: TCandidateMeal): Set<string> {
  return new Set((candidate.tags ?? []).map((tag) => tag.trim().toLocaleLowerCase('en')))
}

function deterministicCandidateScore(
  candidate: TCandidateMeal,
  body: TRecommendBody,
  context: TServerRecommendationContext | undefined,
): number {
  let score = 0
  const tags = normalizedTags(candidate)
  const feedback = (context?.feedbackSummary ?? body.feedbackSummary).find((item) => item.mealId === candidate.id)
  if (feedback?.vote === 'up') score += 18
  if (feedback?.vote === 'down') score -= 100
  if (context?.householdSignals[candidate.id] === 'works_for_family') score += 15
  if (context?.householdSignals[candidate.id] === 'not_for_us') score -= 100

  for (const outcome of context?.outcomeSignals ?? []) {
    if (outcome.mealId !== candidate.id) continue
    if (['family_approved', 'easy_weeknight', 'good_leftovers'].includes(outcome.reason ?? '')) score += 7
    if (['family_pushback', 'too_much_effort', 'poor_leftovers'].includes(outcome.reason ?? '')) score -= 12
    if (outcome.portionOutcome === 'right_amount') score += 2
  }

  const recent = context?.recentMealIds ?? body.recentMealIds
  if (recent?.lastWeek.includes(candidate.id)) score -= 16
  if (recent?.twoWeeksAgo.includes(candidate.id)) score -= 8

  const totalMinutes = (candidate.prepTimeMinutes ?? 0) + (candidate.cookTimeMinutes ?? 0)
  if (body.householdProfile.priorities.includes('quick') && (totalMinutes > 0 && totalMinutes <= 30 || tags.has('quick'))) score += 6
  if (body.householdProfile.priorities.includes('child-friendly') && [...tags].some((tag) => ['child-friendly', 'kids', 'family'].includes(tag))) score += 6
  if (body.householdProfile.priorities.includes('meal-prep') && (tags.has('meal-prep') || tags.has('leftovers'))) score += 6
  if (body.prepContext?.isCookDay && tags.has('meal-prep')) score += 8
  if (body.prepContext?.leftoversDesired && (tags.has('leftovers') || tags.has('meal-prep'))) score += 8

  switch (body.swapContext?.intent) {
    case 'quicker':
      if (totalMinutes > 0 && totalMinutes <= 30) score += 10
      if (tags.has('quick')) score += 4
      break
    case 'childFriendly':
      if ([...tags].some((tag) => ['child-friendly', 'kids', 'family'].includes(tag))) score += 10
      break
    case 'simplerShopping':
      if ((candidate.ingredients?.length ?? Number.POSITIVE_INFINITY) <= 8) score += 10
      break
    case 'moreVariation':
      if (!(recent?.lastWeek.includes(candidate.id) ?? false) && !(recent?.twoWeeksAgo.includes(candidate.id) ?? false)) score += 6
      break
    case 'sameFeel': {
      const current = body.candidateMeals.find((item) => item.id === body.swapContext?.currentMealId)
      if (current) {
        const currentTags = normalizedTags(current)
        if ([...tags].some((tag) => currentTags.has(tag))) score += 8
        if (candidate.cuisine && candidate.cuisine === current.cuisine) score += 4
      }
      break
    }
    case 'any':
    case undefined:
      break
  }
  return score
}

function deterministicReason(candidate: TCandidateMeal, body: TRecommendBody, context: TServerRecommendationContext | undefined, language: AppLanguage): string {
  const tags = normalizedTags(candidate)
  const totalMinutes = (candidate.prepTimeMinutes ?? 0) + (candidate.cookTimeMinutes ?? 0)
  const householdSignal = context?.householdSignals[candidate.id]
  const feedback = (context?.feedbackSummary ?? body.feedbackSummary).find((item) => item.mealId === candidate.id)
  if (householdSignal === 'works_for_family' || feedback?.vote === 'up') {
    return language === 'sv' ? 'En rätt som familjen redan uppskattar.' : 'A meal your family already enjoys.'
  }
  if (body.prepContext?.leftoversDesired && (tags.has('leftovers') || tags.has('meal-prep'))) {
    return language === 'sv' ? 'Passar bra när ni vill ha rester.' : 'A good fit when you want leftovers.'
  }
  if ((body.swapContext?.intent === 'childFriendly' || body.householdProfile.priorities.includes('child-friendly'))
    && [...tags].some((tag) => ['child-friendly', 'kids', 'family'].includes(tag))) {
    return language === 'sv' ? 'Ett barnvänligt val för hela familjen.' : 'A child-friendly choice for the whole family.'
  }
  if ((body.swapContext?.intent === 'quicker' || body.householdProfile.priorities.includes('quick')) && totalMinutes > 0 && totalMinutes <= 30) {
    return language === 'sv' ? `Klar på cirka ${totalMinutes} minuter.` : `Ready in about ${totalMinutes} minutes.`
  }
  if (candidate.cuisine) {
    return language === 'sv' ? `Ger veckan variation med ${normalizedPromptText(candidate.cuisine)}.` : `Adds ${normalizedPromptText(candidate.cuisine)} variety to the week.`
  }
  return language === 'sv' ? 'Passar era val och veckans plan.' : 'Fits your preferences and this week\'s plan.'
}

function deterministicRecommendations(
  body: TRecommendBody,
  context: TServerRecommendationContext | undefined,
  language: AppLanguage,
): TCachedRecommendation[] {
  const allowedIds = allowedRecommendationIds(body)
  const ranked = body.candidateMeals
    .map((candidate, index) => ({ candidate, index, score: deterministicCandidateScore(candidate, body, context) }))
    .filter(({ candidate }) => allowedIds.has(candidate.id))
    .sort((left, right) => right.score - left.score || left.index - right.index || left.candidate.id.localeCompare(right.candidate.id))
  const withoutExplicitNegatives = ranked.filter(({ score }) => score > -90)
  return (withoutExplicitNegatives.length > 0 ? withoutExplicitNegatives : ranked)
    .slice(0, 12)
    .map(({ candidate }) => ({ mealId: candidate.id, reason: deterministicReason(candidate, body, context, language) }))
}

function recommendationFingerprint(body: TRecommendBody, context: TServerRecommendationContext | undefined): string {
  const fingerprintInput = {
    householdProfile: body.householdProfile,
    candidates: body.candidateMeals,
    prepContext: body.prepContext ?? null,
    swapContext: body.swapContext ?? null,
    referenceWeekStartDate: body.referenceWeekStartDate ?? null,
    feedback: context?.feedbackSummary ?? body.feedbackSummary,
    householdSignals: Object.entries(context?.householdSignals ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    outcomeSignals: context?.outcomeSignals ?? [],
    recentMealIds: context?.recentMealIds ?? body.recentMealIds ?? null,
  }
  return createHash('sha256').update(JSON.stringify(fingerprintInput)).digest('hex')
}

function logRecommendationResult(input: {
  result: 'cache' | 'ai' | 'fallback'
  cacheHit: boolean
  fallbackType?: 'rate_limited' | 'provider_error' | 'invalid_json' | 'invalid_schema' | 'filtered_empty'
  latencyMs: number
  candidateCount: number
}) {
  // Structured operational metadata only. Prompts, free-text reasons,
  // household ids and profile contents are deliberately excluded.
  console.info('[recommend]', input)
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
  const startedAt = Date.now()
  const cacheableHouseholdId = await resolveCacheableHouseholdId(db, accessToken, userId, body.householdId)
  const serverContext = cacheableHouseholdId
    ? await loadServerRecommendationContext(
        db,
        accessToken,
        userId,
        cacheableHouseholdId,
        body.referenceWeekStartDate,
        body.candidateMeals,
      )
    : undefined
  const fingerprint = recommendationFingerprint(body, serverContext)

  if (cacheableHouseholdId) {
    const cached = await getCachedRecommendations(db, accessToken, cacheableHouseholdId, language, fingerprint)
    if (cached) {
      const validIds = allowedRecommendationIds(body)
      logRecommendationResult({
        result: 'cache',
        cacheHit: true,
        latencyMs: Date.now() - startedAt,
        candidateCount: body.candidateMeals.length,
      })
      return { body: { recommendations: cached.filter((r) => validIds.has(r.mealId)) }, status: 200 as const }
    }
  }

  if (await isRateLimited(db, userId, 'recipe-recommendations', 30)) {
    const recommendations = deterministicRecommendations(body, serverContext, language)
    logRecommendationResult({
      result: 'fallback',
      cacheHit: false,
      fallbackType: 'rate_limited',
      latencyMs: Date.now() - startedAt,
      candidateCount: body.candidateMeals.length,
    })
    return { body: { recommendations }, status: 200 as const }
  }

  let aiText: string
  try {
    aiText = await generator(systemPrompt(language), buildUserMessage(body, serverContext))
  } catch {
    const recommendations = deterministicRecommendations(body, serverContext, language)
    logRecommendationResult({
      result: 'fallback',
      cacheHit: false,
      fallbackType: 'provider_error',
      latencyMs: Date.now() - startedAt,
      candidateCount: body.candidateMeals.length,
    })
    return { body: { recommendations }, status: 200 as const }
  }

  let parsed: unknown
  try {
    parsed = parseAiJson(aiText)
  } catch {
    const recommendations = deterministicRecommendations(body, serverContext, language)
    logRecommendationResult({
      result: 'fallback',
      cacheHit: false,
      fallbackType: 'invalid_json',
      latencyMs: Date.now() - startedAt,
      candidateCount: body.candidateMeals.length,
    })
    return { body: { recommendations }, status: 200 as const }
  }

  const validated = RecommendResponseSchema.safeParse(parsed)
  if (!validated.success) {
    const recommendations = deterministicRecommendations(body, serverContext, language)
    logRecommendationResult({
      result: 'fallback',
      cacheHit: false,
      fallbackType: 'invalid_schema',
      latencyMs: Date.now() - startedAt,
      candidateCount: body.candidateMeals.length,
    })
    return { body: { recommendations }, status: 200 as const }
  }

  const validIds = allowedRecommendationIds(body)
  let recommendations = validated.data.recommendations.filter((r) => validIds.has(r.mealId))
  if (recommendations.length === 0) {
    recommendations = deterministicRecommendations(body, serverContext, language)
    logRecommendationResult({
      result: 'fallback',
      cacheHit: false,
      fallbackType: 'filtered_empty',
      latencyMs: Date.now() - startedAt,
      candidateCount: body.candidateMeals.length,
    })
    return { body: { recommendations }, status: 200 as const }
  }

  if (cacheableHouseholdId) {
    await saveRecommendationsToCache(db, accessToken, cacheableHouseholdId, language, fingerprint, recommendations)
  }

  logRecommendationResult({
    result: 'ai',
    cacheHit: false,
    latencyMs: Date.now() - startedAt,
    candidateCount: body.candidateMeals.length,
  })
  return { body: { recommendations }, status: 200 as const }
}

const recommendRoute = createRoute({
  method: 'post',
  path: '/recipes/recommend',
  operationId: 'recommendMeals',
  summary: 'Rank candidate meals for a household',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: PublicRecommendBodySchema } } },
  },
  responses: {
    200: { description: 'Recommended meals', content: { 'application/json': { schema: RecommendResponseSchema } } },
    400: { description: 'Invalid payload' },
    401: { description: 'Missing or invalid session' },
    403: { description: 'Premium is required', content: { 'application/json': { schema: PremiumRequiredResponseSchema } } },
    404: { description: 'Household not found or caller is not a member' },
    422: { description: 'Reserved for request-compatible validation errors; AI validation failures use deterministic fallback' },
    429: { description: 'Reserved for infrastructure throttling; the recommendation AI throttle uses deterministic fallback' },
    500: { description: 'Unexpected server error; AI provider failures use deterministic fallback' },
  },
})

export function buildRecipeRecommendationRoutes(db: Db) {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()

  app.use('/recipes/*', requireAuth)

  app.openapi(recommendRoute, async (c) => {
    const user = c.get('user')
    const accessToken = c.get('accessToken')
    const body = c.req.valid('json')
    if (!await assertMembership(db, accessToken, body.householdId, user.id)) return c.json({ error: 'NOT_MEMBER' } as never, 404)
    const entitlement = await resolveEntitlementForHousehold(db, user.id, body.householdId)
    const gate = await observePremiumGate(db, entitlement, { householdId: body.householdId, userId: user.id, reason: 'ai_recommendations' })
    if (gate) return c.json(gate as never, 403)
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
