import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, asc, desc, eq, ilike, inArray, isNotNull, not, or, sql } from 'drizzle-orm'
import { requireAuth, requireInternalAuth, type AuthedUser } from './auth.js'
import { bootstrapHousehold } from './households.js'
import { withRls } from './rls.js'
import { householdMemberships, mealFeedback, recipes, userSavedRecipes } from './schema.js'
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
  householdId: z.string().uuid().nullable(),
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
  source: z.enum(['user_created', 'url_import', 'ai_generated', 'builtin']),
  isPublic: z.boolean(),
  isArchived: z.boolean(),
  createdBy: z.string().uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  userVote: z.enum(['up', 'down']).nullable(),
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
const ListQuerySchema = z.object({
  includeArchived: z.enum(['true', 'false']).optional(),
  includePublic: z.enum(['true', 'false']).optional(),
})
const PublicRecipeQuerySchema = z.object({ q: z.string().min(2).max(120).optional() })
const PublicRecipeParamsSchema = z.object({ recipeId: z.string().uuid() })
const RecipesEnvelopeSchema = z.object({ recipes: z.array(RecipeSchema) }).openapi('RecipesEnvelope')
const OkResponseSchema = z.object({ ok: z.literal(true) }).openapi('OkResponse')

// --- Domain functions -------------------------------------------------------

function toRecipeResponse(row: typeof recipes.$inferSelect, userVote: 'up' | 'down' | null = null) {
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
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    userVote,
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
  userId: string,
  includeArchived: boolean,
  includePublic: boolean = false,
) {
  return withRls(db, accessToken, async (tx) => {
    const householdConditions = [eq(recipes.householdId, householdId)]
    if (!includeArchived) householdConditions.push(eq(recipes.isArchived, false))

    const householdRows = await tx
      .select({ recipe: recipes, userVote: mealFeedback.vote })
      .from(recipes)
      .leftJoin(
        mealFeedback,
        and(
          eq(mealFeedback.householdId, householdId),
          eq(mealFeedback.userId, userId),
          eq(mealFeedback.mealId, sql<string>`${recipes.id}::text`),
        ),
      )
      .where(and(...householdConditions))
      .orderBy(desc(recipes.updatedAt))

    if (!includePublic) return householdRows.map((r) => toRecipeResponse(r.recipe, r.userVote ?? null))

    const householdIds = new Set(householdRows.map((r) => r.recipe.id))
    const publicRows = await tx
      .select()
      .from(recipes)
      .where(and(eq(recipes.isPublic, true), eq(recipes.isArchived, false)))
      .orderBy(asc(recipes.title))

    const uniquePublic = publicRows.filter((r) => !householdIds.has(r.id))
    return [
      ...householdRows.map((r) => toRecipeResponse(r.recipe, r.userVote ?? null)),
      ...uniquePublic.map((r) => toRecipeResponse(r, null)),
    ]
  })
}

export async function getRecipe(
  db: Db,
  accessToken: string,
  householdId: string,
  userId: string,
  recipeId: string,
) {
  return withRls(db, accessToken, async (tx) => {
    const [row] = await tx
      .select({ recipe: recipes, userVote: mealFeedback.vote })
      .from(recipes)
      .leftJoin(
        mealFeedback,
        and(
          eq(mealFeedback.householdId, householdId),
          eq(mealFeedback.userId, userId),
          eq(mealFeedback.mealId, sql<string>`${recipes.id}::text`),
        ),
      )
      .where(and(eq(recipes.id, recipeId), eq(recipes.householdId, householdId)))
    return row ? toRecipeResponse(row.recipe, row.userVote ?? null) : null
  })
}

export async function getReadableRecipeById(db: Db, accessToken: string, recipeId: string) {
  return withRls(db, accessToken, async (tx) => {
    const [recipe] = await tx.select().from(recipes).where(eq(recipes.id, recipeId)).limit(1)
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

export async function listPublicRecipes(
  db: Db,
  accessToken: string,
  userId: string,
  search: string,
) {
  return withRls(db, accessToken, async (tx) => {
    const normalizedSearch = search.trim()
    if (!normalizedSearch || normalizedSearch.length > 120) return []

    const membershipRows = await tx
      .select({ householdId: householdMemberships.householdId })
      .from(householdMemberships)
      .where(and(eq(householdMemberships.userId, userId), eq(householdMemberships.status, 'active')))
    const householdIds = membershipRows.map((row) => row.householdId)

    const conditions = [
      eq(recipes.isPublic, true),
      eq(recipes.isArchived, false),
      ilike(recipes.title, `%${normalizedSearch}%`),
    ]
    // Exclude the user's own household recipes (they appear in the household list already).
    // Builtin recipes have null household_id and are always included.
    if (householdIds.length > 0) {
      conditions.push(or(not(isNotNull(recipes.householdId)), not(inArray(recipes.householdId, householdIds)))!)
    }

    const rows = await tx
      .select()
      .from(recipes)
      .where(and(...conditions))
      .orderBy(desc(recipes.updatedAt))
      .limit(30)

    return rows.map((r) => toRecipeResponse(r, null))
  })
}

export async function listSavedRecipes(db: Db, accessToken: string, userId: string) {
  return withRls(db, accessToken, async (tx) => {
    const rows = await tx
      .select({ recipe: recipes })
      .from(userSavedRecipes)
      .innerJoin(recipes, eq(recipes.id, userSavedRecipes.recipeId))
      .where(and(eq(userSavedRecipes.userId, userId), eq(recipes.isArchived, false)))
      .orderBy(desc(userSavedRecipes.savedAt))

    return rows.map((row) => toRecipeResponse(row.recipe))
  })
}

export async function saveRecipe(db: Db, accessToken: string, userId: string, recipeId: string) {
  return withRls(db, accessToken, async (tx) => {
    const [readableRecipe] = await tx
      .select({ id: recipes.id })
      .from(recipes)
      .where(eq(recipes.id, recipeId))
      .limit(1)

    if (!readableRecipe) return 'not_found' as const

    await tx
      .insert(userSavedRecipes)
      .values({ userId, recipeId })
      .onConflictDoNothing()

    return 'saved' as const
  })
}

export async function unsaveRecipe(db: Db, accessToken: string, userId: string, recipeId: string) {
  return withRls(db, accessToken, async (tx) => {
    await tx
      .delete(userSavedRecipes)
      .where(and(eq(userSavedRecipes.userId, userId), eq(userSavedRecipes.recipeId, recipeId)))
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

const listPublicRecipesRoute = createRoute({
  method: 'get',
  path: '/recipes/public',
  operationId: 'listPublicRecipes',
  summary: 'Search public community recipes',
  security: [{ bearerAuth: [] }],
  request: { query: PublicRecipeQuerySchema },
  responses: {
    200: { description: 'Public recipes matching the search query', content: { 'application/json': { schema: RecipesEnvelopeSchema } } },
    401: { description: 'Missing or invalid session' },
  },
})

const listSavedRecipesRoute = createRoute({
  method: 'get',
  path: '/recipes/saved',
  operationId: 'listSavedRecipes',
  summary: "List the current user's saved recipes",
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: 'Saved recipes', content: { 'application/json': { schema: RecipesEnvelopeSchema } } },
    401: { description: 'Missing or invalid session' },
  },
})

const saveRecipeRoute = createRoute({
  method: 'post',
  path: '/recipes/{recipeId}/save',
  operationId: 'saveRecipe',
  summary: 'Save a readable recipe for the current user',
  security: [{ bearerAuth: [] }],
  request: { params: PublicRecipeParamsSchema },
  responses: {
    201: { description: 'Recipe saved, or already saved', content: { 'application/json': { schema: OkResponseSchema } } },
    404: { description: 'Recipe not found or not readable by caller' },
    401: { description: 'Missing or invalid session' },
  },
})

const unsaveRecipeRoute = createRoute({
  method: 'delete',
  path: '/recipes/{recipeId}/save',
  operationId: 'unsaveRecipe',
  summary: 'Remove a recipe from the current user saved list',
  security: [{ bearerAuth: [] }],
  request: { params: PublicRecipeParamsSchema },
  responses: {
    200: { description: 'Recipe unsaved, or was not saved', content: { 'application/json': { schema: OkResponseSchema } } },
    401: { description: 'Missing or invalid session' },
  },
})

export function buildRecipesRoutes(db: Db) {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()

  app.use('/households/*', requireAuth)
  app.use('/recipes/*', requireAuth)

  app.openapi(listRecipesRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId } = c.req.valid('param')
    const { includeArchived, includePublic } = c.req.valid('query')
    const list = await listRecipes(db, accessToken, householdId, user.id, includeArchived === 'true', includePublic === 'true')
    c.header('Cache-Control', 'private, max-age=300')
    return c.json(list, 200)
  })

  app.openapi(getRecipeRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId, recipeId } = c.req.valid('param')
    const recipe = await getRecipe(db, accessToken, householdId, user.id, recipeId)
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

  app.openapi(listPublicRecipesRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { q } = c.req.valid('query')
    const list = await listPublicRecipes(db, accessToken, user.id, q ?? '')
    return c.json({ recipes: list }, 200)
  })

  app.openapi(listSavedRecipesRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const list = await listSavedRecipes(db, accessToken, user.id)
    return c.json({ recipes: list }, 200)
  })

  app.openapi(saveRecipeRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { recipeId } = c.req.valid('param')
    const result = await saveRecipe(db, accessToken, user.id, recipeId)
    if (result === 'not_found') return c.json({ error: 'Recipe not found' }, 404)
    return c.json({ ok: true }, 201)
  })

  app.openapi(unsaveRecipeRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { recipeId } = c.req.valid('param')
    await unsaveRecipe(db, accessToken, user.id, recipeId)
    return c.json({ ok: true }, 200)
  })

  return app
}

function toMealPlannerListItem(recipe: ReturnType<typeof toRecipeResponse>) {
  return {
    id: recipe.id,
    title: recipe.title,
    servings: recipe.servings,
    householdId: recipe.householdId,
    tags: recipe.tags,
    isArchived: recipe.isArchived,
    isPublic: recipe.isPublic,
    ingredients: recipe.ingredients,
    prepTimeMinutes: recipe.prepTimeMinutes,
    updatedAt: recipe.updatedAt,
    forkedFromId: null,
    rootRecipeId: null,
    cuisine: recipe.cuisine,
    proteinSource: recipe.proteinSource,
    mealWeight: recipe.mealWeight,
  }
}

function toMealPlannerDetail(recipe: ReturnType<typeof toRecipeResponse>) {
  return {
    ...toMealPlannerListItem(recipe),
    cookTimeMinutes: recipe.cookTimeMinutes,
    createdAt: recipe.createdAt,
    description: recipe.description,
    sourceUrl: recipe.sourceUrl,
    steps: recipe.steps,
  }
}

const InternalListRecipesQuerySchema = z.object({
  householdId: z.string().uuid().optional(),
  includeArchived: z.enum(['true', 'false']).optional(),
  search: z.string().max(120).optional(),
})

const InternalCreateRecipeSchema = CreateRecipeSchema.extend({
  householdId: z.string().uuid().nullable().optional(),
})

const InternalUpdateRecipeSchema = UpdateRecipeSchema.extend({
  householdId: z.string().uuid().nullable().optional(),
})

function filterRecipesForMealPlannerSearch(
  list: ReturnType<typeof toRecipeResponse>[],
  search: string | undefined,
) {
  const normalized = search?.trim().toLowerCase()
  if (!normalized) return list
  return list.filter((recipe) => recipe.title.toLowerCase().includes(normalized))
}

async function resolveInternalHouseholdId(db: Db, accessToken: string, userId: string, householdId: string | null | undefined) {
  if (householdId) return householdId
  const { household } = await bootstrapHousehold(db, accessToken, userId)
  return household.id
}

// Internal server-to-server routes used by MealPlanner during the strangle
// phase. They intentionally preserve the existing MealPlanner response
// envelopes while storing data in the new backend recipes model.
export function buildInternalRecipesRoutes(db: Db) {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()

  app.use('/internal/*', requireInternalAuth)

  app.get('/internal/custom-recipes', async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const query = InternalListRecipesQuerySchema.safeParse({
      householdId: c.req.query('householdId'),
      includeArchived: c.req.query('includeArchived'),
      search: c.req.query('search'),
    })
    if (!query.success) return c.json({ error: 'INVALID_PAYLOAD' }, 400)

    const householdId = await resolveInternalHouseholdId(db, accessToken, user.id, query.data.householdId)
    const list = await listRecipes(db, accessToken, householdId, user.id, query.data.includeArchived === 'true')
    const filtered = filterRecipesForMealPlannerSearch(list, query.data.search)
    return c.json({ recipes: filtered.map(toMealPlannerListItem) }, 200)
  })

  app.post('/internal/custom-recipes', async (c) => {
    const body = await c.req.json().catch(() => null)
    const parsed = InternalCreateRecipeSchema.safeParse(body)
    if (!parsed.success) return c.json({ error: 'INVALID_PAYLOAD' }, 400)

    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const householdId = await resolveInternalHouseholdId(db, accessToken, user.id, parsed.data.householdId)
    const recipe = await createRecipe(db, accessToken, user.id, householdId, parsed.data)
    return c.json({ recipe: { id: recipe.id } }, 201)
  })

  app.get('/internal/custom-recipes/:id', async (c) => {
    const accessToken = c.get('accessToken')
    const recipe = await getReadableRecipeById(db, accessToken, c.req.param('id'))
    if (!recipe) return c.json({ error: 'NOT_FOUND' }, 404)
    return c.json({ recipe: toMealPlannerDetail(recipe) }, 200)
  })

  app.patch('/internal/custom-recipes/:id', async (c) => {
    const accessToken = c.get('accessToken')
    const body = await c.req.json().catch(() => null)
    const parsed = InternalUpdateRecipeSchema.safeParse(body)
    if (!parsed.success) return c.json({ error: 'INVALID_PAYLOAD' }, 400)

    const existing = await getReadableRecipeById(db, accessToken, c.req.param('id'))
    if (!existing) return c.json({ error: 'NOT_FOUND' }, 404)

    const householdId = parsed.data.householdId ?? existing.householdId
    if (!householdId) return c.json({ error: 'NOT_FOUND' }, 404)
    const recipe = await updateRecipe(db, accessToken, householdId, existing.id, parsed.data)
    if (!recipe) return c.json({ error: 'NOT_FOUND' }, 404)
    return c.json({ ok: true }, 200)
  })

  app.patch('/internal/custom-recipes/:id/archive', async (c) => {
    const accessToken = c.get('accessToken')
    const body = await c.req.json().catch(() => null)
    if (typeof body?.isArchived !== 'boolean') return c.json({ error: 'INVALID_PAYLOAD' }, 400)

    const existing = await getReadableRecipeById(db, accessToken, c.req.param('id'))
    if (!existing) return c.json({ error: 'NOT_FOUND' }, 404)
    if (!existing.householdId) return c.json({ error: 'NOT_FOUND' }, 404)

    const recipe = await updateRecipe(db, accessToken, existing.householdId, existing.id, { isArchived: body.isArchived })
    if (!recipe) return c.json({ error: 'NOT_FOUND' }, 404)
    return c.json({ ok: true }, 200)
  })

  app.get('/internal/recipes/public', async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const q = c.req.query('q')?.trim() ?? ''
    if (!q || q.length > 120) return c.json({ recipes: [] }, 200)
    const list = await listPublicRecipes(db, accessToken, user.id, q)
    return c.json({ recipes: list }, 200)
  })

  app.get('/internal/recipes/saved', async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const list = await listSavedRecipes(db, accessToken, user.id)
    return c.json({ recipes: list }, 200)
  })

  app.post('/internal/recipes/:id/save', async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const result = await saveRecipe(db, accessToken, user.id, c.req.param('id'))
    if (result === 'not_found') return c.json({ error: 'NOT_FOUND' }, 404)
    return c.json({ ok: true }, 201)
  })

  app.delete('/internal/recipes/:id/save', async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    await unsaveRecipe(db, accessToken, user.id, c.req.param('id'))
    return c.json({ ok: true }, 200)
  })

  return app
}
