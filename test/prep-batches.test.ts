import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { createDb } from '../src/db.js'
import { households, householdMemberships } from '../src/schema.js'
import { ensureAuthenticatedRoleGranted, ensureMigrationsApplied } from './migrations.js'
import { fakeAccessToken } from './fake-access-token.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const describeWithDb = testDatabaseUrl ? describe : describe.skip

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations')

describeWithDb('Prep batches + RLS', () => {
  const db = createDb(testDatabaseUrl!)
  const app = buildApp(db)

  const userA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  const userB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
  let householdAId: string
  let householdBId: string

  beforeAll(async () => {
    await ensureMigrationsApplied(db, migrationsDir)
    await ensureAuthenticatedRoleGranted(db)
  })

  beforeEach(async () => {
    await db.execute(sql`delete from "household_prep_batches"`)
    await db.execute(sql`delete from "household_memberships"`)
    await db.execute(sql`delete from "households"`)

    const [hA] = await db.insert(households).values({ name: 'Family A' }).returning({ id: households.id })
    const [hB] = await db.insert(households).values({ name: 'Family B' }).returning({ id: households.id })
    householdAId = hA!.id
    householdBId = hB!.id

    await db.insert(householdMemberships).values([
      { householdId: householdAId, userId: userA, role: 'owner', status: 'active' },
      { householdId: householdBId, userId: userB, role: 'owner', status: 'active' },
    ])
  })

  afterAll(async () => {
    await db.execute(sql`delete from "household_prep_batches"`)
    await db.execute(sql`delete from "household_memberships"`)
    await db.execute(sql`delete from "households"`)
  })

  function authHeaders(userId: string) {
    return { Authorization: `Bearer ${fakeAccessToken(userId)}` }
  }

  it('returns 401 for unauthenticated requests', async () => {
    const res = await app.request(`/households/${householdAId}/prep-batches?from=2026-01-01&to=2026-01-07`)
    expect(res.status).toBe(401)
  })

  it('returns 404 for a non-member', async () => {
    const res = await app.request(
      `/households/${householdAId}/prep-batches?from=2026-01-01&to=2026-01-07`,
      { headers: authHeaders(userB) },
    )
    expect(res.status).toBe(404)
  })

  it('creates a prep batch and returns 201 with assignments', async () => {
    const body = {
      recipeId: undefined,
      customRecipeId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      cookDate: '2026-06-15',
      totalPortions: 6,
      assignments: [
        { date: '2026-06-16', mealType: 'lunch' },
        { date: '2026-06-17', mealType: 'dinner' },
      ],
    }

    const res = await app.request(`/households/${householdAId}/prep-batches`, {
      method: 'POST',
      headers: { ...authHeaders(userA), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    expect(res.status).toBe(201)
    const data = await res.json() as Record<string, unknown>
    expect(data.householdId).toBe(householdAId)
    expect(data.cookDate).toBe('2026-06-15')
    expect(data.totalPortions).toBe(6)
    expect(data.customRecipeId).toBe('cccccccc-cccc-cccc-cccc-cccccccccccc')
    expect(Array.isArray(data.assignments)).toBe(true)
    expect((data.assignments as unknown[]).length).toBe(2)
  })

  it('lists batches whose cookDate falls within the requested date range', async () => {
    await app.request(`/households/${householdAId}/prep-batches`, {
      method: 'POST',
      headers: { ...authHeaders(userA), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customRecipeId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        cookDate: '2026-06-15',
        totalPortions: 4,
        assignments: [{ date: '2026-06-16', mealType: 'lunch' }],
      }),
    })

    await app.request(`/households/${householdAId}/prep-batches`, {
      method: 'POST',
      headers: { ...authHeaders(userA), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customRecipeId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        cookDate: '2026-06-22',
        totalPortions: 4,
        assignments: [{ date: '2026-06-23', mealType: 'dinner' }],
      }),
    })

    const res = await app.request(
      `/households/${householdAId}/prep-batches?from=2026-06-15&to=2026-06-21`,
      { headers: authHeaders(userA) },
    )
    expect(res.status).toBe(200)
    const data = await res.json() as { batches: unknown[] }
    expect(data.batches.length).toBe(1)
  })

  it('deletes a prep batch and returns 200', async () => {
    const createRes = await app.request(`/households/${householdAId}/prep-batches`, {
      method: 'POST',
      headers: { ...authHeaders(userA), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customRecipeId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        cookDate: '2026-06-15',
        totalPortions: 4,
        assignments: [{ date: '2026-06-16', mealType: 'lunch' }],
      }),
    })
    const { id } = await createRes.json() as { id: string }

    const deleteRes = await app.request(`/households/${householdAId}/prep-batches/${id}`, {
      method: 'DELETE',
      headers: authHeaders(userA),
    })
    expect(deleteRes.status).toBe(200)
    expect(await deleteRes.json()).toEqual({ ok: true })
  })

  it('returns 404 when deleting a batch from another household', async () => {
    const createRes = await app.request(`/households/${householdBId}/prep-batches`, {
      method: 'POST',
      headers: { ...authHeaders(userB), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customRecipeId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        cookDate: '2026-06-15',
        totalPortions: 4,
        assignments: [{ date: '2026-06-16', mealType: 'lunch' }],
      }),
    })
    const { id } = await createRes.json() as { id: string }

    const deleteRes = await app.request(`/households/${householdAId}/prep-batches/${id}`, {
      method: 'DELETE',
      headers: authHeaders(userA),
    })
    expect(deleteRes.status).toBe(404)
  })

  it('non-member cannot create a batch in another household', async () => {
    const res = await app.request(`/households/${householdAId}/prep-batches`, {
      method: 'POST',
      headers: { ...authHeaders(userB), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customRecipeId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        cookDate: '2026-06-15',
        totalPortions: 4,
        assignments: [{ date: '2026-06-16', mealType: 'lunch' }],
      }),
    })
    expect(res.status).toBe(404)
  })
})
