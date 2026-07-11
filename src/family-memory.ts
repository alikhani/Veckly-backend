import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { eq } from 'drizzle-orm'
import { requireAuth, type AuthedUser } from './auth.js'
import { assertMembership } from './membership.js'
import { withRls } from './rls.js'
import { recipes, weekPlanProjections } from './schema.js'
import type { Db } from './db.js'

const HouseholdParamsSchema = z.object({ householdId: z.string().uuid() })

const FamilyRecapSchema = z.object({
  plannedWeekCount: z.number().int(),
  topRecipeThisMonth: z.object({ title: z.string(), count: z.number().int() }).nullable(),
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
    const rows = await tx
      .select({ weekStartDate: weekPlanProjections.weekStartDate, state: weekPlanProjections.state })
      .from(weekPlanProjections)
      .where(eq(weekPlanProjections.householdId, householdId))

    const plannedWeeks = rows.filter((row) => mealIdsFromState(row.state).length > 0)
    const plannedWeekCount = plannedWeeks.length

    const mealIdCounts = new Map<string, number>()
    for (const week of plannedWeeks) {
      if (!week.weekStartDate.startsWith(referenceMonth)) continue
      for (const recipeId of mealIdsFromState(week.state)) {
        mealIdCounts.set(recipeId, (mealIdCounts.get(recipeId) ?? 0) + 1)
      }
    }

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

    return { plannedWeekCount, topRecipeThisMonth }
  })
}

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

  return app
}
