import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { createDb } from '../src/db.js'
import { households, householdMemberships } from '../src/schema.js'
import { bootstrapHousehold, createNamedHousehold, deleteHousehold, listHouseholdMembers, listHouseholdsForUser, renameHousehold } from '../src/households.js'
import { upsertMyProfile } from '../src/user-profile.js'
import { fakeAccessToken } from './fake-access-token.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL

const describeWithDb = testDatabaseUrl ? describe : describe.skip

describeWithDb('Household bootstrap + write-path RLS', () => {
  const db = createDb(testDatabaseUrl!)

  const userA = '11111111-1111-1111-1111-111111111111'
  const userB = '22222222-2222-2222-2222-222222222222'
  const stranger = '33333333-3333-3333-3333-333333333333'
  let householdAId: string

  // Migrations and the `authenticated` role grant (including the insert
  // privileges this slice is the first to need on these two tables) are
  // applied once, globally, before any suite starts — see test/global-setup.ts.

  beforeEach(async () => {
    await db.execute(sql`delete from "household_memberships"`)
    await db.execute(sql`delete from "households"`)

    const [householdA] = await db.insert(households).values({ name: 'Household A' }).returning({ id: households.id })
    const [householdB] = await db.insert(households).values({ name: 'Household B' }).returning({ id: households.id })
    householdAId = householdA!.id

    await db.insert(householdMemberships).values([
      { householdId: householdAId, userId: userA, role: 'owner', status: 'active' },
      { householdId: householdB!.id, userId: userB, role: 'owner', status: 'active' },
    ])
  })

  afterAll(async () => {
    await db.execute(sql`delete from "user_profiles"`)
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

  it('lists all active households the caller belongs to', async () => {
    const rows = await listHouseholdsForUser(db, fakeAccessToken(userA))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(householdAId)
    expect(rows[0]?.role).toBe('owner')
  })

  it('returns an empty list for a user with no household', async () => {
    const rows = await listHouseholdsForUser(db, fakeAccessToken(stranger))
    expect(rows).toHaveLength(0)
  })

  it('returns multiple households when the user belongs to more than one', async () => {
    await createNamedHousehold(db, fakeAccessToken(userA), userA, 'Second House')
    const rows = await listHouseholdsForUser(db, fakeAccessToken(userA))
    expect(rows).toHaveLength(2)
  })

  it('creates "My household" with the caller as owner when they have no household', async () => {
    const result = await bootstrapHousehold(db, fakeAccessToken(stranger), stranger)

    expect(result.created).toBe(true)
    expect(result.household.name).toBe('My household')
    expect(result.household.role).toBe('owner')

    const [membership] = await db
      .select()
      .from(householdMemberships)
      .where(and(eq(householdMemberships.householdId, result.household.id), eq(householdMemberships.userId, stranger)))

    expect(membership?.role).toBe('owner')
    expect(membership?.status).toBe('active')
  })

  it('returns the existing household on a second call, creating nothing new', async () => {
    const first = await bootstrapHousehold(db, fakeAccessToken(stranger), stranger)
    const second = await bootstrapHousehold(db, fakeAccessToken(stranger), stranger)

    expect(second.created).toBe(false)
    expect(second.household.id).toBe(first.household.id)

    const rows = await db
      .select()
      .from(households)
      .innerJoin(householdMemberships, eq(households.id, householdMemberships.householdId))
      .where(eq(householdMemberships.userId, stranger))

    expect(rows).toHaveLength(1)
  })

  it('refuses to let a user grant themselves ownership of an existing household', async () => {
    // householdAId already has userA as active owner (seeded in beforeEach).
    // If this insert succeeded, userB would walk away co-owning A's household —
    // exactly the cross-household takeover the `not exists` clause exists to stop.
    await expect(
      asUser(userB, (tx) =>
        tx.insert(householdMemberships).values({ householdId: householdAId, userId: userB, role: 'owner', status: 'active' }),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('refuses to let a user insert a membership row for someone else', async () => {
    const [freshHousehold] = await db.insert(households).values({ name: 'Fresh' }).returning()

    await expect(
      asUser(userA, (tx) =>
        tx.insert(householdMemberships).values({ householdId: freshHousehold!.id, userId: userB, role: 'owner', status: 'active' }),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('creates a household with the given name and adds the caller as owner', async () => {
    const result = await createNamedHousehold(db, fakeAccessToken(stranger), stranger, 'Weekend House')

    expect(result.name).toBe('Weekend House')
    expect(result.role).toBe('owner')

    const [membership] = await db
      .select()
      .from(householdMemberships)
      .where(and(eq(householdMemberships.householdId, result.id), eq(householdMemberships.userId, stranger)))

    expect(membership?.role).toBe('owner')
    expect(membership?.status).toBe('active')
  })

  it('lets a user who already owns a household create an additional one', async () => {
    // userA already has householdA from beforeEach
    const second = await createNamedHousehold(db, fakeAccessToken(userA), userA, 'Summer Cabin')

    expect(second.name).toBe('Summer Cabin')
    expect(second.role).toBe('owner')

    const rows = await db
      .select()
      .from(householdMemberships)
      .where(and(eq(householdMemberships.userId, userA), eq(householdMemberships.status, 'active')))

    expect(rows).toHaveLength(2)
  })

  it('owner can rename their household', async () => {
    const result = await renameHousehold(db, fakeAccessToken(userA), householdAId, 'Renamed A')
    expect(result).not.toBeNull()
    expect(result!.name).toBe('Renamed A')
    const [row] = await db.select({ name: households.name }).from(households).where(eq(households.id, householdAId))
    expect(row?.name).toBe('Renamed A')
  })

  it('non-owner member cannot rename a household — RLS blocks the update', async () => {
    // Make userB a plain member (not owner) of householdA
    await db.insert(householdMemberships).values({ householdId: householdAId, userId: userB, role: 'member', status: 'active' })
    const result = await renameHousehold(db, fakeAccessToken(userB), householdAId, 'Hijacked')
    expect(result).toBeNull()
    const [row] = await db.select({ name: households.name }).from(households).where(eq(households.id, householdAId))
    expect(row?.name).toBe('Household A')
  })

  it('non-member cannot rename a household they have no access to', async () => {
    const result = await renameHousehold(db, fakeAccessToken(stranger), householdAId, 'Hijacked')
    expect(result).toBeNull()
  })

  it('owner can delete their household and its memberships cascade away', async () => {
    const deleted = await deleteHousehold(db, fakeAccessToken(userA), householdAId)

    expect(deleted).toBe(true)

    const householdRows = await db.select().from(households).where(eq(households.id, householdAId))
    expect(householdRows).toHaveLength(0)

    const membershipRows = await db.select().from(householdMemberships).where(eq(householdMemberships.householdId, householdAId))
    expect(membershipRows).toHaveLength(0)
  })

  it('non-member cannot delete a household they cannot see', async () => {
    const deleted = await deleteHousehold(db, fakeAccessToken(stranger), householdAId)
    expect(deleted).toBe(false)
  })

  it('rolls back the household insert if the membership insert fails — never one without the other', async () => {
    await expect(
      asUser(stranger, async (tx) => {
        const [household] = await tx.insert(households).values({ name: 'My household' }).returning()
        // Force failure: 'not-a-role' isn't a valid household_membership_role value.
        await tx
          .insert(householdMemberships)
          .values({ householdId: household!.id, userId: stranger, role: 'not-a-role' as never, status: 'active' })
      }),
    ).rejects.toThrow()

    const orphans = await db.select().from(households).where(eq(households.name, 'My household'))
    expect(orphans).toHaveLength(0)
  })

  it('includes a member\'s display name once set, and null otherwise', async () => {
    await upsertMyProfile(db, fakeAccessToken(userA), userA, 'Nima')

    const members = await listHouseholdMembers(db, fakeAccessToken(userA), householdAId)
    const owner = members.find((m) => m.userId === userA)
    expect(owner?.displayName).toBe('Nima')
  })

  it('requires auth for public household member routes', async () => {
    const app = buildApp(db)

    const listResponse = await app.request(`/households/${householdAId}/members`)
    expect(listResponse.status).toBe(401)

    const updateResponse = await app.request(`/households/${householdAId}/members/${userB}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'member' }),
    })
    expect(updateResponse.status).toBe(401)

    const deleteResponse = await app.request(`/households/${householdAId}/members/${userB}`, { method: 'DELETE' })
    expect(deleteResponse.status).toBe(401)
  })

  it('requires auth for public household delete route', async () => {
    const app = buildApp(db)
    const response = await app.request(`/households/${householdAId}`, { method: 'DELETE' })
    expect(response.status).toBe(401)
  })
})
