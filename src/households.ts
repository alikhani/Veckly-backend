import { randomUUID } from 'node:crypto'
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, eq } from 'drizzle-orm'
import { requireAuth, requireInternalAuth, type AuthedUser } from './auth.js'
import { withRls } from './rls.js'
import { households, householdMemberships } from './schema.js'
import type { Db } from './db.js'

function parseHouseholdName(raw: unknown): string | null {
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : ''
  return name.length >= 2 && name.length <= 60 ? name : null
}

const HouseholdSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  role: z.enum(['owner', 'member']),
}).openapi('Household')

const MyHouseholdsResponseSchema = z.object({
  households: z.array(HouseholdSchema),
}).openapi('MyHouseholdsResponse')

const getMyHouseholds = createRoute({
  method: 'get',
  path: '/households/me',
  operationId: 'getMyHouseholds',
  summary: "List the households the authenticated user belongs to",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Households the authenticated user has an active membership in',
      content: { 'application/json': { schema: MyHouseholdsResponseSchema } },
    },
    401: { description: 'Missing or invalid session' },
  },
})

const RenameHouseholdResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
}).openapi('RenameHouseholdResponse')

const HouseholdMemberSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(['owner', 'member']),
}).openapi('HouseholdMember')

const ListHouseholdMembersResponseSchema = z.object({
  members: z.array(HouseholdMemberSchema),
}).openapi('ListHouseholdMembersResponse')

const UpdateHouseholdMemberRoleRequestSchema = z.object({
  role: z.enum(['owner', 'member']),
}).openapi('UpdateHouseholdMemberRoleRequest')

const renameHouseholdRoute = createRoute({
  method: 'patch',
  path: '/households/{id}',
  operationId: 'renameHousehold',
  summary: 'Rename a household (owner only)',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: { 'application/json': { schema: z.object({ name: z.string() }) } },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Household renamed',
      content: { 'application/json': { schema: RenameHouseholdResponseSchema } },
    },
    400: { description: 'Invalid household name' },
    401: { description: 'Missing or invalid session' },
    403: { description: 'Caller is not the household owner' },
    404: { description: 'Household not found or caller is not a member' },
  },
})

const bootstrapMyHousehold = createRoute({
  method: 'post',
  path: '/households/me/bootstrap',
  operationId: 'bootstrapMyHousehold',
  summary: 'Ensure the authenticated user has a household, creating "My household" if they have none',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Returned the household the user already belonged to — nothing created',
      content: { 'application/json': { schema: HouseholdSchema } },
    },
    201: {
      description: 'Created "My household" with the caller as owner',
      content: { 'application/json': { schema: HouseholdSchema } },
    },
    401: { description: 'Missing or invalid session' },
  },
})

const listHouseholdMembersRoute = createRoute({
  method: 'get',
  path: '/households/{householdId}/members',
  operationId: 'listHouseholdMembers',
  summary: "List a household's active members",
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ householdId: z.string().uuid() }) },
  responses: {
    200: {
      description: 'Active household members',
      content: { 'application/json': { schema: ListHouseholdMembersResponseSchema } },
    },
    401: { description: 'Missing or invalid session' },
  },
})

const updateHouseholdMemberRoleRoute = createRoute({
  method: 'patch',
  path: '/households/{householdId}/members/{userId}',
  operationId: 'updateHouseholdMemberRole',
  summary: "Update a household member's role",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ householdId: z.string().uuid(), userId: z.string().uuid() }),
    body: { content: { 'application/json': { schema: UpdateHouseholdMemberRoleRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Updated household member',
      content: { 'application/json': { schema: HouseholdMemberSchema } },
    },
    400: { description: 'Invalid role' },
    401: { description: 'Missing or invalid session' },
    404: { description: 'Member not found or caller cannot see this household' },
    409: { description: 'Cannot remove the last owner role' },
  },
})

const removeHouseholdMemberRoute = createRoute({
  method: 'delete',
  path: '/households/{householdId}/members/{userId}',
  operationId: 'removeHouseholdMember',
  summary: 'Remove a household member',
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ householdId: z.string().uuid(), userId: z.string().uuid() }) },
  responses: {
    204: { description: 'Member removed' },
    401: { description: 'Missing or invalid session' },
    404: { description: 'Member not found or caller cannot see this household' },
    409: { description: 'Cannot remove the last owner' },
  },
})

// Supabase Auth has no equivalent of Better Auth's `databaseHooks.user.create.after`
// (the hook MealPlanner uses to give every new user a household for free) — so
// the client calls this once, right after signup, to restore that invariant.
// `userId` is taken explicitly rather than derived from `auth.uid()` inside the
// query, because an INSERT's `values()` needs the literal value — but a forged
// `userId` is still independently re-checked by the `user_id = auth.uid()`
// clause in `memberships_insert_self_as_owner_for_new_household` (0004), so the
// database remains the actual boundary, not this function's argument list.
export async function bootstrapHousehold(db: Db, accessToken: string, userId: string) {
  return withRls(db, accessToken, async (tx) => {
    const [existing] = await tx
      .select({ id: households.id, name: households.name, role: householdMemberships.role })
      .from(householdMemberships)
      .innerJoin(households, eq(households.id, householdMemberships.householdId))
      .where(and(eq(householdMemberships.userId, userId), eq(householdMemberships.status, 'active')))
      .limit(1)

    if (existing) return { household: existing, created: false }

    // The household id is generated here, in code, rather than read back via
    // `.returning()` — Postgres checks RETURNING rows against the table's
    // SELECT policies, and `households_select_via_active_membership` (0001)
    // requires an active membership that doesn't exist yet at this exact
    // instant. `.returning()` here would fail with "new row violates
    // row-level security policy", the chicken-and-egg problem surfacing one
    // layer below the policy that was written to solve it. The membership
    // insert's `.returning()` is fine: `memberships_select_own` checks
    // `user_id = auth.uid()`, which the caller's own new row satisfies
    // immediately.
    const householdName = 'My household'
    const householdId = randomUUID()
    await tx.insert(households).values({ id: householdId, name: householdName })

    const [membership] = await tx
      .insert(householdMemberships)
      .values({ householdId, userId, role: 'owner', status: 'active' })
      .returning()
    if (!membership) throw new Error('Insert did not return the persisted membership')

    return { household: { id: householdId, name: householdName, role: membership.role }, created: true }
  })
}

export async function renameHousehold(db: Db, accessToken: string, householdId: string, name: string) {
  return withRls(db, accessToken, async (tx) => {
    const [updated] = await tx
      .update(households)
      .set({ name })
      .where(eq(households.id, householdId))
      .returning({ id: households.id, name: households.name })
    return updated ?? null
  })
}

export async function createNamedHousehold(db: Db, accessToken: string, userId: string, name: string) {
  return withRls(db, accessToken, async (tx) => {
    // Same pattern as bootstrapHousehold: generate the id upfront rather than
    // reading it back via .returning() because the SELECT policy on `households`
    // requires an active membership that doesn't exist yet at insert time.
    const householdId = randomUUID()
    await tx.insert(households).values({ id: householdId, name })
    const [membership] = await tx
      .insert(householdMemberships)
      .values({ householdId, userId, role: 'owner', status: 'active' })
      .returning()
    if (!membership) throw new Error('Insert did not return the persisted membership')
    return { id: householdId, name, role: membership.role }
  })
}

export async function listHouseholdMembers(db: Db, accessToken: string, householdId: string) {
  return withRls(db, accessToken, (tx) =>
    tx
      .select({ userId: householdMemberships.userId, role: householdMemberships.role })
      .from(householdMemberships)
      .where(and(eq(householdMemberships.householdId, householdId), eq(householdMemberships.status, 'active')))
      .orderBy(householdMemberships.joinedAt),
  )
}

// Sets the target member's status to 'removed'. Returns a typed outcome rather
// than throwing so the caller can map errors to HTTP status codes without a
// try/catch. LAST_OWNER is checked in code before the UPDATE — see the
// migration 0012 comment for why that invariant lives here instead of in RLS.
export async function removeMember(
  db: Db,
  accessToken: string,
  householdId: string,
  targetUserId: string,
): Promise<{ outcome: 'removed' } | { outcome: 'not_found' } | { outcome: 'last_owner' }> {
  return withRls(db, accessToken, async (tx) => {
    const [target] = await tx
      .select({ role: householdMemberships.role, status: householdMemberships.status })
      .from(householdMemberships)
      .where(and(eq(householdMemberships.householdId, householdId), eq(householdMemberships.userId, targetUserId)))
      .limit(1)

    if (!target || target.status !== 'active') return { outcome: 'not_found' as const }

    if (target.role === 'owner') {
      const owners = await tx
        .select({ id: householdMemberships.id })
        .from(householdMemberships)
        .where(
          and(
            eq(householdMemberships.householdId, householdId),
            eq(householdMemberships.role, 'owner'),
            eq(householdMemberships.status, 'active'),
          ),
        )
      if (owners.length <= 1) return { outcome: 'last_owner' as const }
    }

    await tx
      .update(householdMemberships)
      .set({ status: 'removed' })
      .where(and(eq(householdMemberships.householdId, householdId), eq(householdMemberships.userId, targetUserId)))

    return { outcome: 'removed' as const }
  })
}

// Changes a member's role. Returns a typed outcome so the caller can map
// errors to HTTP status codes without a try/catch. LAST_OWNER is checked in
// code (not RLS) for the same reasons stated in removeMember above.
export async function updateMemberRole(
  db: Db,
  accessToken: string,
  householdId: string,
  targetUserId: string,
  role: 'owner' | 'member',
): Promise<{ outcome: 'updated'; role: 'owner' | 'member' } | { outcome: 'not_found' } | { outcome: 'last_owner' }> {
  return withRls(db, accessToken, async (tx) => {
    const [target] = await tx
      .select({ role: householdMemberships.role, status: householdMemberships.status })
      .from(householdMemberships)
      .where(and(eq(householdMemberships.householdId, householdId), eq(householdMemberships.userId, targetUserId)))
      .limit(1)

    if (!target || target.status !== 'active') return { outcome: 'not_found' as const }

    if (target.role === 'owner' && role === 'member') {
      const owners = await tx
        .select({ id: householdMemberships.id })
        .from(householdMemberships)
        .where(
          and(
            eq(householdMemberships.householdId, householdId),
            eq(householdMemberships.role, 'owner'),
            eq(householdMemberships.status, 'active'),
          ),
        )
      if (owners.length <= 1) return { outcome: 'last_owner' as const }
    }

    await tx
      .update(householdMemberships)
      .set({ role })
      .where(and(eq(householdMemberships.householdId, householdId), eq(householdMemberships.userId, targetUserId)))

    return { outcome: 'updated' as const, role }
  })
}

// Internal server-to-server routes — not in the public OpenAPI spec, not
// meant for direct client use. MealPlanner proxies through these during the
// strangle phase; they get retired once the web frontend calls the backend
// directly with its own auth tokens.
export function buildInternalHouseholdsRoutes(db: Db) {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()

  app.use('/internal/*', requireInternalAuth)

  app.post('/internal/households/me/bootstrap', async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { household, created } = await bootstrapHousehold(db, accessToken, user.id)
    return c.json({ id: household.id, name: household.name, role: household.role }, created ? 201 : 200)
  })

  // Ensures the user has a household (bootstraps if missing), then returns the
  // full list. Mirrors MealPlanner's ensurePersonalHousehold + listHouseholdsForUser
  // semantics so the proxy can replace the old bootstrap-and-wrap hack.
  app.get('/internal/households/me', async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    await bootstrapHousehold(db, accessToken, user.id)
    const rows = await listHouseholdsForUser(db, accessToken)
    return c.json(rows.map((r) => ({ id: r.id, name: r.name, role: r.role })))
  })

  app.post('/internal/households', async (c) => {
    const body = await c.req.json().catch(() => null)
    const name = parseHouseholdName(body?.name)
    if (!name) return c.json({ error: 'INVALID_HOUSEHOLD_NAME' }, 400)
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const household = await createNamedHousehold(db, accessToken, user.id, name)
    return c.json({ id: household.id, name: household.name, role: household.role }, 201)
  })

  app.patch('/internal/households/:id', async (c) => {
    const body = await c.req.json().catch(() => null)
    const name = parseHouseholdName(body?.name)
    if (!name) return c.json({ error: 'INVALID_HOUSEHOLD_NAME' }, 400)
    const accessToken = c.get('accessToken')
    const householdId = c.req.param('id')
    const result = await renameHousehold(db, accessToken, householdId, name)
    if (!result) return c.json({ error: 'Household not found.' }, 404)
    return c.json({ id: result.id, name: result.name }, 200)
  })

  app.get('/internal/households/:householdId/members', async (c) => {
    const accessToken = c.get('accessToken')
    const householdId = c.req.param('householdId')
    const members = await listHouseholdMembers(db, accessToken, householdId)
    return c.json(members.map((m) => ({ userId: m.userId, role: m.role })))
  })

  app.delete('/internal/households/:householdId/members/:userId', async (c) => {
    const accessToken = c.get('accessToken')
    const householdId = c.req.param('householdId')
    const targetUserId = c.req.param('userId')
    const result = await removeMember(db, accessToken, householdId, targetUserId)
    if (result.outcome === 'not_found') return c.json({ error: 'MEMBER_NOT_FOUND' }, 404)
    if (result.outcome === 'last_owner') return c.json({ error: 'LAST_OWNER' }, 409)
    return c.body(null, 204)
  })

  app.patch('/internal/households/:householdId/members/:userId', async (c) => {
    const accessToken = c.get('accessToken')
    const householdId = c.req.param('householdId')
    const targetUserId = c.req.param('userId')
    const body = await c.req.json().catch(() => ({}))
    const role = body.role === 'owner' || body.role === 'member' ? (body.role as 'owner' | 'member') : null
    if (!role) return c.json({ error: 'INVALID_ROLE' }, 400)
    const result = await updateMemberRole(db, accessToken, householdId, targetUserId, role)
    if (result.outcome === 'not_found') return c.json({ error: 'MEMBER_NOT_FOUND' }, 404)
    if (result.outcome === 'last_owner') return c.json({ error: 'LAST_OWNER' }, 409)
    return c.json({ userId: targetUserId, role: result.role }, 200)
  })

  return app
}

// Plain select scoped only by `auth.uid()` via RLS — no `where userId = ...`
// here. That's the point: even if this query were written wrong (or a future
// route forgot to scope it), the database would still only return rows this
// user is allowed to see.
export async function listHouseholdsForUser(db: Db, accessToken: string) {
  return withRls(db, accessToken, (tx) =>
    tx
      .select({ id: households.id, name: households.name, role: householdMemberships.role })
      .from(householdMemberships)
      .innerJoin(households, eq(households.id, householdMemberships.householdId))
      .where(eq(householdMemberships.status, 'active')),
  )
}

export function buildHouseholdsRoutes(db: Db) {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()

  app.use('/households/*', requireAuth)

  app.openapi(getMyHouseholds, async (c) => {
    const accessToken = c.get('accessToken')
    const rows = await listHouseholdsForUser(db, accessToken)
    return c.json({ households: rows.map((row) => ({ id: row.id, name: row.name, role: row.role })) }, 200)
  })

  app.openapi(bootstrapMyHousehold, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')

    const { household, created } = await bootstrapHousehold(db, accessToken, user.id)

    return c.json({ id: household.id, name: household.name, role: household.role }, created ? 201 : 200)
  })

  app.openapi(renameHouseholdRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { id: householdId } = c.req.valid('param')
    const { name: rawName } = c.req.valid('json')

    const name = parseHouseholdName(rawName)
    if (!name) return c.json({ error: 'INVALID_HOUSEHOLD_NAME' } as never, 400)

    // Check membership role before attempting the update so non-owner members
    // get a 403 rather than a silent 0-row update that would map to 404.
    const [membership] = await withRls(db, accessToken, (tx) =>
      tx
        .select({ role: householdMemberships.role })
        .from(householdMemberships)
        .where(
          and(
            eq(householdMemberships.householdId, householdId),
            eq(householdMemberships.userId, user.id),
            eq(householdMemberships.status, 'active'),
          ),
        )
        .limit(1),
    )

    if (!membership) return c.json({ error: 'Household not found.' } as never, 404)
    if (membership.role !== 'owner') return c.json({ error: 'FORBIDDEN' } as never, 403)

    const result = await renameHousehold(db, accessToken, householdId, name)
    if (!result) return c.json({ error: 'Household not found.' } as never, 404)
    return c.json({ id: result.id, name: result.name }, 200)
  })

  app.openapi(listHouseholdMembersRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const { householdId } = c.req.valid('param')
    const members = await listHouseholdMembers(db, accessToken, householdId)
    c.header('Cache-Control', 'private, max-age=300')
    return c.json({ members }, 200)
  })

  app.openapi(updateHouseholdMemberRoleRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const { householdId, userId } = c.req.valid('param')
    const { role } = c.req.valid('json')
    const result = await updateMemberRole(db, accessToken, householdId, userId, role)
    if (result.outcome === 'not_found') return c.json({ error: 'MEMBER_NOT_FOUND' } as never, 404)
    if (result.outcome === 'last_owner') return c.json({ error: 'LAST_OWNER' } as never, 409)
    return c.json({ userId, role: result.role }, 200)
  })

  app.openapi(removeHouseholdMemberRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const { householdId, userId } = c.req.valid('param')
    const result = await removeMember(db, accessToken, householdId, userId)
    if (result.outcome === 'not_found') return c.json({ error: 'MEMBER_NOT_FOUND' } as never, 404)
    if (result.outcome === 'last_owner') return c.json({ error: 'LAST_OWNER' } as never, 409)
    return c.body(null, 204)
  })

  return app
}
