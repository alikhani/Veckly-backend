import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { createDb } from '../src/db.js'
import { savedPlans } from '../src/schema.js'
import { listSavedPlans, removeSavedPlan, renameSavedPlan, upsertSavedPlan } from '../src/saved-plans.js'
import { fakeAccessToken } from './fake-access-token.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const describeWithDb = testDatabaseUrl ? describe : describe.skip

describeWithDb('Saved plans + RLS', () => {
  const db = createDb(testDatabaseUrl!)

  const userA = '11111111-1111-1111-1111-111111111111'
  const userB = '22222222-2222-2222-2222-222222222222'
  const planA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  const planB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

  beforeEach(async () => {
    await db.execute(sql`delete from "saved_plans"`)
  })

  afterAll(async () => {
    await db.execute(sql`delete from "saved_plans"`)
  })

  async function asUser<T>(userId: string, run: (tx: typeof db) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId })}, true)`)
      await tx.execute(sql`set local role authenticated`)
      return run(tx as unknown as typeof db)
    })
  }

  it('upserts, lists newest first, renames, and deletes a saved plan', async () => {
    await upsertSavedPlan(db, fakeAccessToken(userA), userA, {
      id: planA,
      createdAt: '2026-06-01T10:00:00.000Z',
      label: 'Family week',
      state: '{"request":{}}',
    })
    await upsertSavedPlan(db, fakeAccessToken(userA), userA, {
      id: planB,
      createdAt: '2026-06-01T11:00:00.000Z',
      label: 'Quick week',
      state: '{"request":{"quick":true}}',
    })

    const listed = await listSavedPlans(db, fakeAccessToken(userA), userA)
    expect(listed.map((plan) => plan.id)).toEqual([planB, planA])

    const renamed = await renameSavedPlan(db, fakeAccessToken(userA), userA, planA, 'Renamed week')
    expect(renamed?.label).toBe('Renamed week')

    await removeSavedPlan(db, fakeAccessToken(userA), userA, planA)
    await expect(listSavedPlans(db, fakeAccessToken(userA), userA)).resolves.toHaveLength(1)
  })

  it('does not expose another user saved plans through RLS', async () => {
    await upsertSavedPlan(db, fakeAccessToken(userB), userB, {
      id: planB,
      createdAt: '2026-06-01T11:00:00.000Z',
      label: 'Other family week',
      state: '{}',
    })

    const rows = await asUser(userA, (tx) =>
      tx.select().from(savedPlans).where(eq(savedPlans.id, planB)),
    )

    expect(rows).toHaveLength(0)
    await expect(listSavedPlans(db, fakeAccessToken(userA), userA)).resolves.toEqual([])
  })

  it('refuses direct insert attributed to another user', async () => {
    await expect(
      asUser(userA, (tx) =>
        tx.insert(savedPlans).values({
          id: planA,
          userId: userB,
          createdAt: new Date('2026-06-01T10:00:00.000Z'),
          label: 'Impersonated',
          stateJson: '{}',
        }),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('internal strangle routes preserve MealPlanner response shapes', async () => {
    const previousInternalKey = process.env.VECKLY_INTERNAL_API_KEY
    process.env.VECKLY_INTERNAL_API_KEY = 'test-internal-key'
    try {
      const app = buildApp(db)
      const headers = {
        Authorization: `Bearer ${process.env.VECKLY_INTERNAL_API_KEY}`,
        'X-User-Id': userA,
        'Content-Type': 'application/json',
      }

      const createResponse = await app.request('/internal/saved-plans', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: planA,
          createdAt: '2026-06-01T10:00:00.000Z',
          label: 'Family week',
          state: '{}',
        }),
      })
      expect(createResponse.status).toBe(200)
      await expect(createResponse.json()).resolves.toEqual({ ok: true })

      const listResponse = await app.request('/internal/saved-plans', { headers })
      expect(listResponse.status).toBe(200)
      await expect(listResponse.json()).resolves.toEqual([
        { id: planA, createdAt: '2026-06-01T10:00:00.000Z', label: 'Family week', state: '{}' },
      ])

      const renameResponse = await app.request(`/internal/saved-plans/${planA}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ label: 'Renamed week' }),
      })
      expect(renameResponse.status).toBe(200)
      await expect(renameResponse.json()).resolves.toEqual({ ok: true })

      const deleteResponse = await app.request(`/internal/saved-plans/${planA}`, {
        method: 'DELETE',
        headers,
      })
      expect(deleteResponse.status).toBe(200)
      await expect(deleteResponse.json()).resolves.toEqual({ ok: true })
    } finally {
      if (previousInternalKey === undefined) {
        delete process.env.VECKLY_INTERNAL_API_KEY
      } else {
        process.env.VECKLY_INTERNAL_API_KEY = previousInternalKey
      }
    }
  })
})
