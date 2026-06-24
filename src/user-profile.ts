import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { eq } from 'drizzle-orm'
import { requireAuth, requireInternalAuth, type AuthedUser } from './auth.js'
import { withRls } from './rls.js'
import { userProfiles } from './schema.js'
import type { Db } from './db.js'

const UserProfileSchema = z.object({
  userId: z.string().uuid(),
  displayName: z.string(),
}).openapi('UserProfile')

const UpsertUserProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(60),
}).openapi('UpsertUserProfile')

function toProfileResponse(row: typeof userProfiles.$inferSelect) {
  return { userId: row.userId, displayName: row.displayName }
}

export async function getMyProfile(db: Db, accessToken: string, userId: string) {
  return withRls(db, accessToken, async (tx) => {
    const [profile] = await tx
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.userId, userId))
      .limit(1)
    return profile ? toProfileResponse(profile) : null
  })
}

export async function upsertMyProfile(db: Db, accessToken: string, userId: string, displayName: string) {
  return withRls(db, accessToken, async (tx) => {
    const now = new Date()
    const [profile] = await tx
      .insert(userProfiles)
      .values({ userId, displayName, updatedAt: now })
      .onConflictDoUpdate({
        target: userProfiles.userId,
        set: { displayName, updatedAt: now },
      })
      .returning()
    if (!profile) throw new Error('Upsert did not return the persisted user profile')
    return toProfileResponse(profile)
  })
}

const getMyProfileRoute = createRoute({
  method: 'get',
  path: '/users/me/profile',
  operationId: 'getMyProfile',
  summary: "Read the caller's own display-name profile",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'The profile, or null when no display name has been saved yet',
      content: { 'application/json': { schema: z.object({ profile: UserProfileSchema.nullable() }) } },
    },
    401: { description: 'Missing or invalid session' },
  },
})

const upsertMyProfileRoute = createRoute({
  method: 'put',
  path: '/users/me/profile',
  operationId: 'upsertMyProfile',
  summary: "Create or update the caller's own display name",
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: UpsertUserProfileSchema } } },
  },
  responses: {
    200: {
      description: 'The saved profile',
      content: { 'application/json': { schema: UserProfileSchema } },
    },
    401: { description: 'Missing or invalid session' },
  },
})

export function buildInternalUserProfileRoutes(db: Db) {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()
  app.use('/internal/*', requireInternalAuth)

  app.get('/internal/users/me/profile', async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const profile = await getMyProfile(db, accessToken, user.id)
    return c.json(profile, 200)
  })

  app.put('/internal/users/me/profile', async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const body = await c.req.json().catch(() => null)
    const displayName = typeof body?.displayName === 'string' ? body.displayName.trim() : ''
    if (!displayName) return c.json({ error: 'INVALID_PAYLOAD' }, 400)
    const profile = await upsertMyProfile(db, accessToken, user.id, displayName)
    return c.json(profile, 200)
  })

  return app
}

export function buildUserProfileRoutes(db: Db) {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()

  app.use('/users/*', requireAuth)

  app.openapi(getMyProfileRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const profile = await getMyProfile(db, accessToken, user.id)
    return c.json({ profile }, 200)
  })

  app.openapi(upsertMyProfileRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { displayName } = c.req.valid('json')
    const profile = await upsertMyProfile(db, accessToken, user.id, displayName)
    return c.json(profile, 200)
  })

  return app
}
