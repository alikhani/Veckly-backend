import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { eq } from 'drizzle-orm'
import { requireAuth, type AuthedUser } from './auth.js'
import { withRls } from './rls.js'
import { householdProfiles } from './schema.js'
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
    const [profile] = await tx
      .insert(householdProfiles)
      .values({
        householdId,
        adults: input.adults,
        children: input.children,
        priorities: input.priorities,
        avoidIngredients: input.avoidIngredients,
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
          avoidIngredients: input.avoidIngredients,
          selectedDays: input.selectedDays,
          updatedBy: userId,
          updatedAt: now,
        },
      })
      .returning()
    if (!profile) throw new Error('Upsert did not return the persisted household profile')
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

export function buildHouseholdProfileRoutes(db: Db) {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()

  app.use('/households/*', requireAuth)

  app.openapi(getHouseholdProfileRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const { householdId } = c.req.valid('param')
    const profile = await getHouseholdProfile(db, accessToken, householdId)
    return c.json({ profile }, 200)
  })

  app.openapi(upsertHouseholdProfileRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId } = c.req.valid('param')
    const body = c.req.valid('json')
    const profile = await upsertHouseholdProfile(db, accessToken, user.id, householdId, body)
    return c.json(profile, 200)
  })

  return app
}
