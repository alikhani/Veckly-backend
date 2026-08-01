import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, desc, eq } from 'drizzle-orm'
import { requireAuth, requireInternalAuth, type AuthedUser } from './auth.js'
import { withRls } from './rls.js'
import { savedPlans } from './schema.js'
import { resolveEntitlementForUser } from './entitlements.js'
import { isPremiumLimitReached, observePremiumGate, PremiumRequiredResponseSchema } from './premium-gates.js'
import type { Db } from './db.js'

const SavedPlanSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string(),
  label: z.string(),
  state: z.string(),
}).openapi('SavedPlan')

const UpsertSavedPlanSchema = SavedPlanSchema.extend({
  createdAt: z.string().datetime(),
}).openapi('UpsertSavedPlan')
const RenameSavedPlanSchema = z.object({ label: z.string().min(1) }).openapi('RenameSavedPlan')
const SavedPlanParamsSchema = z.object({ id: z.string().uuid() })
const OkResponseSchema = z.object({ ok: z.literal(true) }).openapi('OkResponse')

function toSavedPlanResponse(row: typeof savedPlans.$inferSelect) {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    label: row.label,
    state: row.stateJson,
  }
}

export async function listSavedPlans(db: Db, accessToken: string, userId: string) {
  return withRls(db, accessToken, async (tx) => {
    const rows = await tx
      .select()
      .from(savedPlans)
      .where(eq(savedPlans.userId, userId))
      .orderBy(desc(savedPlans.createdAt))

    return rows.map(toSavedPlanResponse)
  })
}

export async function upsertSavedPlan(
  db: Db,
  accessToken: string,
  userId: string,
  input: z.infer<typeof UpsertSavedPlanSchema>,
) {
  return withRls(db, accessToken, async (tx) => {
    const [row] = await tx
      .insert(savedPlans)
      .values({
        id: input.id,
        userId,
        createdAt: new Date(input.createdAt),
        label: input.label,
        stateJson: input.state,
      })
      .onConflictDoUpdate({
        target: savedPlans.id,
        set: {
          userId,
          createdAt: new Date(input.createdAt),
          label: input.label,
          stateJson: input.state,
        },
        where: eq(savedPlans.userId, userId),
      })
      .returning()

    if (!row) return null
    return toSavedPlanResponse(row)
  })
}

export async function renameSavedPlan(db: Db, accessToken: string, userId: string, id: string, label: string) {
  return withRls(db, accessToken, async (tx) => {
    const [row] = await tx
      .update(savedPlans)
      .set({ label })
      .where(and(eq(savedPlans.id, id), eq(savedPlans.userId, userId)))
      .returning()

    return row ? toSavedPlanResponse(row) : null
  })
}

export async function removeSavedPlan(db: Db, accessToken: string, userId: string, id: string) {
  return withRls(db, accessToken, async (tx) => {
    await tx.delete(savedPlans).where(and(eq(savedPlans.id, id), eq(savedPlans.userId, userId)))
  })
}

const listSavedPlansRoute = createRoute({
  method: 'get',
  path: '/saved-plans',
  operationId: 'listSavedPlans',
  summary: "List the current user's saved week plan templates",
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: 'Saved plan templates', content: { 'application/json': { schema: z.array(SavedPlanSchema) } } },
    401: { description: 'Missing or invalid session' },
  },
})

const upsertSavedPlanRoute = createRoute({
  method: 'post',
  path: '/saved-plans',
  operationId: 'upsertSavedPlan',
  summary: 'Create or replace a saved week plan template',
  security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: UpsertSavedPlanSchema } } } },
  responses: {
    200: { description: 'Saved plan persisted', content: { 'application/json': { schema: SavedPlanSchema } } },
    403: { description: 'Premium is required', content: { 'application/json': { schema: PremiumRequiredResponseSchema } } },
    401: { description: 'Missing or invalid session' },
  },
})

const renameSavedPlanRoute = createRoute({
  method: 'patch',
  path: '/saved-plans/{id}',
  operationId: 'renameSavedPlan',
  summary: 'Rename a saved week plan template',
  security: [{ bearerAuth: [] }],
  request: {
    params: SavedPlanParamsSchema,
    body: { content: { 'application/json': { schema: RenameSavedPlanSchema } } },
  },
  responses: {
    200: { description: 'Saved plan renamed', content: { 'application/json': { schema: SavedPlanSchema } } },
    401: { description: 'Missing or invalid session' },
    404: { description: 'Saved plan not found' },
  },
})

const deleteSavedPlanRoute = createRoute({
  method: 'delete',
  path: '/saved-plans/{id}',
  operationId: 'deleteSavedPlan',
  summary: 'Delete a saved week plan template',
  security: [{ bearerAuth: [] }],
  request: { params: SavedPlanParamsSchema },
  responses: {
    200: { description: 'Saved plan deleted, or was already absent', content: { 'application/json': { schema: OkResponseSchema } } },
    401: { description: 'Missing or invalid session' },
  },
})

export function buildSavedPlansRoutes(db: Db) {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()

  app.use('/saved-plans*', requireAuth)

  app.openapi(listSavedPlansRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const plans = await listSavedPlans(db, accessToken, user.id)
    return c.json(plans, 200)
  })

  app.openapi(upsertSavedPlanRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const body = c.req.valid('json')
    // Updating an existing template stays free; only a third distinct plan is
    // a future Premium boundary. This remains observational during beta.
    const existing = await listSavedPlans(db, accessToken, user.id)
    const usage = { limit: 2, current: existing.length }
    if (!existing.some((plan) => plan.id === body.id) && isPremiumLimitReached(usage)) {
      const entitlement = await resolveEntitlementForUser(db, user.id)
      const gate = await observePremiumGate(db, entitlement, { householdId: null, userId: user.id, reason: 'saved_plans_limit', usage })
      if (gate) return c.json(gate as never, 403)
    }
    const plan = await upsertSavedPlan(db, accessToken, user.id, body)
    if (!plan) return c.json({ error: 'CONFLICT' }, 409)
    return c.json(plan, 200)
  })

  app.openapi(renameSavedPlanRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { id } = c.req.valid('param')
    const { label } = c.req.valid('json')
    const plan = await renameSavedPlan(db, accessToken, user.id, id, label.trim())
    if (!plan) return c.json({ error: 'Saved plan not found' }, 404)
    return c.json(plan, 200)
  })

  app.openapi(deleteSavedPlanRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { id } = c.req.valid('param')
    await removeSavedPlan(db, accessToken, user.id, id)
    return c.json({ ok: true }, 200)
  })

  return app
}

export function buildInternalSavedPlansRoutes(db: Db) {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()

  app.use('/internal/*', requireInternalAuth)

  app.get('/internal/saved-plans', async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const plans = await listSavedPlans(db, accessToken, user.id)
    return c.json(plans)
  })

  app.post('/internal/saved-plans', async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const parsed = UpsertSavedPlanSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'Invalid payload' }, 400)
    const body = parsed.data
    await upsertSavedPlan(db, accessToken, user.id, body)
    return c.json({ ok: true })
  })

  app.patch('/internal/saved-plans/:id', async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const idParsed = z.string().uuid().safeParse(c.req.param('id'))
    if (!idParsed.success) return c.json({ error: 'Invalid id' }, 400)
    const id = idParsed.data
    const bodyParsed = RenameSavedPlanSchema.safeParse(await c.req.json().catch(() => null))
    if (!bodyParsed.success) return c.json({ error: 'Invalid payload' }, 400)
    const plan = await renameSavedPlan(db, accessToken, user.id, id, bodyParsed.data.label.trim())
    if (!plan) return c.json({ error: 'Saved plan not found' }, 404)
    return c.json({ ok: true })
  })

  app.delete('/internal/saved-plans/:id', async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const idParsed = z.string().uuid().safeParse(c.req.param('id'))
    if (!idParsed.success) return c.json({ error: 'Invalid id' }, 400)
    const id = idParsed.data
    await removeSavedPlan(db, accessToken, user.id, id)
    return c.json({ ok: true })
  })

  return app
}
