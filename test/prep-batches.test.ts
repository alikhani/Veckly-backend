import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { createDb } from '../src/db.js'
import { households, householdMemberships } from '../src/schema.js'
import { ensureAuthenticatedRoleGranted, ensureMigrationsApplied } from './migrations.js'
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
    process.env.VECKLY_INTERNAL_API_KEY = 'test-internal-key'
  })

  afterAll(async () => {
    await db.execute(sql`delete from "household_prep_batches"`)
    await db.execute(sql`delete from "household_memberships"`)
    await db.execute(sql`delete from "households"`)
    delete process.env.VECKLY_INTERNAL_API_KEY
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

  function authHeaders(userId: string) {
    return {
      Authorization: `Bearer ${process.env.VECKLY_INTERNAL_API_KEY}`,
      'X-User-Id': userId,
    }
  }

  it('returns 401 for unauthenticated requests', async () => {
    const res = await app.request(
      `/internal/households/${householdAId}/prep_batches?from=2026-01-01&to=2026-01-07`,
    )
    expect(res.status).toBe(401)
  })

  it('returns 404 for a non-member', async () => {
    const res = await app.request(
      `/internal/households/${householdAId}/prep_batches?from=2026-01-01&to=2026-01-07`,
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

    const res = await app.request(`/internal/households/${householdAId}/prep_batches`, {
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

  it('creates a recipe-less batch (leftovers with no specific dish) and returns 201', async () => {
    const res = await app.request(`/internal/households/${householdAId}/prep_batches`, {
      method: 'POST',
      headers: { ...authHeaders(userA), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cookDate: '2026-06-15',
        totalPortions: 4,
        assignments: [{ date: '2026-06-15', mealType: 'dinner' }],
      }),
    })

    expect(res.status).toBe(201)
    const data = await res.json() as Record<string, unknown>
    expect(data.recipeId).toBeNull()
    expect(data.customRecipeId).toBeNull()
  })

  it('rejects a batch with both recipeId and customRecipeId set', async () => {
    const res = await app.request(`/internal/households/${householdAId}/prep_batches`, {
      method: 'POST',
      headers: { ...authHeaders(userA), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipeId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
        customRecipeId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        cookDate: '2026-06-15',
        totalPortions: 4,
        assignments: [{ date: '2026-06-15', mealType: 'dinner' }],
      }),
    })

    expect(res.status).toBe(400)
  })

  it('lists batches whose cookDate falls within the requested date range', async () => {
    await app.request(`/internal/households/${householdAId}/prep_batches`, {
      method: 'POST',
      headers: { ...authHeaders(userA), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customRecipeId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        cookDate: '2026-06-15',
        totalPortions: 4,
        assignments: [{ date: '2026-06-16', mealType: 'lunch' }],
      }),
    })

    await app.request(`/internal/households/${householdAId}/prep_batches`, {
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
      `/internal/households/${householdAId}/prep_batches?from=2026-06-15&to=2026-06-21`,
      { headers: authHeaders(userA) },
    )
    expect(res.status).toBe(200)
    const data = await res.json() as { batches: unknown[] }
    expect(data.batches.length).toBe(1)
  })

  it('deletes a prep batch and returns 200', async () => {
    const createRes = await app.request(`/internal/households/${householdAId}/prep_batches`, {
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

    const deleteRes = await app.request(`/internal/households/${householdAId}/prep_batches/${id}`, {
      method: 'DELETE',
      headers: authHeaders(userA),
    })
    expect(deleteRes.status).toBe(200)
    expect(await deleteRes.json()).toEqual({ ok: true })
  })

  it('returns 404 when a non-member tries to delete a batch in the correct household', async () => {
    const createRes = await app.request(`/internal/households/${householdAId}/prep_batches`, {
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

    // userB is not a member of householdA at all — without assertMembership,
    // deleteBatch's own householdId-scoped WHERE clause would still let this
    // succeed, because the path's householdId IS correct; the missing check
    // is "is the caller actually IN that household."
    const deleteRes = await app.request(`/internal/households/${householdAId}/prep_batches/${id}`, {
      method: 'DELETE',
      headers: authHeaders(userB),
    })
    expect(deleteRes.status).toBe(404)
  })

  it('returns 404 when a non-member tries to remove an assignment in the correct household', async () => {
    const createRes = await app.request(`/internal/households/${householdAId}/prep_batches`, {
      method: 'POST',
      headers: { ...authHeaders(userA), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customRecipeId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        cookDate: '2026-06-15',
        totalPortions: 6,
        assignments: [
          { date: '2026-06-16', mealType: 'lunch' },
          { date: '2026-06-17', mealType: 'dinner' },
        ],
      }),
    })
    const { id } = await createRes.json() as { id: string }

    const removeRes = await app.request(
      `/internal/households/${householdAId}/prep_batches/${id}/assignments/2026-06-16?mealType=lunch`,
      { method: 'DELETE', headers: authHeaders(userB) },
    )
    expect(removeRes.status).toBe(404)
  })

  it('removing one of several assignments leaves the batch with the rest intact', async () => {
    const createRes = await app.request(`/internal/households/${householdAId}/prep_batches`, {
      method: 'POST',
      headers: { ...authHeaders(userA), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customRecipeId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        cookDate: '2026-06-15',
        totalPortions: 6,
        assignments: [
          { date: '2026-06-16', mealType: 'lunch' },
          { date: '2026-06-17', mealType: 'dinner' },
        ],
      }),
    })
    const { id } = await createRes.json() as { id: string }

    const removeRes = await app.request(
      `/internal/households/${householdAId}/prep_batches/${id}/assignments/2026-06-16?mealType=lunch`,
      { method: 'DELETE', headers: authHeaders(userA) },
    )
    expect(removeRes.status).toBe(200)
    expect(await removeRes.json()).toEqual({ ok: true })

    const listRes = await app.request(
      `/internal/households/${householdAId}/prep_batches?from=2026-06-15&to=2026-06-21`,
      { headers: authHeaders(userA) },
    )
    const data = await listRes.json() as { batches: Array<{ id: string; assignments: unknown[] }> }
    expect(data.batches.length).toBe(1)
    expect(data.batches[0]!.assignments.length).toBe(1)
  })

  it('removing the last assignment deletes the batch', async () => {
    const createRes = await app.request(`/internal/households/${householdAId}/prep_batches`, {
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

    const removeRes = await app.request(
      `/internal/households/${householdAId}/prep_batches/${id}/assignments/2026-06-16?mealType=lunch`,
      { method: 'DELETE', headers: authHeaders(userA) },
    )
    expect(removeRes.status).toBe(200)

    const listRes = await app.request(
      `/internal/households/${householdAId}/prep_batches?from=2026-06-15&to=2026-06-21`,
      { headers: authHeaders(userA) },
    )
    const data = await listRes.json() as { batches: unknown[] }
    expect(data.batches.length).toBe(0)
  })

  it('non-member cannot remove an assignment from another household\'s batch', async () => {
    const createRes = await app.request(`/internal/households/${householdBId}/prep_batches`, {
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

    const removeRes = await app.request(
      `/internal/households/${householdAId}/prep_batches/${id}/assignments/2026-06-16?mealType=lunch`,
      { method: 'DELETE', headers: authHeaders(userA) },
    )
    expect(removeRes.status).toBe(404)
  })

  it('returns 404 when deleting a batch from another household', async () => {
    const createRes = await app.request(`/internal/households/${householdBId}/prep_batches`, {
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

    const deleteRes = await app.request(`/internal/households/${householdAId}/prep_batches/${id}`, {
      method: 'DELETE',
      headers: authHeaders(userA),
    })
    expect(deleteRes.status).toBe(404)
  })

  it('non-member cannot create a batch in another household', async () => {
    const res = await app.request(`/internal/households/${householdAId}/prep_batches`, {
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

  describe('two members of the same household', () => {
    const userC = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

    beforeEach(async () => {
      await db.insert(householdMemberships).values([
        { householdId: householdAId, userId: userC, role: 'member', status: 'active' },
      ])
    })

    it('lets member B see a batch member A created in their shared household', async () => {
      const createRes = await app.request(`/internal/households/${householdAId}/prep_batches`, {
        method: 'POST',
        headers: { ...authHeaders(userA), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customRecipeId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
          cookDate: '2026-06-15',
          totalPortions: 6,
          assignments: [{ date: '2026-06-16', mealType: 'lunch' }],
        }),
      })
      expect(createRes.status).toBe(201)

      const listRes = await app.request(
        `/internal/households/${householdAId}/prep_batches?from=2026-06-15&to=2026-06-21`,
        { headers: authHeaders(userC) },
      )
      expect(listRes.status).toBe(200)
      const data = await listRes.json() as { batches: Array<{ id: string; createdBy: string; assignments: unknown[] }> }
      expect(data.batches.length).toBe(1)
      expect(data.batches[0]!.createdBy).toBe(userA)
      expect(data.batches[0]!.assignments.length).toBe(1)
    })
  })
})
