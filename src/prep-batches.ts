import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, eq, gte, inArray, lte } from 'drizzle-orm'
import { requireAuth, type AuthedUser } from './auth.js'
import { withRls } from './rls.js'
import { householdPrepBatchAssignments, householdPrepBatches } from './schema.js'
import type { Db } from './db.js'

type AppEnv = { Variables: { user: AuthedUser; accessToken: string } }

const PrepBatchAssignmentSchema = z.object({
  id: z.string().uuid(),
  batchId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  mealType: z.enum(['lunch', 'dinner']),
}).openapi('PrepBatchAssignment')

const PrepBatchSchema = z.object({
  id: z.string().uuid(),
  householdId: z.string().uuid(),
  recipeId: z.string().uuid().nullable(),
  customRecipeId: z.string().uuid().nullable(),
  cookDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  totalPortions: z.number().int().min(1).max(100),
  createdBy: z.string().uuid(),
  createdAt: z.string(),
  assignments: z.array(PrepBatchAssignmentSchema),
}).openapi('PrepBatch')

const HouseholdParamsSchema = z.object({ householdId: z.string().uuid() })
const BatchParamsSchema = z.object({ householdId: z.string().uuid(), batchId: z.string().uuid() })
const OkResponseSchema = z.object({ ok: z.literal(true) }).openapi('PrepBatchOkResponse')

const CreatePrepBatchSchema = z.object({
  recipeId: z.string().uuid().optional(),
  customRecipeId: z.string().uuid().optional(),
  cookDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'),
  totalPortions: z.number().int().min(1).max(100),
  assignments: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    mealType: z.enum(['lunch', 'dinner']),
  })).min(1),
}).refine((b) => Boolean(b.recipeId) !== Boolean(b.customRecipeId), {
  message: 'Exactly one of recipeId or customRecipeId is required',
}).openapi('CreatePrepBatch')

const listRoute = createRoute({
  method: 'get',
  path: '/households/{householdId}/prep_batches',
  security: [{ bearerAuth: [] }],
  request: {
    params: HouseholdParamsSchema,
    query: z.object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }),
  },
  responses: {
    200: { content: { 'application/json': { schema: z.object({ batches: z.array(PrepBatchSchema) }) } }, description: 'Prep batches in date range' },
    400: { content: { 'application/json': { schema: z.object({ error: z.string() }) } }, description: 'Invalid date range' },
    401: { content: { 'application/json': { schema: z.object({ error: z.string() }) } }, description: 'Unauthenticated' },
    404: { content: { 'application/json': { schema: z.object({ error: z.string() }) } }, description: 'Household not found or not a member' },
  },
})

const createRoute_ = createRoute({
  method: 'post',
  path: '/households/{householdId}/prep_batches',
  security: [{ bearerAuth: [] }],
  request: {
    params: HouseholdParamsSchema,
    body: { content: { 'application/json': { schema: CreatePrepBatchSchema } } },
  },
  responses: {
    201: { content: { 'application/json': { schema: PrepBatchSchema } }, description: 'Prep batch created' },
    400: { content: { 'application/json': { schema: z.object({ error: z.string() }) } }, description: 'Invalid payload' },
    401: { content: { 'application/json': { schema: z.object({ error: z.string() }) } }, description: 'Unauthenticated' },
    404: { content: { 'application/json': { schema: z.object({ error: z.string() }) } }, description: 'Household not found or not a member' },
  },
})

const deleteRoute = createRoute({
  method: 'delete',
  path: '/households/{householdId}/prep_batches/{batchId}',
  security: [{ bearerAuth: [] }],
  request: { params: BatchParamsSchema },
  responses: {
    200: { content: { 'application/json': { schema: OkResponseSchema } }, description: 'Prep batch deleted' },
    401: { content: { 'application/json': { schema: z.object({ error: z.string() }) } }, description: 'Unauthenticated' },
    404: { content: { 'application/json': { schema: z.object({ error: z.string() }) } }, description: 'Prep batch not found or not a member' },
  },
})

export function buildPrepBatchesRoutes(db: Db) {
  const app = new OpenAPIHono<AppEnv>()

  app.use('/households/:householdId/prep_batches', requireAuth)
  app.use('/households/:householdId/prep_batches/:batchId', requireAuth)

  app.openapi(listRoute, async (c) => {
    const user = c.get('user')
    const accessToken = c.get('accessToken')
    const { householdId } = c.req.valid('param')
    const { from, to } = c.req.valid('query')

    const batches = await withRls(db, accessToken, async (tx) => {
      return tx
        .select()
        .from(householdPrepBatches)
        .where(
          and(
            eq(householdPrepBatches.householdId, householdId),
            lte(householdPrepBatches.cookDate, to),
            gte(householdPrepBatches.cookDate, from),
          ),
        )
    })

    if (batches.length === 0) {
      return c.json({ batches: [] }, 200)
    }

    const batchIds = batches.map((b) => b.id)
    const assignments = await withRls(db, accessToken, async (tx) => {
      return tx
        .select()
        .from(householdPrepBatchAssignments)
        .where(
          batchIds.length === 1
            ? eq(householdPrepBatchAssignments.batchId, batchIds[0]!)
            : inArray(householdPrepBatchAssignments.batchId, batchIds),
        )
    })

    const assignmentsByBatch = assignments.reduce<Record<string, typeof assignments>>(
      (acc, a) => {
        acc[a.batchId] = acc[a.batchId] ?? []
        acc[a.batchId]!.push(a)
        return acc
      },
      {},
    )

    return c.json({
      batches: batches.map((b) => ({
        id: b.id,
        householdId: b.householdId,
        recipeId: b.recipeId ?? null,
        customRecipeId: b.customRecipeId ?? null,
        cookDate: b.cookDate,
        totalPortions: b.totalPortions,
        createdBy: b.createdBy,
        createdAt: b.createdAt.toISOString(),
        assignments: (assignmentsByBatch[b.id] ?? []).map((a) => ({
          id: a.id,
          batchId: a.batchId,
          date: a.date,
          mealType: a.mealType as 'lunch' | 'dinner',
        })),
      })),
    }, 200)
  })

  app.openapi(createRoute_, async (c) => {
    const user = c.get('user')
    const accessToken = c.get('accessToken')
    const { householdId } = c.req.valid('param')
    const body = c.req.valid('json')

    const [batch] = await withRls(db, accessToken, async (tx) => {
      return tx
        .insert(householdPrepBatches)
        .values({
          householdId,
          recipeId: body.recipeId ?? null,
          customRecipeId: body.customRecipeId ?? null,
          cookDate: body.cookDate,
          totalPortions: body.totalPortions,
          createdBy: user.id,
        })
        .returning()
    })

    if (!batch) return c.json({ error: 'HOUSEHOLD_NOT_FOUND' }, 404)

    const insertedAssignments = await withRls(db, accessToken, async (tx) => {
      return tx
        .insert(householdPrepBatchAssignments)
        .values(body.assignments.map((a) => ({ batchId: batch.id, date: a.date, mealType: a.mealType })))
        .returning()
    })

    return c.json({
      id: batch.id,
      householdId: batch.householdId,
      recipeId: batch.recipeId ?? null,
      customRecipeId: batch.customRecipeId ?? null,
      cookDate: batch.cookDate,
      totalPortions: batch.totalPortions,
      createdBy: batch.createdBy,
      createdAt: batch.createdAt.toISOString(),
      assignments: insertedAssignments.map((a) => ({
        id: a.id,
        batchId: a.batchId,
        date: a.date,
        mealType: a.mealType as 'lunch' | 'dinner',
      })),
    }, 201)
  })

  app.openapi(deleteRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const { householdId, batchId } = c.req.valid('param')

    const [deleted] = await withRls(db, accessToken, async (tx) => {
      return tx
        .delete(householdPrepBatches)
        .where(and(eq(householdPrepBatches.id, batchId), eq(householdPrepBatches.householdId, householdId)))
        .returning({ id: householdPrepBatches.id })
    })

    if (!deleted) return c.json({ error: 'NOT_FOUND' }, 404)
    return c.json({ ok: true as const }, 200)
  })

  return app
}
