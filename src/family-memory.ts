import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, eq, gte, inArray } from 'drizzle-orm'
import { requireAuth, type AuthedUser } from './auth.js'
import { assertMembership } from './membership.js'
import { cookedRecipeIdFromOutcome, resolveMealHistory } from './meal-history.js'
import { withRls } from './rls.js'
import { householdMealOutcomes, mealFeedback, recipes, weekPlanProjections } from './schema.js'
import { addDays, isMonday } from './shared/week-dates.js'
import type { Db } from './db.js'

const HouseholdParamsSchema = z.object({ householdId: z.string().uuid() })
const WeekStartDateQuerySchema = z.object({ weekStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })

// Both queries below read a household's entire week-plan history with no
// other bound — harmless today, but it grows forever with a household's
// age. Capped to a generous 3-year lookback (no real household is anywhere
// near this yet) so it can never become truly unbounded.
const HISTORY_LOOKBACK_WEEKS = 156

const FamilyRecapSchema = z.object({
  plannedWeekCount: z.number().int(),
  topRecipeThisMonth: z.object({ title: z.string(), count: z.number().int() }).nullable(),
  // Additive during the AVL-003 client transition. Returned on every response,
  // optional in OpenAPI so an older generated client stays source-compatible.
  cookedDinnerCountThisMonth: z.number().int().optional(),
  legacyPlannedDinnerCountThisMonth: z.number().int().optional(),
}).openapi('FamilyRecap')

type TProjectionMealsState = { meals?: Record<string, { recipeRef: string }> }

function mealIdsFromState(state: unknown): string[] {
  const candidate = state as TProjectionMealsState | null | undefined
  return Object.values(candidate?.meals ?? {}).map((meal) => meal.recipeRef)
}

// D5 (Sunday recap): a lightweight, presentation-only summary of the
// household's planning history — never used for scoring/generation. Ported
// pure function, `referenceMonth` injected as `YYYY-MM` rather than read
// from `Date.now()` so it stays unit-testable without mocking the clock.
export async function getFamilyRecap(db: Db, accessToken: string, householdId: string, referenceMonth: string) {
  return withRls(db, accessToken, async (tx) => {
    // `plannedWeekCount` undercounts once a household passes the lookback
    // window — an accepted tradeoff given how generous it is; revisit if
    // real households ever get that old.
    const historyCutoff = addDays(`${referenceMonth}-01`, -7 * HISTORY_LOOKBACK_WEEKS)
    const [rows, outcomeRows] = await Promise.all([
      tx
        .select({ weekStartDate: weekPlanProjections.weekStartDate, state: weekPlanProjections.state })
        .from(weekPlanProjections)
        .where(and(eq(weekPlanProjections.householdId, householdId), gte(weekPlanProjections.weekStartDate, historyCutoff))),
      tx
        .select({
          weekStartDate: householdMealOutcomes.weekStartDate,
          date: householdMealOutcomes.date,
          plannedRecipeId: householdMealOutcomes.plannedRecipeId,
          status: householdMealOutcomes.status,
          actualRecipeId: householdMealOutcomes.actualRecipeId,
        })
        .from(householdMealOutcomes)
        .where(and(eq(householdMealOutcomes.householdId, householdId), gte(householdMealOutcomes.weekStartDate, historyCutoff))),
    ])

    const plannedWeeks = rows.filter((row) => mealIdsFromState(row.state).length > 0)
    const plannedWeekCount = plannedWeeks.length

    const mealIdCounts = new Map<string, number>()
    let cookedDinnerCountThisMonth = 0
    for (const outcome of outcomeRows) {
      if (!outcome.date.startsWith(referenceMonth)) continue
      const recipeId = cookedRecipeIdFromOutcome(outcome)
      if (!recipeId) continue
      cookedDinnerCountThisMonth++
      mealIdCounts.set(recipeId, (mealIdCounts.get(recipeId) ?? 0) + 1)
    }

    const outcomeWeeks = new Set(outcomeRows.map((outcome) => outcome.weekStartDate))
    const legacyPlannedDinnerCountThisMonth = plannedWeeks
      .filter((week) => week.weekStartDate.startsWith(referenceMonth) && !outcomeWeeks.has(week.weekStartDate))
      .reduce((count, week) => count + mealIdsFromState(week.state).length, 0)

    let topRecipeId: string | null = null
    let topCount = 0
    for (const [recipeId, count] of mealIdCounts) {
      if (count > topCount) {
        topRecipeId = recipeId
        topCount = count
      }
    }

    let topRecipeThisMonth: { title: string; count: number } | null = null
    if (topRecipeId) {
      const [recipe] = await tx.select({ title: recipes.title }).from(recipes).where(eq(recipes.id, topRecipeId)).limit(1)
      if (recipe) topRecipeThisMonth = { title: recipe.title, count: topCount }
    }

    return {
      plannedWeekCount,
      topRecipeThisMonth,
      cookedDinnerCountThisMonth,
      legacyPlannedDinnerCountThisMonth,
    }
  })
}

const FamilyCookbookRecipeSchema = z.object({
  recipeId: z.string().uuid(),
  title: z.string(),
  timesCooked: z.number().int(),
  weeksSinceCooked: z.number().int().nullable(),
  legacyTimesPlanned: z.number().int().optional(),
  weeksSinceLegacyPlanned: z.number().int().nullable().optional(),
  historyBasis: z.enum(['confirmed_outcomes', 'mixed', 'legacy_plans', 'none']).optional(),
}).openapi('FamilyCookbookRecipe')

const FamilyCookbookSchema = z.object({
  totalFamilyLikedCount: z.number().int(),
  favorites: z.array(FamilyCookbookRecipeSchema),
  dueAgain: z.array(FamilyCookbookRecipeSchema),
}).openapi('FamilyCookbook')

// A liked recipe hasn't been cooked "in a while" past this many weeks —
// mirrors the plan doc's "not eaten in 6 weeks" framing (Plan D3).
const DUE_AGAIN_THRESHOLD_WEEKS = 6
const cookbookTitleCollator = new Intl.Collator('sv', { sensitivity: 'base' })

// Clamped to 0 rather than allowed to go negative — `currentWeekStartDate`
// is client-supplied and only validated as *a* Monday, not as being on or
// after the household's latest history, so a stale/misbehaving client could
// otherwise produce a negative "weeks since cooked".
function weeksBetween(earlierWeekStart: string, laterWeekStart: string): number {
  const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000
  const diff = new Date(`${laterWeekStart}T00:00:00Z`).getTime() - new Date(`${earlierWeekStart}T00:00:00Z`).getTime()
  return Math.max(0, Math.round(diff / MS_PER_WEEK))
}

type TRecipeHistoryStats = {
  countById: Map<string, number>
  lastWeekById: Map<string, string>
}

function computeRecipeStats(
  records: Array<{ weekStartDate: string; mealIds: string[] }>,
  likedRecipeIds: Set<string>,
): TRecipeHistoryStats {
  const countById = new Map<string, number>()
  const lastWeekById = new Map<string, string>()
  for (const week of records) {
    for (const recipeId of week.mealIds) {
      if (!likedRecipeIds.has(recipeId)) continue
      countById.set(recipeId, (countById.get(recipeId) ?? 0) + 1)
      const currentLast = lastWeekById.get(recipeId)
      if (!currentLast || week.weekStartDate > currentLast) lastWeekById.set(recipeId, week.weekStartDate)
    }
  }
  return { countById, lastWeekById }
}

function buildCookbookEntries(
  likedRecipeIds: string[],
  titleById: Map<string, string>,
  confirmedStats: TRecipeHistoryStats,
  legacyStats: TRecipeHistoryStats,
  currentWeekStartDate: string,
) {
  const favorites: z.infer<typeof FamilyCookbookRecipeSchema>[] = []
  const dueAgain: z.infer<typeof FamilyCookbookRecipeSchema>[] = []
  for (const recipeId of likedRecipeIds) {
    const title = titleById.get(recipeId)
    if (!title) continue // recipe deleted since it was cooked/liked
    const lastCookedWeek = confirmedStats.lastWeekById.get(recipeId)
    const lastLegacyPlannedWeek = legacyStats.lastWeekById.get(recipeId)
    const weeksSinceCooked = lastCookedWeek ? weeksBetween(lastCookedWeek, currentWeekStartDate) : null
    const weeksSinceLegacyPlanned = lastLegacyPlannedWeek ? weeksBetween(lastLegacyPlannedWeek, currentWeekStartDate) : null
    const timesCooked = confirmedStats.countById.get(recipeId) ?? 0
    const legacyTimesPlanned = legacyStats.countById.get(recipeId) ?? 0
    const historyBasis = timesCooked > 0
      ? legacyTimesPlanned > 0 ? 'mixed' as const : 'confirmed_outcomes' as const
      : legacyTimesPlanned > 0 ? 'legacy_plans' as const : 'none' as const
    const entry = {
      recipeId,
      title,
      timesCooked,
      weeksSinceCooked,
      legacyTimesPlanned,
      weeksSinceLegacyPlanned,
      historyBasis,
    }
    // "Due again" is an eating claim, so legacy planning history can never
    // trigger it. Legacy-only favorites stay in the neutral list and expose
    // their plan provenance for compatible clients to phrase carefully.
    if (weeksSinceCooked !== null && weeksSinceCooked >= DUE_AGAIN_THRESHOLD_WEEKS) dueAgain.push(entry)
    else favorites.push(entry)
  }
  const compareByTitle = (a: z.infer<typeof FamilyCookbookRecipeSchema>, b: z.infer<typeof FamilyCookbookRecipeSchema>) =>
    cookbookTitleCollator.compare(a.title, b.title) || a.title.localeCompare(b.title) || a.recipeId.localeCompare(b.recipeId)
  favorites.sort((a, b) => b.timesCooked - a.timesCooked || (b.legacyTimesPlanned ?? 0) - (a.legacyTimesPlanned ?? 0) || compareByTitle(a, b))
  dueAgain.sort((a, b) => {
    const aWeeks = a.weeksSinceCooked ?? 0
    const bWeeks = b.weeksSinceCooked ?? 0
    return bWeeks - aWeeks || compareByTitle(a, b)
  })
  return { favorites, dueAgain }
}

// D3 ("Er familj"-panel): frames feedback + planning history as a growing
// family cookbook — all favorites the caller likes (including recipes not
// yet cooked), and a gentle "time again?" nudge for liked recipes that have
// gone quiet. Feedback is
// read per-user, matching every other consumer of `meal_feedback`
// (`doGenerateWeekPlan`, the retro) — RLS enforces `user_id = auth.uid()`
// even on SELECT (see migration 0020), so a household member's votes are
// never visible to their partner. "Family" here means the signed-in family
// member's memory, not a household-wide aggregate. Deliberately excludes
// fork-lineage ("Er version av Köttbullar") — no fork/lineage columns exist
// in the schema yet, see the plan doc's A3 section for the same gap on the
// generation side.
export async function getFamilyCookbook(db: Db, accessToken: string, userId: string, householdId: string, currentWeekStartDate: string) {
  return withRls(db, accessToken, async (tx) => {
    const historyCutoff = addDays(currentWeekStartDate, -7 * HISTORY_LOOKBACK_WEEKS)
    const [feedbackRows, historyRows, outcomeRows] = await Promise.all([
      tx.select({ mealId: mealFeedback.mealId, vote: mealFeedback.vote })
        .from(mealFeedback)
        .where(and(eq(mealFeedback.householdId, householdId), eq(mealFeedback.userId, userId))),
      tx.select({ weekStartDate: weekPlanProjections.weekStartDate, state: weekPlanProjections.state })
        .from(weekPlanProjections)
        .where(and(eq(weekPlanProjections.householdId, householdId), gte(weekPlanProjections.weekStartDate, historyCutoff))),
      tx.select({
        weekStartDate: householdMealOutcomes.weekStartDate,
        plannedRecipeId: householdMealOutcomes.plannedRecipeId,
        status: householdMealOutcomes.status,
        actualRecipeId: householdMealOutcomes.actualRecipeId,
      })
        .from(householdMealOutcomes)
        .where(and(eq(householdMealOutcomes.householdId, householdId), gte(householdMealOutcomes.weekStartDate, historyCutoff))),
    ])

    const likedRecipeIds = new Set(feedbackRows.filter((row) => row.vote === 'up').map((row) => row.mealId))
    if (likedRecipeIds.size === 0) return { totalFamilyLikedCount: 0, favorites: [], dueAgain: [] }

    const resolvedHistory = resolveMealHistory(
      historyRows.map((week) => ({ weekStartDate: week.weekStartDate, mealIds: mealIdsFromState(week.state) })),
      outcomeRows,
    )
    const confirmedStats = computeRecipeStats(resolvedHistory.confirmedRecords, likedRecipeIds)
    const legacyStats = computeRecipeStats(resolvedHistory.legacyPlannedRecords, likedRecipeIds)

    const recipeRows = await tx.select({ id: recipes.id, title: recipes.title }).from(recipes).where(inArray(recipes.id, Array.from(likedRecipeIds)))
    const titleById = new Map(recipeRows.map((recipe) => [recipe.id, recipe.title]))
    // Count only recipes that can actually be rendered. Feedback may outlive
    // a deleted recipe, and the headline must agree with the returned list.
    const totalFamilyLikedCount = recipeRows.length

    const { favorites, dueAgain } = buildCookbookEntries(
      Array.from(likedRecipeIds),
      titleById,
      confirmedStats,
      legacyStats,
      currentWeekStartDate,
    )

    return { totalFamilyLikedCount, favorites, dueAgain }
  })
}

const getFamilyCookbookRoute = createRoute({
  method: 'get',
  path: '/households/{householdId}/family-cookbook',
  operationId: 'getFamilyCookbook',
  summary: "The household's liked recipes, framed as a growing family cookbook",
  security: [{ bearerAuth: [] }],
  request: { params: HouseholdParamsSchema, query: WeekStartDateQuerySchema },
  responses: {
    200: {
      description: 'Household favorites and recipes due for a repeat',
      content: { 'application/json': { schema: FamilyCookbookSchema } },
    },
    400: { description: 'weekStartDate must be a Monday' },
    404: { description: 'Household not found or caller is not a member' },
    401: { description: 'Missing or invalid session' },
  },
})

const getFamilyRecapRoute = createRoute({
  method: 'get',
  path: '/households/{householdId}/recap',
  operationId: 'getFamilyRecap',
  summary: "A lightweight summary of the household's planning history (Sunday retro)",
  security: [{ bearerAuth: [] }],
  request: { params: HouseholdParamsSchema },
  responses: {
    200: {
      description: 'Planned-week count and the most-cooked recipe this calendar month',
      content: { 'application/json': { schema: FamilyRecapSchema } },
    },
    404: { description: 'Household not found or caller is not a member' },
    401: { description: 'Missing or invalid session' },
  },
})

export function buildFamilyMemoryRoutes(db: Db) {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()

  app.use('/households/*', requireAuth)

  app.openapi(getFamilyRecapRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId } = c.req.valid('param')
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' }, 404)
    const referenceMonth = new Date().toISOString().slice(0, 7)
    const recap = await getFamilyRecap(db, accessToken, householdId, referenceMonth)
    return c.json(recap, 200)
  })

  app.openapi(getFamilyCookbookRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId } = c.req.valid('param')
    const { weekStartDate } = c.req.valid('query')
    if (!isMonday(weekStartDate)) return c.json({ error: 'INVALID_WEEK_START_DATE' } as never, 400)
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' }, 404)
    const cookbook = await getFamilyCookbook(db, accessToken, user.id, householdId, weekStartDate)
    return c.json(cookbook, 200)
  })

  return app
}
