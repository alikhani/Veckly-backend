import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, desc, eq } from 'drizzle-orm'
import { requireAuth, type AuthedUser } from './auth.js'
import { assertMembership } from './membership.js'
import { RecipeSchema, toRecipeResponse } from './recipes.js'
import { withRls } from './rls.js'
import { householdSavedRecipes, recipes } from './schema.js'
import type { Db } from './db.js'

// The household's shared bookmark list — distinct from a member's personal
// `userSavedRecipes` list (see schema.ts). This is what week generation
// reads as a candidate source (Plan A3a); a personal save never affects
// generation on its own.

const HouseholdParamsSchema = z.object({ householdId: z.string().uuid() })
const HouseholdRecipeParamsSchema = z.object({ householdId: z.string().uuid(), recipeId: z.string().uuid() })
const RecipesEnvelopeSchema = z.object({ recipes: z.array(RecipeSchema) }).openapi('HouseholdSavedRecipesEnvelope')
const OkResponseSchema = z.object({ ok: z.literal(true) }).openapi('OkResponse')

export async function addHouseholdSavedRecipe(db: Db, accessToken: string, userId: string, householdId: string, recipeId: string) {
  return withRls(db, accessToken, async (tx) => {
    const [readableRecipe] = await tx.select({ id: recipes.id }).from(recipes).where(eq(recipes.id, recipeId)).limit(1)
    if (!readableRecipe) return 'not_found' as const

    await tx.insert(householdSavedRecipes).values({ householdId, recipeId, addedBy: userId }).onConflictDoNothing()
    return 'saved' as const
  })
}

// Any active member may remove a household bookmark, not only the member who
// added it (matches the existing precedent that a household recipe is
// editable by any member — see `updateRecipe`, scoped by householdId, not
// createdBy). This never touches the adder's own `userSavedRecipes` row.
export async function removeHouseholdSavedRecipe(db: Db, accessToken: string, householdId: string, recipeId: string) {
  return withRls(db, accessToken, async (tx) => {
    await tx.delete(householdSavedRecipes)
      .where(and(eq(householdSavedRecipes.householdId, householdId), eq(householdSavedRecipes.recipeId, recipeId)))
  })
}

export async function listHouseholdSavedRecipes(db: Db, accessToken: string, householdId: string) {
  return withRls(db, accessToken, async (tx) => {
    const rows = await tx
      .select({ recipe: recipes })
      .from(householdSavedRecipes)
      .innerJoin(recipes, eq(recipes.id, householdSavedRecipes.recipeId))
      .where(and(eq(householdSavedRecipes.householdId, householdId), eq(recipes.isArchived, false)))
      .orderBy(desc(householdSavedRecipes.addedAt))

    return rows.map((row) => toRecipeResponse(row.recipe))
  })
}

const listHouseholdSavedRecipesRoute = createRoute({
  method: 'get',
  path: '/households/{householdId}/saved-recipes',
  operationId: 'listHouseholdSavedRecipes',
  summary: "The household's shared bookmark list",
  security: [{ bearerAuth: [] }],
  request: { params: HouseholdParamsSchema },
  responses: {
    200: { description: 'Household-saved recipes', content: { 'application/json': { schema: RecipesEnvelopeSchema } } },
    404: { description: 'Household not found or caller is not a member' },
    401: { description: 'Missing or invalid session' },
  },
})

const addHouseholdSavedRecipeRoute = createRoute({
  method: 'post',
  path: '/households/{householdId}/saved-recipes/{recipeId}',
  operationId: 'addHouseholdSavedRecipe',
  summary: 'Add a recipe to the household bookmark list',
  security: [{ bearerAuth: [] }],
  request: { params: HouseholdRecipeParamsSchema },
  responses: {
    201: { description: 'Recipe added, or already added', content: { 'application/json': { schema: OkResponseSchema } } },
    404: { description: 'Household not found, caller is not a member, or recipe not found' },
    401: { description: 'Missing or invalid session' },
  },
})

const removeHouseholdSavedRecipeRoute = createRoute({
  method: 'delete',
  path: '/households/{householdId}/saved-recipes/{recipeId}',
  operationId: 'removeHouseholdSavedRecipe',
  summary: 'Remove a recipe from the household bookmark list',
  security: [{ bearerAuth: [] }],
  request: { params: HouseholdRecipeParamsSchema },
  responses: {
    200: { description: 'Recipe removed, or was not on the list', content: { 'application/json': { schema: OkResponseSchema } } },
    404: { description: 'Household not found or caller is not a member' },
    401: { description: 'Missing or invalid session' },
  },
})

export function buildHouseholdSavedRecipesRoutes(db: Db) {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()

  app.use('/households/*', requireAuth)

  app.openapi(listHouseholdSavedRecipesRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId } = c.req.valid('param')
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' }, 404)
    const result = await listHouseholdSavedRecipes(db, accessToken, householdId)
    return c.json({ recipes: result }, 200)
  })

  app.openapi(addHouseholdSavedRecipeRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId, recipeId } = c.req.valid('param')
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' }, 404)
    const result = await addHouseholdSavedRecipe(db, accessToken, user.id, householdId, recipeId)
    if (result === 'not_found') return c.json({ error: 'RECIPE_NOT_FOUND' }, 404)
    return c.json({ ok: true as const }, 201)
  })

  app.openapi(removeHouseholdSavedRecipeRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId, recipeId } = c.req.valid('param')
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' }, 404)
    await removeHouseholdSavedRecipe(db, accessToken, householdId, recipeId)
    return c.json({ ok: true as const }, 200)
  })

  return app
}
