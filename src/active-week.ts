import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { eq } from 'drizzle-orm'
import { requireAuth, type AuthedUser } from './auth.js'
import { withRls } from './rls.js'
import { householdActiveWeeks } from './schema.js'
import type { Db } from './db.js'

const HouseholdParamsSchema = z.object({ householdId: z.string().uuid() })

const ActiveWeekSchema = z.object({
  householdId: z.string().uuid(),
  weekStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: z.string().min(1),
  updatedBy: z.string().uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).openapi('HouseholdActiveWeek')

const SetActiveWeekSchema = z.object({
  weekStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: z.string().min(1),
}).openapi('SetHouseholdActiveWeek')

function toActiveWeekResponse(row: typeof householdActiveWeeks.$inferSelect) {
  return {
    householdId: row.householdId,
    weekStartDate: row.weekStartDate,
    timezone: row.timezone,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export async function getActiveWeek(db: Db, accessToken: string, householdId: string) {
  return withRls(db, accessToken, async (tx) => {
    const [activeWeek] = await tx
      .select()
      .from(householdActiveWeeks)
      .where(eq(householdActiveWeeks.householdId, householdId))
      .limit(1)
    return activeWeek ? toActiveWeekResponse(activeWeek) : null
  })
}

export async function setActiveWeek(
  db: Db,
  accessToken: string,
  userId: string,
  householdId: string,
  input: z.infer<typeof SetActiveWeekSchema>,
) {
  return withRls(db, accessToken, async (tx) => {
    const now = new Date()
    const [activeWeek] = await tx
      .insert(householdActiveWeeks)
      .values({
        householdId,
        weekStartDate: input.weekStartDate,
        timezone: input.timezone,
        updatedBy: userId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: householdActiveWeeks.householdId,
        set: {
          weekStartDate: input.weekStartDate,
          timezone: input.timezone,
          updatedBy: userId,
          updatedAt: now,
        },
      })
      .returning()
    if (!activeWeek) throw new Error('Upsert did not return the persisted active week')
    return toActiveWeekResponse(activeWeek)
  })
}

export async function clearActiveWeek(db: Db, accessToken: string, householdId: string) {
  return withRls(db, accessToken, async (tx) => {
    const deleted = await tx
      .delete(householdActiveWeeks)
      .where(eq(householdActiveWeeks.householdId, householdId))
      .returning({ householdId: householdActiveWeeks.householdId })
    return deleted.length > 0
  })
}

const getActiveWeekRoute = createRoute({
  method: 'get',
  path: '/households/{householdId}/active-week',
  operationId: 'getHouseholdActiveWeek',
  summary: "Read a household's active week pointer",
  security: [{ bearerAuth: [] }],
  request: { params: HouseholdParamsSchema },
  responses: {
    200: {
      description: 'The active week pointer, or null when unset',
      content: { 'application/json': { schema: z.object({ activeWeek: ActiveWeekSchema.nullable() }) } },
    },
    401: { description: 'Missing or invalid session' },
  },
})

const setActiveWeekRoute = createRoute({
  method: 'put',
  path: '/households/{householdId}/active-week',
  operationId: 'setHouseholdActiveWeek',
  summary: "Set a household's active week pointer",
  security: [{ bearerAuth: [] }],
  request: {
    params: HouseholdParamsSchema,
    body: { content: { 'application/json': { schema: SetActiveWeekSchema } } },
  },
  responses: {
    200: {
      description: 'The saved active week pointer',
      content: { 'application/json': { schema: ActiveWeekSchema } },
    },
    401: { description: 'Missing or invalid session' },
  },
})

const clearActiveWeekRoute = createRoute({
  method: 'delete',
  path: '/households/{householdId}/active-week',
  operationId: 'clearHouseholdActiveWeek',
  summary: "Clear a household's active week pointer",
  security: [{ bearerAuth: [] }],
  request: { params: HouseholdParamsSchema },
  responses: {
    204: { description: 'Active week cleared, or already unset' },
    401: { description: 'Missing or invalid session' },
  },
})

export function buildActiveWeekRoutes(db: Db) {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()

  app.use('/households/*', requireAuth)

  app.openapi(getActiveWeekRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const { householdId } = c.req.valid('param')
    const activeWeek = await getActiveWeek(db, accessToken, householdId)
    return c.json({ activeWeek }, 200)
  })

  app.openapi(setActiveWeekRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId } = c.req.valid('param')
    const body = c.req.valid('json')
    const activeWeek = await setActiveWeek(db, accessToken, user.id, householdId, body)
    return c.json(activeWeek, 200)
  })

  app.openapi(clearActiveWeekRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const { householdId } = c.req.valid('param')
    await clearActiveWeek(db, accessToken, householdId)
    return c.body(null, 204)
  })

  return app
}
