import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { createDb } from '../src/db.js'
import { households, householdMemberships } from '../src/schema.js'
import { getMyProfile, upsertMyProfile } from '../src/user-profile.js'
import { ensureAuthenticatedRoleGranted, ensureMigrationsApplied } from './migrations.js'
import { fakeAccessToken } from './fake-access-token.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const describeWithDb = testDatabaseUrl ? describe : describe.skip

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations')

describeWithDb('User profiles (given/family name) + RLS', () => {
  const db = createDb(testDatabaseUrl!)
  const app = buildApp(db)

  const userA = 'aaaaaaaa-1111-1111-1111-111111111111'
  const userB = 'bbbbbbbb-2222-2222-2222-222222222222'
  const stranger = 'cccccccc-3333-3333-3333-333333333333'

  beforeAll(async () => {
    await ensureMigrationsApplied(db, migrationsDir)
    await ensureAuthenticatedRoleGranted(db)
    process.env.VECKLY_INTERNAL_API_KEY = 'test-internal-key'
  })

  beforeEach(async () => {
    await db.execute(sql`delete from "user_profiles"`)
    await db.execute(sql`delete from "household_memberships"`)
    await db.execute(sql`delete from "households"`)

    const [householdA] = await db.insert(households).values({ name: 'Family A' }).returning({ id: households.id })

    // userA and userB share household A; stranger shares nothing with either.
    await db.insert(householdMemberships).values([
      { householdId: householdA!.id, userId: userA, role: 'owner', status: 'active' },
      { householdId: householdA!.id, userId: userB, role: 'member', status: 'active' },
    ])
  })

  afterAll(async () => {
    await db.execute(sql`delete from "user_profiles"`)
    await db.execute(sql`delete from "household_memberships"`)
    await db.execute(sql`delete from "households"`)
    delete process.env.VECKLY_INTERNAL_API_KEY
  })

  function authHeaders(userId: string) {
    return {
      Authorization: `Bearer ${process.env.VECKLY_INTERNAL_API_KEY}`,
      'X-User-Id': userId,
    }
  }

  it('returns null before any name has been saved', async () => {
    const profile = await getMyProfile(db, fakeAccessToken(userA), userA)
    expect(profile).toBeNull()
  })

  it('upserts and round-trips a given name with no family name', async () => {
    const saved = await upsertMyProfile(db, fakeAccessToken(userA), userA, { givenName: 'Nima' })
    expect(saved).toEqual({ userId: userA, givenName: 'Nima', familyName: null })

    const fetched = await getMyProfile(db, fakeAccessToken(userA), userA)
    expect(fetched).toEqual({ userId: userA, givenName: 'Nima', familyName: null })
  })

  it('upserts and round-trips both given and family name', async () => {
    const saved = await upsertMyProfile(db, fakeAccessToken(userA), userA, { givenName: 'Nima', familyName: 'Alikhani' })
    expect(saved).toEqual({ userId: userA, givenName: 'Nima', familyName: 'Alikhani' })

    const fetched = await getMyProfile(db, fakeAccessToken(userA), userA)
    expect(fetched).toEqual({ userId: userA, givenName: 'Nima', familyName: 'Alikhani' })
  })

  it('lets a household peer see the name via shares_active_household', async () => {
    await upsertMyProfile(db, fakeAccessToken(userA), userA, { givenName: 'Nima', familyName: 'Alikhani' })

    const seenByPeer = await getMyProfile(db, fakeAccessToken(userB), userA)
    expect(seenByPeer).toEqual({ userId: userA, givenName: 'Nima', familyName: 'Alikhani' })
  })

  it('hides the name from a user who shares no household', async () => {
    await upsertMyProfile(db, fakeAccessToken(userA), userA, { givenName: 'Nima' })

    const seenByStranger = await getMyProfile(db, fakeAccessToken(stranger), userA)
    expect(seenByStranger).toBeNull()
  })

  it('PUT then GET /internal/users/me/profile round-trips over HTTP', async () => {
    const putRes = await app.request('/internal/users/me/profile', {
      method: 'PUT',
      headers: { ...authHeaders(userA), 'Content-Type': 'application/json' },
      body: JSON.stringify({ givenName: 'Nima', familyName: 'Alikhani' }),
    })
    expect(putRes.status).toBe(200)
    expect(await putRes.json()).toEqual({ userId: userA, givenName: 'Nima', familyName: 'Alikhani' })

    const getRes = await app.request('/internal/users/me/profile', { headers: authHeaders(userA) })
    expect(getRes.status).toBe(200)
    expect(await getRes.json()).toEqual({ userId: userA, givenName: 'Nima', familyName: 'Alikhani' })
  })
})
