import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, eq, desc } from 'drizzle-orm'
import { requireAuth, type AuthedUser } from './auth.js'
import { withRls } from './rls.js'
import { recipes } from './schema.js'
import type { Db } from './db.js'

// --- Wire shapes ------------------------------------------------------------

const RecipeIngredientSchema = z.object({
  item: z.string().min(1),
  amount: z.string().optional(),
  unit: z.string().optional(),
  category: z.string().optional(),
}).openapi('RecipeIngredient')

const RecipeStepSchema = z.object({
  text: z.string().min(1),
}).openapi('RecipeStep')

const RecipeSchema = z.object({
  id: z.string().uuid(),
  householdId: z.string().uuid(),
  title: z.string(),
  description: z.string(),
  servings: z.number().int(),
  ingredients: z.array(RecipeIngredientSchema),
  steps: z.array(RecipeStepSchema),
  tags: z.array(z.string()),
  prepTimeMinutes: z.number().int().nullable(),
  cookTimeMinutes: z.number().int().nullable(),
  cuisine: z.string().nullable(),
  proteinSource: z.string().nullable(),
  mealWeight: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  source: z.enum(['user_created', 'url_import', 'ai_generated']),
  isPublic: z.boolean(),
  isArchived: z.boolean(),
  createdBy: z.string().uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).openapi('Recipe')

const CreateRecipeSchema = z.object({
  title: z.string().min(1),
  description: z.string().default(''),
  servings: z.number().int().min(1).default(4),
  ingredients: z.array(RecipeIngredientSchema).default([]),
  steps: z.array(RecipeStepSchema).default([]),
  tags: z.array(z.string()).default([]),
  prepTimeMinutes: z.number().int().min(1).nullable().optional(),
  cookTimeMinutes: z.number().int().min(1).nullable().optional(),
  cuisine: z.string().nullable().optional(),
  proteinSource: z.string().nullable().optional(),
  mealWeight: z.string().nullable().optional(),
  sourceUrl: z.string().url().nullable().optional(),
  source: z.enum(['user_created', 'url_import', 'ai_generated']).default('user_created'),
  isPublic: z.boolean().default(false),
}).openapi('CreateRecipe')

const UpdateRecipeSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  servings: z.number().int().min(1).optional(),
  ingredients: z.array(RecipeIngredientSchema).optional(),
  steps: z.array(RecipeStepSchema).optional(),
  tags: z.array(z.string()).optional(),
  prepTimeMinutes: z.number().int().min(1).nullable().optional(),
  cookTimeMinutes: z.number().int().min(1).nullable().optional(),
  cuisine: z.string().nullable().optional(),
  proteinSource: z.string().nullable().optional(),
  mealWeight: z.string().nullable().optional(),
  sourceUrl: z.string().url().nullable().optional(),
  isPublic: z.boolean().optional(),
  isArchived: z.boolean().optional(),
}).openapi('UpdateRecipe')

const HouseholdParamsSchema = z.object({ householdId: z.string().uuid() })
const RecipeParamsSchema = z.object({ householdId: z.string().uuid(), recipeId: z.string().uuid() })
const ListQuerySchema = z.object({ includeArchived: z.enum(['true', 'false']).optional() })

// --- Domain functions -------------------------------------------------------

function toRecipeResponse(row: typeof recipes.$inferSelect) {
  return {
    id: row.id,
    householdId: row.householdId,
    title: row.title,
    description: row.description,
    servings: row.servings,
    ingredients: row.ingredients as z.infer<typeof RecipeIngredientSchema>[],
    steps: row.steps as z.infer<typeof RecipeStepSchema>[],
    tags: row.tags as string[],
    prepTimeMinutes: row.prepTimeMinutes ?? null,
    cookTimeMinutes: row.cookTimeMinutes ?? null,
    cuisine: row.cuisine ?? null,
    proteinSource: row.proteinSource ?? null,
    mealWeight: row.mealWeight ?? null,
    sourceUrl: row.sourceUrl ?? null,
    source: row.source,
    isPublic: row.isPublic,
    isArchived: row.isArchived,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export async function createRecipe(
  db: Db,
  accessToken: string,
  userId: string,
  householdId: string,
  input: z.infer<typeof CreateRecipeSchema>,
) {
  return withRls(db, accessToken, async (tx) => {
    const [recipe] = await tx
      .insert(recipes)
      .values({
        householdId,
        createdBy: userId,
        title: input.title,
        description: input.description,
        servings: input.servings,
        ingredients: input.ingredients,
        steps: input.steps,
        tags: input.tags,
        prepTimeMinutes: input.prepTimeMinutes ?? null,
        cookTimeMinutes: input.cookTimeMinutes ?? null,
        cuisine: input.cuisine ?? null,
        proteinSource: input.proteinSource ?? null,
        mealWeight: input.mealWeight ?? null,
        sourceUrl: input.sourceUrl ?? null,
        source: input.source,
        isPublic: input.isPublic,
      })
      .returning()
    if (!recipe) throw new Error('Insert did not return the persisted recipe')
    return toRecipeResponse(recipe)
  })
}

export async function listRecipes(
  db: Db,
  accessToken: string,
  householdId: string,
  includeArchived: boolean,
) {
  return withRls(db, accessToken, async (tx) => {
    const conditions = [eq(recipes.householdId, householdId)]
    if (!includeArchived) conditions.push(eq(recipes.isArchived, false))

    const rows = await tx
      .select()
      .from(recipes)
      .where(and(...conditions))
      .orderBy(desc(recipes.updatedAt))

    return rows.map(toRecipeResponse)
  })
}

export async function getRecipe(
  db: Db,
  accessToken: string,
  householdId: string,
  recipeId: string,
) {
  return withRls(db, accessToken, async (tx) => {
    const [recipe] = await tx
      .select()
      .from(recipes)
      .where(and(eq(recipes.id, recipeId), eq(recipes.householdId, householdId)))
    return recipe ? toRecipeResponse(recipe) : null
  })
}

export async function updateRecipe(
  db: Db,
  accessToken: string,
  householdId: string,
  recipeId: string,
  input: z.infer<typeof UpdateRecipeSchema>,
) {
  return withRls(db, accessToken, async (tx) => {
    const set: Partial<typeof recipes.$inferInsert> = { updatedAt: new Date() }
    if (input.title !== undefined) set.title = input.title
    if (input.description !== undefined) set.description = input.description
    if (input.servings !== undefined) set.servings = input.servings
    if (input.ingredients !== undefined) set.ingredients = input.ingredients
    if (input.steps !== undefined) set.steps = input.steps
    if (input.tags !== undefined) set.tags = input.tags
    if (input.prepTimeMinutes !== undefined) set.prepTimeMinutes = input.prepTimeMinutes
    if (input.cookTimeMinutes !== undefined) set.cookTimeMinutes = input.cookTimeMinutes
    if (input.cuisine !== undefined) set.cuisine = input.cuisine
    if (input.proteinSource !== undefined) set.proteinSource = input.proteinSource
    if (input.mealWeight !== undefined) set.mealWeight = input.mealWeight
    if (input.sourceUrl !== undefined) set.sourceUrl = input.sourceUrl
    if (input.isPublic !== undefined) set.isPublic = input.isPublic
    if (input.isArchived !== undefined) set.isArchived = input.isArchived

    const [updated] = await tx
      .update(recipes)
      .set(set)
      .where(and(eq(recipes.id, recipeId), eq(recipes.householdId, householdId)))
      .returning()

    return updated ? toRecipeResponse(updated) : null
  })
}

// --- Routes -----------------------------------------------------------------

const listRecipesRoute = createRoute({
  method: 'get',
  path: '/households/{householdId}/recipes',
  operationId: 'listRecipes',
  summary: "List a household's recipes",
  security: [{ bearerAuth: [] }],
  request: { params: HouseholdParamsSchema, query: ListQuerySchema },
  responses: {
    200: { description: 'Recipes list', content: { 'application/json': { schema: z.array(RecipeSchema) } } },
    401: { description: 'Missing or invalid session' },
  },
})

const getRecipeRoute = createRoute({
  method: 'get',
  path: '/households/{householdId}/recipes/{recipeId}',
  operationId: 'getRecipe',
  summary: 'Get a single recipe',
  security: [{ bearerAuth: [] }],
  request: { params: RecipeParamsSchema },
  responses: {
    200: { description: 'The recipe', content: { 'application/json': { schema: RecipeSchema } } },
    404: { description: 'Recipe not found' },
    401: { description: 'Missing or invalid session' },
  },
})

const createRecipeRoute = createRoute({
  method: 'post',
  path: '/households/{householdId}/recipes',
  operationId: 'createRecipe',
  summary: 'Create a recipe',
  security: [{ bearerAuth: [] }],
  request: {
    params: HouseholdParamsSchema,
    body: { content: { 'application/json': { schema: CreateRecipeSchema } } },
  },
  responses: {
    201: { description: 'The created recipe', content: { 'application/json': { schema: RecipeSchema } } },
    401: { description: 'Missing or invalid session' },
  },
})

const updateRecipeRoute = createRoute({
  method: 'patch',
  path: '/households/{householdId}/recipes/{recipeId}',
  operationId: 'updateRecipe',
  summary: 'Update a recipe (also used to archive via isArchived: true)',
  security: [{ bearerAuth: [] }],
  request: {
    params: RecipeParamsSchema,
    body: { content: { 'application/json': { schema: UpdateRecipeSchema } } },
  },
  responses: {
    200: { description: 'The updated recipe', content: { 'application/json': { schema: RecipeSchema } } },
    404: { description: 'Recipe not found or not in this household' },
    401: { description: 'Missing or invalid session' },
  },
})

export function buildRecipesRoutes(db: Db) {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()

  app.use('/households/*', requireAuth)

  app.openapi(listRecipesRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const { householdId } = c.req.valid('param')
    const { includeArchived } = c.req.valid('query')
    const list = await listRecipes(db, accessToken, householdId, includeArchived === 'true')
    return c.json(list, 200)
  })

  app.openapi(getRecipeRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const { householdId, recipeId } = c.req.valid('param')
    const recipe = await getRecipe(db, accessToken, householdId, recipeId)
    if (!recipe) return c.json({ error: 'Recipe not found' }, 404)
    return c.json(recipe, 200)
  })

  app.openapi(createRecipeRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId } = c.req.valid('param')
    const body = c.req.valid('json')
    const recipe = await createRecipe(db, accessToken, user.id, householdId, body)
    return c.json(recipe, 201)
  })

  app.openapi(updateRecipeRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const { householdId, recipeId } = c.req.valid('param')
    const body = c.req.valid('json')
    const recipe = await updateRecipe(db, accessToken, householdId, recipeId, body)
    if (!recipe) return c.json({ error: 'Recipe not found' }, 404)
    return c.json(recipe, 200)
  })

  return app
}
