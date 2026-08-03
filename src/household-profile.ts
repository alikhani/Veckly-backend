import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, desc, eq } from 'drizzle-orm'
import { requireAuth, requireInternalAuth, type AuthedUser } from './auth.js'
import { assertMembership } from './membership.js'
import { withRls } from './rls.js'
import { householdMemberships, householdProfiles, householdRecipeRecommendations } from './schema.js'
import type { Db } from './db.js'

const PrioritySchema = z.enum(['quick', 'budget', 'child-friendly', 'meal-prep', 'varied'])
const WeekdaySchema = z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'])
const DaySelectionSchema = z.object({
  day: WeekdaySchema,
  servingsOverride: z.number().int().min(1).optional(),
  occasion: z.enum(['standard', 'guests', 'treat']).optional(),
  effortLevel: z.enum(['standard', 'busy']).optional(),
  leftoversIntent: z.boolean().optional(),
  lateEvening: z.boolean().optional(),
  cookingTolerance: z.enum(['standard', 'relaxed']).optional(),
})

const HouseholdProfileSchema = z.object({
  householdId: z.string().uuid(),
  adults: z.number().int().min(1),
  children: z.number().int().min(0),
  priorities: z.array(PrioritySchema),
  avoidIngredients: z.array(z.string()),
  selectedDays: z.array(DaySelectionSchema).min(1),
  updatedBy: z.string().uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).openapi('HouseholdProfile')

const UpsertHouseholdProfileSchema = HouseholdProfileSchema
  .pick({
    adults: true,
    children: true,
    priorities: true,
    avoidIngredients: true,
    selectedDays: true,
  })
  .openapi('UpsertHouseholdProfile')

const HouseholdParamsSchema = z.object({ householdId: z.string().uuid() })

function toProfileResponse(row: typeof householdProfiles.$inferSelect) {
  return {
    householdId: row.householdId,
    adults: row.adults,
    children: row.children,
    priorities: row.priorities as z.infer<typeof PrioritySchema>[],
    avoidIngredients: row.avoidIngredients as string[],
    selectedDays: row.selectedDays as z.infer<typeof DaySelectionSchema>[],
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export async function getHouseholdProfile(db: Db, accessToken: string, householdId: string) {
  return withRls(db, accessToken, async (tx) => {
    const [profile] = await tx
      .select()
      .from(householdProfiles)
      .where(eq(householdProfiles.householdId, householdId))
      .limit(1)
    return profile ? toProfileResponse(profile) : null
  })
}

export async function upsertHouseholdProfile(
  db: Db,
  accessToken: string,
  userId: string,
  householdId: string,
  input: z.infer<typeof UpsertHouseholdProfileSchema>,
) {
  return withRls(db, accessToken, async (tx) => {
    const now = new Date()
    const avoidIngredients = input.avoidIngredients
      .map((item) => item.trim())
      .filter((item) => item !== '')
    const [profile] = await tx
      .insert(householdProfiles)
      .values({
        householdId,
        adults: input.adults,
        children: input.children,
        priorities: input.priorities,
        avoidIngredients,
        selectedDays: input.selectedDays,
        updatedBy: userId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: householdProfiles.householdId,
        set: {
          adults: input.adults,
          children: input.children,
          priorities: input.priorities,
          avoidIngredients,
          selectedDays: input.selectedDays,
          updatedBy: userId,
          updatedAt: now,
        },
      })
      .returning()
    if (!profile) throw new Error('Upsert did not return the persisted household profile')
    // Recommendations encode the profile in both their ranking and reason.
    // Invalidate on every profile write so a changed avoid-list, household
    // size or priority cannot leave a week-old answer active.
    await tx
      .delete(householdRecipeRecommendations)
      .where(eq(householdRecipeRecommendations.householdId, householdId))
    return toProfileResponse(profile)
  })
}

const getHouseholdProfileRoute = createRoute({
  method: 'get',
  path: '/households/{householdId}/profile',
  operationId: 'getHouseholdProfile',
  summary: "Read a household's planning profile",
  security: [{ bearerAuth: [] }],
  request: { params: HouseholdParamsSchema },
  responses: {
    200: {
      description: 'The household profile, or null when no profile has been saved yet',
      content: { 'application/json': { schema: z.object({ profile: HouseholdProfileSchema.nullable() }) } },
    },
    401: { description: 'Missing or invalid session' },
  },
})

const upsertHouseholdProfileRoute = createRoute({
  method: 'put',
  path: '/households/{householdId}/profile',
  operationId: 'upsertHouseholdProfile',
  summary: "Create or update a household's planning profile",
  security: [{ bearerAuth: [] }],
  request: {
    params: HouseholdParamsSchema,
    body: { content: { 'application/json': { schema: UpsertHouseholdProfileSchema } } },
  },
  responses: {
    200: {
      description: 'The saved household profile',
      content: { 'application/json': { schema: HouseholdProfileSchema } },
    },
    401: { description: 'Missing or invalid session' },
  },
})

async function resolveUserHousehold(db: Db, accessToken: string, userId: string): Promise<string | null> {
  return withRls(db, accessToken, async (tx) => {
    const [row] = await tx
      .select({ householdId: householdMemberships.householdId })
      .from(householdMemberships)
      .where(and(eq(householdMemberships.userId, userId), eq(householdMemberships.status, 'active')))
      .orderBy(desc(householdMemberships.joinedAt))
      .limit(1)
    return row?.householdId ?? null
  })
}

export function buildInternalHouseholdProfileRoutes(db: Db) {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()
  app.use('/internal/*', requireInternalAuth)

  app.get('/internal/household-profile', async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const householdId = await resolveUserHousehold(db, accessToken, user.id)
    if (!householdId) return c.json(null, 200)
    const profile = await getHouseholdProfile(db, accessToken, householdId)
    return c.json(profile, 200)
  })

  app.put('/internal/household-profile', async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const body = await c.req.json().catch(() => null)
    if (!body) return c.json({ error: 'INVALID_PAYLOAD' }, 400)
    const householdId = await resolveUserHousehold(db, accessToken, user.id)
    if (!householdId) return c.json({ error: 'NO_HOUSEHOLD' }, 404)
    try {
      await upsertHouseholdProfile(db, accessToken, user.id, householdId, body)
      return c.json({ ok: true }, 200)
    } catch {
      return c.json({ error: 'UPSERT_FAILED' }, 500)
    }
  })

  return app
}

export function buildHouseholdProfileRoutes(db: Db) {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()

  app.use('/households/*', requireAuth)

  app.openapi(getHouseholdProfileRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId } = c.req.valid('param')
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' }, 404)
    const profile = await getHouseholdProfile(db, accessToken, householdId)
    c.header('Cache-Control', 'private, max-age=300')
    return c.json({ profile }, 200)
  })

  app.openapi(upsertHouseholdProfileRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId } = c.req.valid('param')
    const member = await assertMembership(db, accessToken, householdId, user.id)
    if (!member) return c.json({ error: 'NOT_MEMBER' }, 404)
    const body = c.req.valid('json')
    const profile = await upsertHouseholdProfile(db, accessToken, user.id, householdId, body)
    return c.json(profile, 200)
  })

  return app
}
