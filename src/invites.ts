import { randomUUID } from 'node:crypto'
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, eq, gt } from 'drizzle-orm'
import { requireAuth, requireInternalAuth, type AuthedUser } from './auth.js'
import { withRls, withRlsAndToken } from './rls.js'
import { households, householdInvites, householdMemberships } from './schema.js'
import type { Db } from './db.js'

const InviteSchema = z.object({
  id: z.string().uuid(),
  householdId: z.string().uuid(),
  token: z.string(),
  email: z.string().email().nullable(),
  status: z.enum(['pending', 'accepted', 'revoked', 'expired']),
  expiresAt: z.string(),
  createdAt: z.string(),
}).openapi('HouseholdInvite')

const InviteListResponseSchema = z.object({
  invites: z.array(InviteSchema),
}).openapi('HouseholdInviteListResponse')

const CreateInviteRequestSchema = z.object({
  email: z.string().email().optional(),
}).openapi('CreateHouseholdInviteRequest')

const InviteLandingSchema = z.object({
  householdName: z.string(),
  status: z.enum(['pending', 'accepted', 'revoked', 'expired']),
  expiresAt: z.string(),
}).openapi('HouseholdInviteLanding')

const HouseholdParamsSchema = z.object({
  householdId: z.string().uuid(),
})

const InviteIdParamsSchema = z.object({
  householdId: z.string().uuid(),
  inviteId: z.string().uuid(),
})

const TokenParamsSchema = z.object({
  token: z.string(),
})

function serializeInvite(invite: typeof householdInvites.$inferSelect) {
  return {
    id: invite.id,
    householdId: invite.householdId,
    token: invite.token,
    email: invite.email,
    status: invite.status,
    expiresAt: invite.expiresAt.toISOString(),
    createdAt: invite.createdAt.toISOString(),
  }
}

// Token shape mirrors MealPlanner's `crypto.randomUUID().replaceAll('-', '')`
// (`household-invite-repository.ts`) — a 32-char hex string. Simple,
// collision-resistant, URL-safe with no encoding concerns; no reason to
// re-derive a different shape for the same job.
function generateInviteToken(): string {
  return randomUUID().replaceAll('-', '')
}

// Active member invites someone into their household. The invite id and token
// are generated here, in code — same reasoning as `bootstrapHousehold`'s
// client-side `householdId`, but for the OPPOSITE conclusion: there, a fresh
// row's own SELECT policy couldn't yet see it (the chicken-and-egg gap 0004
// closes), so `.returning()` would fail. Here, the creator is *already* an
// active member of the household they're inviting into — unlike 0004's
// brand-new-household case — so `invites_select_via_active_membership` covers
// the immediate read-back and `.returning()` is safe and simplest. Generating
// the token client-side either way is necessary regardless: it's the secret
// being handed to the recipient, not a value the database should originate.
export async function createInvite(
  db: Db,
  accessToken: string,
  userId: string,
  householdId: string,
  options?: { email?: string; expiresInDays?: number },
) {
  const expiresInDays = options?.expiresInDays ?? 7
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)

  return withRls(db, accessToken, async (tx) => {
    const [invite] = await tx
      .insert(householdInvites)
      .values({
        id: randomUUID(),
        householdId,
        token: generateInviteToken(),
        email: options?.email ?? null,
        createdBy: userId,
        expiresAt,
      })
      .returning()
    if (!invite) throw new Error('Insert did not return the persisted invite')

    return invite
  })
}

// Looks up exactly one invite by token — the "should I accept this?" preview.
// Deliberately requires a session (unlike MealPlanner's public landing page,
// which runs through a trusted Next.js server context with no RLS concern):
// every query in this backend goes through `withRls`/`withRlsAndToken`, and
// making this one path callable by the `anon` role would be a genuinely new
// security shape — the kind that deserves its own careful live-test, not a
// rider on this slice. Requiring sign-in first is a real, if imperfect, UX
// trade — the simplest correct shape this slice can ship; revisit if it
// visibly costs real conversions once the product has real signal to weigh it
// against (the same "don't build for problems you don't have yet" principle
// that deferred the expiry-sweep mechanism below).
export async function getInviteByToken(db: Db, accessToken: string, token: string) {
  return withRlsAndToken(db, accessToken, token, async (tx) => {
    const [row] = await tx
      .select({ householdName: households.name, status: householdInvites.status, expiresAt: householdInvites.expiresAt })
      .from(householdInvites)
      .innerJoin(households, eq(households.id, householdInvites.householdId))
      .where(eq(householdInvites.token, token))
      .limit(1)

    if (!row) return null

    return { householdName: row.householdName, status: row.status, expiresAt: row.expiresAt.toISOString() }
  })
}

// Accepts an invite: flips its status pending -> accepted AND inserts the
// caller as an active `member` — atomically, in one `withRlsAndToken`
// transaction. Order is deliberate, not incidental: the invite UPDATE runs
// first, so by the time the membership INSERT's `with check` evaluates
// `memberships_insert_self_as_member_via_invite` (0006), it sees a row already
// in the 'accepted' state — but that policy accepts EITHER 'pending' or
// 'accepted' specifically so this ordering is a deliberate choice, not a
// constraint the policy silently imposes (see the migration's comment on that
// clause for the full reasoning).
//
// Checks "is there already an active membership" first — mirroring
// `bootstrapHousehold`'s "check existing, then act" shape rather than
// attempting the insert and catching a unique-constraint error. This makes
// double-accept a clean, observable no-op (matches MealPlanner's
// `acceptHouseholdInvite`: "if already accepted, just return the household —
// don't error") instead of a caught-exception code path.
export async function acceptInvite(db: Db, accessToken: string, userId: string, token: string) {
  return withRlsAndToken(db, accessToken, token, async (tx) => {
    const [invite] = await tx.select().from(householdInvites).where(eq(householdInvites.token, token)).limit(1)
    if (!invite) return { outcome: 'not_found' as const }

    const [existingMembership] = await tx
      .select({ id: householdMemberships.id })
      .from(householdMemberships)
      .where(and(eq(householdMemberships.householdId, invite.householdId), eq(householdMemberships.userId, userId), eq(householdMemberships.status, 'active')))
      .limit(1)
    if (existingMembership) return { outcome: 'already_member' as const, householdId: invite.householdId }

    if (invite.status !== 'pending') return { outcome: 'not_acceptable' as const, status: invite.status }
    if (invite.expiresAt.getTime() <= Date.now()) return { outcome: 'expired' as const }

    const now = new Date()
    await tx
      .update(householdInvites)
      .set({ status: 'accepted', acceptedBy: userId, acceptedAt: now })
      .where(eq(householdInvites.token, token))

    await tx.insert(householdMemberships).values({ householdId: invite.householdId, userId, role: 'member', status: 'active' })

    return { outcome: 'accepted' as const, householdId: invite.householdId }
  })
}

// Active members' view of their household's open invites.
export async function listPendingInvites(db: Db, accessToken: string, householdId: string) {
  return withRls(db, accessToken, (tx) =>
    tx
      .select()
      .from(householdInvites)
      .where(and(eq(householdInvites.householdId, householdId), eq(householdInvites.status, 'pending'), gt(householdInvites.expiresAt, new Date())))
      .orderBy(householdInvites.createdAt),
  )
}

// Active members may revoke their own household's still-pending invites — the
// RLS policy (`invites_update_revoke_via_active_membership`) is the actual
// boundary; this just issues the UPDATE and reports whether a row changed
// (zero rows = "wasn't pending, wasn't yours, or didn't exist" — all three
// collapse to the same observable outcome by design, the same way RLS makes
// "can't see it" and "doesn't exist" indistinguishable elsewhere).
export async function revokeInvite(db: Db, accessToken: string, householdId: string, inviteId: string) {
  return withRls(db, accessToken, async (tx) => {
    const result = await tx
      .update(householdInvites)
      .set({ status: 'revoked' })
      .where(and(eq(householdInvites.id, inviteId), eq(householdInvites.householdId, householdId)))
      .returning({ id: householdInvites.id })

    return { revoked: result.length > 0 }
  })
}

// Token-based revoke: MealPlanner's client uses the invite token (not the UUID)
// as the URL segment. The WHERE includes householdId for defense-in-depth even
// though RLS already enforces that only active members of the household can
// update its invites.
export async function revokeInviteByToken(db: Db, accessToken: string, householdId: string, token: string) {
  return withRls(db, accessToken, async (tx) => {
    const result = await tx
      .update(householdInvites)
      .set({ status: 'revoked' })
      .where(and(eq(householdInvites.token, token), eq(householdInvites.householdId, householdId)))
      .returning({ id: householdInvites.id })
    return { revoked: result.length > 0 }
  })
}

const createInviteRoute = createRoute({
  method: 'post',
  path: '/households/{householdId}/invites',
  operationId: 'createHouseholdInvite',
  summary: 'Invite someone to join this household',
  security: [{ bearerAuth: [] }],
  request: {
    params: HouseholdParamsSchema,
    body: { content: { 'application/json': { schema: CreateInviteRequestSchema } } },
  },
  responses: {
    201: { description: 'The created invite, including its shareable token', content: { 'application/json': { schema: InviteSchema } } },
    401: { description: 'Missing or invalid session' },
  },
})

const listInvitesRoute = createRoute({
  method: 'get',
  path: '/households/{householdId}/invites',
  operationId: 'listHouseholdInvites',
  summary: "List a household's open (pending) invites",
  security: [{ bearerAuth: [] }],
  request: { params: HouseholdParamsSchema },
  responses: {
    200: { description: 'Open invites for this household', content: { 'application/json': { schema: InviteListResponseSchema } } },
    401: { description: 'Missing or invalid session' },
  },
})

const revokeInviteRoute = createRoute({
  method: 'delete',
  path: '/households/{householdId}/invites/{inviteId}',
  operationId: 'revokeHouseholdInvite',
  summary: 'Revoke a pending invite',
  security: [{ bearerAuth: [] }],
  request: { params: InviteIdParamsSchema },
  responses: {
    204: { description: 'Revoked (or already not pending/visible — same observable outcome)' },
    401: { description: 'Missing or invalid session' },
  },
})

const getInviteLandingRoute = createRoute({
  method: 'get',
  path: '/invites/{token}',
  operationId: 'getInviteLanding',
  summary: 'Preview an invite before deciding whether to accept it',
  security: [{ bearerAuth: [] }],
  request: { params: TokenParamsSchema },
  responses: {
    200: { description: 'The invite is visible to this token holder', content: { 'application/json': { schema: InviteLandingSchema } } },
    404: { description: 'No invite exists for this token' },
    401: { description: 'Missing or invalid session' },
  },
})

const acceptInviteRoute = createRoute({
  method: 'post',
  path: '/invites/{token}/accept',
  operationId: 'acceptInvite',
  summary: 'Accept an invite, joining its household as a member',
  security: [{ bearerAuth: [] }],
  request: { params: TokenParamsSchema },
  responses: {
    200: { description: 'Joined the household (or already a member — idempotent)', content: { 'application/json': { schema: z.object({ householdId: z.string().uuid() }) } } },
    404: { description: 'No invite exists for this token' },
    409: { description: 'Invite is no longer acceptable (revoked, expired, or already used by someone else)' },
    401: { description: 'Missing or invalid session' },
  },
})

// Internal server-to-server routes for MealPlanner during the strangle phase.
// The email-sending step stays in MealPlanner (it owns Resend); this module
// only handles the database write and read. Retired once the frontend calls
// the backend directly with its own auth tokens.
export function buildInternalInvitesRoutes(db: Db) {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()

  app.use('/internal/*', requireInternalAuth)

  app.post('/internal/households/:householdId/invites', async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const householdId = c.req.param('householdId')
    const body = await c.req.json().catch(() => ({}))
    const email = typeof body.email === 'string' && body.email ? body.email : undefined
    const invite = await createInvite(db, accessToken, user.id, householdId, { email })
    return c.json({
      id: invite.id,
      token: invite.token,
      householdId: invite.householdId,
      email: invite.email,
      expiresAt: invite.expiresAt.toISOString(),
    }, 201)
  })

  app.get('/internal/households/:householdId/invites', async (c) => {
    const accessToken = c.get('accessToken')
    const householdId = c.req.param('householdId')
    const invites = await listPendingInvites(db, accessToken, householdId)
    return c.json(invites.map((invite) => ({
      id: invite.id,
      token: invite.token,
      email: invite.email,
      expiresAt: invite.expiresAt.toISOString(),
      createdAt: invite.createdAt.toISOString(),
    })))
  })

  app.delete('/internal/households/:householdId/invites/by-token/:token', async (c) => {
    const accessToken = c.get('accessToken')
    const householdId = c.req.param('householdId')
    const token = c.req.param('token')
    await revokeInviteByToken(db, accessToken, householdId, token)
    return c.body(null, 204)
  })

  // Adapter bridging MealPlanner's POST /api/household-invites/accept { token }
  // contract to the backend's acceptInvite(token) logic.
  app.post('/internal/household-invites/accept', async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({}))
    const token = typeof body.token === 'string' ? body.token.trim() : ''
    if (!token) return c.json({ error: 'INVALID_TOKEN' }, 400)

    const result = await acceptInvite(db, accessToken, user.id, token)
    switch (result.outcome) {
      case 'accepted':
      case 'already_member':
        return c.json({ ok: true, householdId: result.householdId }, 200)
      case 'not_found':
        return c.json({ error: 'INVITE_NOT_FOUND' }, 404)
      case 'expired':
        return c.json({ error: 'INVITE_EXPIRED' }, 409)
      case 'not_acceptable':
        return c.json({ error: 'ACCEPT_INVITE_FAILED' }, 409)
    }
  })

  return app
}

export function buildInvitesRoutes(db: Db) {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()

  // Mirrors households.ts/week-plan.ts: Hono middleware doesn't cross
  // OpenAPIHono sub-app boundaries, so each route-building module registers
  // its own `requireAuth` rather than inheriting it from the parent app.
  app.use('/households/*', requireAuth)
  app.use('/invites/*', requireAuth)

  app.openapi(createInviteRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { householdId } = c.req.valid('param')
    const body = c.req.valid('json')

    const invite = await createInvite(db, accessToken, user.id, householdId, { email: body.email })

    return c.json(serializeInvite(invite), 201)
  })

  app.openapi(listInvitesRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const { householdId } = c.req.valid('param')

    const invites = await listPendingInvites(db, accessToken, householdId)

    return c.json({ invites: invites.map(serializeInvite) }, 200)
  })

  app.openapi(revokeInviteRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const { householdId, inviteId } = c.req.valid('param')

    await revokeInvite(db, accessToken, householdId, inviteId)

    return c.body(null, 204)
  })

  app.openapi(getInviteLandingRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const { token } = c.req.valid('param')

    const landing = await getInviteByToken(db, accessToken, token)
    if (!landing) return c.json({ error: 'Invite not found' }, 404)

    return c.json(landing, 200)
  })

  app.openapi(acceptInviteRoute, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')
    const { token } = c.req.valid('param')

    const result = await acceptInvite(db, accessToken, user.id, token)

    switch (result.outcome) {
      case 'accepted':
      case 'already_member':
        return c.json({ householdId: result.householdId }, 200)
      case 'not_found':
        return c.json({ error: 'Invite not found' }, 404)
      case 'expired':
        return c.json({ error: 'INVITE_EXPIRED' }, 409)
      case 'not_acceptable':
        return c.json({ error: `Invite is ${result.status}, not pending` }, 409)
    }
  })

  return app
}
