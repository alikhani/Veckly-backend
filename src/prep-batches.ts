import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, eq, gte, inArray, lte } from 'drizzle-orm'
import { requireAuth, requireInternalAuth, type AuthedUser } from './auth.js'
import { assertMembership } from './membership.js'
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
const AssignmentParamsSchema = z.object({
  householdId: z.string().uuid(),
  batchId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})
const AssignmentQuerySchema = z.object({ mealType: z.enum(['lunch', 'dinner']) })
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
}).refine((b) => !(b.recipeId && b.customRecipeId), {
  // Both unset is valid — leftovers with no specific dish tracked.
  message: 'recipeId and customRecipeId cannot both be set',
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

const removeAssignmentRoute = createRoute({
  method: 'delete',
  path: '/households/{householdId}/prep_batches/{batchId}/assignments/{date}',
  operationId: 'removePrepBatchAssignment',
  summary: 'Remove a single day from a prep batch (deletes the batch if no days remain)',
  security: [{ bearerAuth: [] }],
  request: { params: AssignmentParamsSchema, query: AssignmentQuerySchema },
  responses: {
    200: { content: { 'application/json': { schema: OkResponseSchema } }, description: 'Assignment removed' },
    401: { content: { 'application/json': { schema: z.object({ error: z.string() }) } }, description: 'Unauthenticated' },
    404: { content: { 'application/json': { schema: z.object({ error: z.string() }) } }, description: 'Assignment not found or not a member' },
  },
})

async function listBatches(db: Db, accessToken: string, householdId: string, from: string, to: string) {
  const batches = await withRls(db, accessToken, (tx) =>
    tx
      .select()
      .from(householdPrepBatches)
      .where(
        and(
          eq(householdPrepBatches.householdId, householdId),
          lte(householdPrepBatches.cookDate, to),
          gte(householdPrepBatches.cookDate, from),
        ),
      ),
  )

  if (batches.length === 0) return { batches: [] }

  const batchIds = batches.map((b) => b.id)
  const assignments = await withRls(db, accessToken, (tx) =>
    tx
      .select()
      .from(householdPrepBatchAssignments)
      .where(
        batchIds.length === 1
          ? eq(householdPrepBatchAssignments.batchId, batchIds[0]!)
          : inArray(householdPrepBatchAssignments.batchId, batchIds),
      ),
  )

  const assignmentsByBatch = assignments.reduce<Record<string, typeof assignments>>((acc, a) => {
    acc[a.batchId] = acc[a.batchId] ?? []
    acc[a.batchId]!.push(a)
    return acc
  }, {})

  return {
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
  }
}

async function createBatch(
  db: Db,
  accessToken: string,
  userId: string,
  householdId: string,
  body: z.infer<typeof CreatePrepBatchSchema>,
) {
  return withRls(db, accessToken, async (tx) => {
    const [batch] = await tx
      .insert(householdPrepBatches)
      .values({
        householdId,
        recipeId: body.recipeId ?? null,
        customRecipeId: body.customRecipeId ?? null,
        cookDate: body.cookDate,
        totalPortions: body.totalPortions,
        createdBy: userId,
      })
      .returning()

    if (!batch) return null

    const insertedAssignments = await tx
      .insert(householdPrepBatchAssignments)
      .values(body.assignments.map((a) => ({ batchId: batch.id, date: a.date, mealType: a.mealType })))
      .returning()

    return {
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
    }
  })
}

async function deleteBatch(db: Db, accessToken: string, householdId: string, batchId: string) {
  const [deleted] = await withRls(db, accessToken, (tx) =>
    tx
      .delete(householdPrepBatches)
      .where(and(eq(householdPrepBatches.id, batchId), eq(householdPrepBatches.householdId, householdId)))
      .returning({ id: householdPrepBatches.id }),
  )
  return deleted ?? null
}

async function removeAssignment(
  db: Db,
  accessToken: string,
  householdId: string,
  batchId: string,
  date: string,
  mealType: 'lunch' | 'dinner',
) {
  return withRls(db, accessToken, async (tx) => {
    const [deleted] = await tx
      .delete(householdPrepBatchAssignments)
      .where(
        and(
          eq(householdPrepBatchAssignments.batchId, batchId),
          eq(householdPrepBatchAssignments.date, date),
          eq(householdPrepBatchAssignments.mealType, mealType),
        ),
      )
      .returning({ id: householdPrepBatchAssignments.id })

    if (!deleted) return null

    const remaining = await tx
      .select({ id: householdPrepBatchAssignments.id })
      .from(householdPrepBatchAssignments)
      .where(eq(householdPrepBatchAssignments.batchId, batchId))

    // A batch with no covered days left has no UI surface to find it from —
    // clean it up rather than leaving orphaned rows behind.
    if (remaining.length === 0) {
      await tx
        .delete(householdPrepBatches)
        .where(and(eq(householdPrepBatches.id, batchId), eq(householdPrepBatches.householdId, householdId)))
    }

    return deleted
  })
}

export function buildPrepBatchesRoutes(db: Db) {
  const app = new OpenAPIHono<AppEnv>()

  app.use('/households/:householdId/prep_batches', requireAuth)
  app.use('/households/:householdId/prep_batches/:batchId', requireAuth)
  app.use('/households/:householdId/prep_batches/:batchId/assignments/:date', requireAuth)

  app.openapi(listRoute, async (c) => {
    const user = c.get('user')
    const accessToken = c.get('accessToken')
    const { householdId } = c.req.valid('param')
    const { from, to } = c.req.valid('query')
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'HOUSEHOLD_NOT_FOUND' }, 404)
    const result = await listBatches(db, accessToken, householdId, from, to)
    return c.json(result, 200)
  })

  app.openapi(createRoute_, async (c) => {
    const user = c.get('user')
    const accessToken = c.get('accessToken')
    const { householdId } = c.req.valid('param')
    const body = c.req.valid('json')
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'HOUSEHOLD_NOT_FOUND' }, 404)
    const batch = await createBatch(db, accessToken, user.id, householdId, body)
    if (!batch) return c.json({ error: 'HOUSEHOLD_NOT_FOUND' }, 404)
    return c.json(batch, 201)
  })

  app.openapi(deleteRoute, async (c) => {
    const user = c.get('user')
    const accessToken = c.get('accessToken')
    const { householdId, batchId } = c.req.valid('param')
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' }, 404)
    const deleted = await deleteBatch(db, accessToken, householdId, batchId)
    if (!deleted) return c.json({ error: 'NOT_FOUND' }, 404)
    return c.json({ ok: true as const }, 200)
  })

  app.openapi(removeAssignmentRoute, async (c) => {
    const user = c.get('user')
    const accessToken = c.get('accessToken')
    const { householdId, batchId, date } = c.req.valid('param')
    const { mealType } = c.req.valid('query')
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' }, 404)
    const removed = await removeAssignment(db, accessToken, householdId, batchId, date, mealType)
    if (!removed) return c.json({ error: 'NOT_FOUND' }, 404)
    return c.json({ ok: true as const }, 200)
  })

  return app
}

export function buildInternalPrepBatchesRoutes(db: Db) {
  const app = new OpenAPIHono<AppEnv>()

  app.use('/internal/*', requireInternalAuth)

  app.get('/internal/households/:householdId/prep_batches', async (c) => {
    const user = c.get('user')
    const accessToken = c.get('accessToken')
    const householdId = c.req.param('householdId')
    const from = c.req.query('from')
    const to = c.req.query('to')

    if (!from?.match(/^\d{4}-\d{2}-\d{2}$/) || !to?.match(/^\d{4}-\d{2}-\d{2}$/)) {
      return c.json({ error: 'Invalid date range' }, 400)
    }

    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'HOUSEHOLD_NOT_FOUND' }, 404)

    const result = await listBatches(db, accessToken, householdId, from, to)
    return c.json(result, 200)
  })

  app.post('/internal/households/:householdId/prep_batches', async (c) => {
    const user = c.get('user')
    const accessToken = c.get('accessToken')
    const householdId = c.req.param('householdId')

    const parsed = CreatePrepBatchSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_PAYLOAD' }, 400)

    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'HOUSEHOLD_NOT_FOUND' }, 404)

    const batch = await createBatch(db, accessToken, user.id, householdId, parsed.data)
    if (!batch) return c.json({ error: 'HOUSEHOLD_NOT_FOUND' }, 404)
    return c.json(batch, 201)
  })

  app.delete('/internal/households/:householdId/prep_batches/:batchId', async (c) => {
    const accessToken = c.get('accessToken')
    const householdId = c.req.param('householdId')
    const batchId = c.req.param('batchId')
    const deleted = await deleteBatch(db, accessToken, householdId, batchId)
    if (!deleted) return c.json({ error: 'NOT_FOUND' }, 404)
    return c.json({ ok: true as const }, 200)
  })

  app.delete('/internal/households/:householdId/prep_batches/:batchId/assignments/:date', async (c) => {
    const accessToken = c.get('accessToken')
    const householdId = c.req.param('householdId')
    const batchId = c.req.param('batchId')
    const date = c.req.param('date')
    const mealType = c.req.query('mealType')

    if (mealType !== 'lunch' && mealType !== 'dinner') {
      return c.json({ error: 'INVALID_MEAL_TYPE' }, 400)
    }

    const removed = await removeAssignment(db, accessToken, householdId, batchId, date, mealType)
    if (!removed) return c.json({ error: 'NOT_FOUND' }, 404)
    return c.json({ ok: true as const }, 200)
  })

  return app
}
