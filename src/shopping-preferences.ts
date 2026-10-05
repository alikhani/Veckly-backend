import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { eq } from 'drizzle-orm'
import { requireAuth, type AuthedUser } from './auth.js'
import type { Db } from './db.js'
import { INGREDIENT_CATEGORIES } from './ingredient-categories.js'
import { assertMembership } from './membership.js'
import { withRls } from './rls.js'
import { householdShoppingPreferences } from './schema.js'

export const DEFAULT_SHOPPING_CATEGORY_ORDER = [...INGREDIENT_CATEGORIES]

const ShoppingCategorySchema = z.enum(INGREDIENT_CATEGORIES)
const CategoryOrderSchema = z.array(ShoppingCategorySchema).length(INGREDIENT_CATEGORIES.length).superRefine((value, context) => {
  if (new Set(value).size !== INGREDIENT_CATEGORIES.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Each shopping category must occur exactly once' })
  }
})

const ShoppingPreferencesSchema = z.object({
  categoryOrder: CategoryOrderSchema,
  updatedAt: z.string().nullable(),
}).openapi('ShoppingPreferences')

const UpdateShoppingPreferencesSchema = z.object({
  categoryOrder: CategoryOrderSchema,
}).openapi('UpdateShoppingPreferences')

const ParamsSchema = z.object({ householdId: z.string().uuid() })

const getRoute = createRoute({
  method: 'get', path: '/households/{householdId}/shopping-preferences', operationId: 'getShoppingPreferences',
  summary: 'Read household shopping preferences', security: [{ bearerAuth: [] }],
  request: { params: ParamsSchema },
  responses: {
    200: { description: 'Shopping preferences', content: { 'application/json': { schema: ShoppingPreferencesSchema } } },
    401: { description: 'Missing or invalid session' },
    404: { description: 'Household not found or caller is not a member' },
  },
})

const putRoute = createRoute({
  method: 'put', path: '/households/{householdId}/shopping-preferences', operationId: 'putShoppingPreferences',
  summary: 'Replace household shopping preferences', security: [{ bearerAuth: [] }],
  request: { params: ParamsSchema, body: { required: true, content: { 'application/json': { schema: UpdateShoppingPreferencesSchema } } } },
  responses: {
    200: { description: 'Updated shopping preferences', content: { 'application/json': { schema: ShoppingPreferencesSchema } } },
    400: { description: 'Invalid category order' },
    401: { description: 'Missing or invalid session' },
    404: { description: 'Household not found or caller is not a member' },
  },
})

export async function getShoppingPreferences(db: Db, accessToken: string, householdId: string) {
  const [row] = await withRls(db, accessToken, (tx) => tx
    .select({ categoryOrder: householdShoppingPreferences.categoryOrder, updatedAt: householdShoppingPreferences.updatedAt })
    .from(householdShoppingPreferences)
    .where(eq(householdShoppingPreferences.householdId, householdId))
    .limit(1))
  return {
    categoryOrder: row ? CategoryOrderSchema.parse(row.categoryOrder) : DEFAULT_SHOPPING_CATEGORY_ORDER,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  }
}

export async function putShoppingPreferences(db: Db, accessToken: string, userId: string, householdId: string, categoryOrder: string[]) {
  const parsedOrder = CategoryOrderSchema.parse(categoryOrder)
  const [row] = await withRls(db, accessToken, (tx) => tx
    .insert(householdShoppingPreferences)
    .values({ householdId, categoryOrder: parsedOrder, updatedBy: userId, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: householdShoppingPreferences.householdId,
      set: { categoryOrder: parsedOrder, updatedBy: userId, updatedAt: new Date() },
    })
    .returning({ categoryOrder: householdShoppingPreferences.categoryOrder, updatedAt: householdShoppingPreferences.updatedAt }))
  if (!row) throw new Error('Shopping preferences upsert did not return a row')
  return { categoryOrder: CategoryOrderSchema.parse(row.categoryOrder), updatedAt: row.updatedAt.toISOString() }
}

export function buildShoppingPreferencesRoutes(db: Db) {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()
  app.use('/households/*', requireAuth)

  app.openapi(getRoute, async (c) => {
    const { householdId } = c.req.valid('param')
    const user = c.get('user')
    const accessToken = c.get('accessToken')
    if (!await assertMembership(db, accessToken, householdId, user.id)) return c.json({ error: 'NOT_MEMBER' } as never, 404)
    return c.json(await getShoppingPreferences(db, accessToken, householdId), 200)
  })

  app.openapi(putRoute, async (c) => {
    const { householdId } = c.req.valid('param')
    const user = c.get('user')
    const accessToken = c.get('accessToken')
    if (!await assertMembership(db, accessToken, householdId, user.id)) return c.json({ error: 'NOT_MEMBER' } as never, 404)
    return c.json(await putShoppingPreferences(db, accessToken, user.id, householdId, c.req.valid('json').categoryOrder), 200)
  })
  return app
}
