import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { createDb } from '../src/db.js'
import { households, householdInvites, householdMemberships } from '../src/schema.js'
import { acceptInvite, createInvite, getInviteByToken, revokeInvite } from '../src/invites.js'
import { fakeAccessToken } from './fake-access-token.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL

const describeWithDb = testDatabaseUrl ? describe : describe.skip

describeWithDb('Household invites + token-gated RLS', () => {
  const db = createDb(testDatabaseUrl!)

  const userA = '11111111-1111-1111-1111-111111111111'
  const userB = '22222222-2222-2222-2222-222222222222'
  const stranger = '33333333-3333-3333-3333-333333333333'
  let householdAId: string
  let householdBId: string

  // Migrations and the `authenticated` role grant (including the
  // select/insert/update privileges on `household_invites` this slice is the
  // first to need) are applied once, globally — see test/global-setup.ts.

  beforeEach(async () => {
    await db.execute(sql`delete from "household_invites"`)
    await db.execute(sql`delete from "household_memberships"`)
    await db.execute(sql`delete from "households"`)

    const [householdA] = await db.insert(households).values({ name: 'Household A' }).returning({ id: households.id })
    const [householdB] = await db.insert(households).values({ name: 'Household B' }).returning({ id: households.id })
    householdAId = householdA!.id
    householdBId = householdB!.id

    await db.insert(householdMemberships).values([
      { householdId: householdAId, userId: userA, role: 'owner', status: 'active' },
      { householdId: householdBId, userId: userB, role: 'owner', status: 'active' },
    ])
  })

  afterAll(async () => {
    await db.execute(sql`delete from "household_invites"`)
    await db.execute(sql`delete from "household_memberships"`)
    await db.execute(sql`delete from "households"`)
  })

  async function asUser<T>(userId: string, run: (tx: typeof db) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId })}, true)`)
      await tx.execute(sql`set local role authenticated`)
      return run(tx as unknown as typeof db)
    })
  }

  // Token-side equivalent of `asUser` — the second per-transaction config
  // value `withRlsAndToken` sets, exercised directly here for probing the
  // declarative policies without going through the higher-level functions.
  async function asUserWithToken<T>(userId: string, token: string, run: (tx: typeof db) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId })}, true)`)
      await tx.execute(sql`select set_config('request.invite_token', ${token}, true)`)
      await tx.execute(sql`set local role authenticated`)
      return run(tx as unknown as typeof db)
    })
  }

  async function insertRawInvite(overrides: Partial<typeof householdInvites.$inferInsert> & { householdId: string; createdBy: string }) {
    const [invite] = await db
      .insert(householdInvites)
      .values({
        token: 'a'.repeat(32),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        ...overrides,
      })
      .returning()
    return invite!
  }

  it('lets an active member create an invite for their own household', async () => {
    const invite = await createInvite(db, fakeAccessToken(userA), userA, householdAId, { email: 'friend@example.com' })

    expect(invite.householdId).toBe(householdAId)
    expect(invite.createdBy).toBe(userA)
    expect(invite.status).toBe('pending')
    expect(invite.email).toBe('friend@example.com')
    expect(invite.token).toMatch(/^[0-9a-f]{32}$/)
  })

  it('refuses to let a user create an invite for a household they do not belong to', async () => {
    await expect(
      asUser(stranger, (tx) =>
        tx.insert(householdInvites).values({ householdId: householdAId, token: 'b'.repeat(32), createdBy: stranger, expiresAt: new Date(Date.now() + 86400000) }),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('lets a token holder preview the invite — including the household name — without being a member', async () => {
    const invite = await createInvite(db, fakeAccessToken(userA), userA, householdAId)

    const landing = await getInviteByToken(db, fakeAccessToken(stranger), invite.token)

    expect(landing).toEqual({ householdName: 'Household A', status: 'pending', expiresAt: invite.expiresAt.toISOString() })
  })

  it('shows nothing to someone without the right token — no leak via the household join either', async () => {
    const invite = await createInvite(db, fakeAccessToken(userA), userA, householdAId)

    const wrongToken = await getInviteByToken(db, fakeAccessToken(stranger), 'f'.repeat(32))
    expect(wrongToken).toBeNull()

    // Probe both halves of the join directly: the invite row AND the
    // household name must both be invisible without the token — proving
    // `households_select_via_invite_token` is exactly as narrow as intended
    // (visible only via the token, not opened up generally).
    const [inviteRow] = await asUser(stranger, (tx) => tx.select().from(householdInvites).where(eq(householdInvites.token, invite.token)))
    expect(inviteRow).toBeUndefined()

    const [householdRow] = await asUser(stranger, (tx) => tx.select().from(households).where(eq(households.id, householdAId)))
    expect(householdRow).toBeUndefined()
  })

  it('lets the token holder accept, joining the household as an active member', async () => {
    const invite = await createInvite(db, fakeAccessToken(userA), userA, householdAId)

    const result = await acceptInvite(db, fakeAccessToken(stranger), stranger, invite.token)
    expect(result).toEqual({ outcome: 'accepted', householdId: householdAId })

    const [membership] = await db
      .select()
      .from(householdMemberships)
      .where(and(eq(householdMemberships.householdId, householdAId), eq(householdMemberships.userId, stranger)))
    expect(membership?.role).toBe('member')
    expect(membership?.status).toBe('active')

    const [persisted] = await db.select().from(householdInvites).where(eq(householdInvites.token, invite.token))
    expect(persisted?.status).toBe('accepted')
    expect(persisted?.acceptedBy).toBe(stranger)
    expect(persisted?.acceptedAt).not.toBeNull()
  })

  it('treats a second accept as a clean no-op — same household, no duplicate membership', async () => {
    const invite = await createInvite(db, fakeAccessToken(userA), userA, householdAId)

    const first = await acceptInvite(db, fakeAccessToken(stranger), stranger, invite.token)
    const second = await acceptInvite(db, fakeAccessToken(stranger), stranger, invite.token)

    expect(first.outcome).toBe('accepted')
    expect(second).toEqual({ outcome: 'already_member', householdId: householdAId })

    const memberships = await db
      .select()
      .from(householdMemberships)
      .where(and(eq(householdMemberships.householdId, householdAId), eq(householdMemberships.userId, stranger)))
    expect(memberships).toHaveLength(1)
  })

  it('lets nobody flip an invite to accepted while holding the wrong token — the load-bearing canary', async () => {
    const invite = await createInvite(db, fakeAccessToken(userA), userA, householdAId)

    // Unlike an INSERT/UPDATE failing its `with check` (which throws "row-level
    // security policy violation" — see 0004's takeover canary), a row excluded
    // by an UPDATE's `using` clause is simply INVISIBLE to the statement: it
    // matches and changes zero rows, silently. That's the *more* secure shape
    // here — the wrong-token holder doesn't even learn the row exists. The
    // observable proof is therefore "nothing changed", not "it threw".
    const result = await asUserWithToken(stranger, 'f'.repeat(32), (tx) =>
      tx.update(householdInvites).set({ status: 'accepted', acceptedBy: stranger, acceptedAt: new Date() }).where(eq(householdInvites.id, invite.id)).returning(),
    )
    expect(result).toEqual([])

    const [persisted] = await db.select().from(householdInvites).where(eq(householdInvites.id, invite.id))
    expect(persisted?.status).toBe('pending')
  })

  it('refuses to accept an expired invite, even with the right token', async () => {
    const expired = await insertRawInvite({
      householdId: householdAId,
      createdBy: userA,
      token: 'c'.repeat(32),
      expiresAt: new Date(Date.now() - 1000),
    })

    const result = await acceptInvite(db, fakeAccessToken(stranger), stranger, expired.token)
    expect(result).toEqual({ outcome: 'expired' })

    const memberships = await db.select().from(householdMemberships).where(eq(householdMemberships.userId, stranger))
    expect(memberships).toHaveLength(0)
  })

  it('refuses to accept a revoked invite, even with the right token', async () => {
    const revoked = await insertRawInvite({ householdId: householdAId, createdBy: userA, token: 'd'.repeat(32), status: 'revoked' })

    const result = await acceptInvite(db, fakeAccessToken(stranger), stranger, revoked.token)
    expect(result).toEqual({ outcome: 'not_acceptable', status: 'revoked' })

    const memberships = await db.select().from(householdMemberships).where(eq(householdMemberships.userId, stranger))
    expect(memberships).toHaveLength(0)
  })

  it('lets an active member revoke their own household pending invite, but not another household\'s', async () => {
    const inviteA = await createInvite(db, fakeAccessToken(userA), userA, householdAId)

    // userB is an active owner of household B — a real member, just not of
    // THIS household. The canary: membership alone isn't the gate, membership
    // *in the right household* is.
    const deniedByOutsideMember = await revokeInvite(db, fakeAccessToken(userB), inviteA.id)
    expect(deniedByOutsideMember).toEqual({ revoked: false })

    const stillPending = await db.select({ status: householdInvites.status }).from(householdInvites).where(eq(householdInvites.id, inviteA.id))
    expect(stillPending[0]?.status).toBe('pending')

    const revokedByOwner = await revokeInvite(db, fakeAccessToken(userA), inviteA.id)
    expect(revokedByOwner).toEqual({ revoked: true })

    const final = await db.select({ status: householdInvites.status }).from(householdInvites).where(eq(householdInvites.id, inviteA.id))
    expect(final[0]?.status).toBe('revoked')
  })
})
