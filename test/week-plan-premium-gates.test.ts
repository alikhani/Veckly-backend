import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { createDb } from '../src/db.js'
import { createRecipe } from '../src/recipes.js'
import { householdAiWeeklyUsage, householdMemberships, householdWeekPlans, households } from '../src/schema.js'
import { fakeAccessToken } from './fake-access-token.js'

// `premiumGatesEnabled` is read once at module load, so the flag has to be set
// before the app is imported. This file is the only place the gated (403)
// branches of the week-plan routes are exercised.
const previousGatesFlag = vi.hoisted(() => {
  const previous = process.env.PREMIUM_GATES_ENABLED
  process.env.PREMIUM_GATES_ENABLED = 'true'
  return previous
})

// Same stub as test/week-plan.test.ts: a fake access token resolves to its
// `sub` claim instead of calling Supabase.
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: {
      getUser: async (token: string) => {
        const payload = token.split('.')[1]
        const sub = payload ? (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: string }).sub : undefined
        return sub
          ? { data: { user: { id: sub } }, error: null }
          : { data: { user: null }, error: new Error('Invalid token') }
      },
    },
  }),
}))

const { buildApp } = await import('../src/app.js')
// The flag is captured now; don't leak it into later test files in this worker.
if (previousGatesFlag === undefined) delete process.env.PREMIUM_GATES_ENABLED
else process.env.PREMIUM_GATES_ENABLED = previousGatesFlag

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const describeWithDb = testDatabaseUrl ? describe : describe.skip

describeWithDb('Week-plan routes with premium gates enabled', () => {
  const db = createDb(testDatabaseUrl!)
  const userA = '11111111-1111-1111-1111-111111111111'
  let householdId: string

  beforeEach(async () => {
    await db.execute(sql`delete from "recipes"`)
    await db.execute(sql`delete from "household_week_plans"`)
    await db.execute(sql`delete from "week_plan_events"`)
    await db.execute(sql`delete from "week_plan_projections"`)
    await db.execute(sql`delete from "household_memberships"`)
    await db.execute(sql`delete from "households"`)
    const [household] = await db.insert(households).values({ name: 'Gated household' }).returning({ id: households.id })
    householdId = household!.id
    await db.insert(householdMemberships).values({ householdId, userId: userA, role: 'owner', status: 'active' })
  })

  afterAll(async () => {
    await db.execute(sql`delete from "recipes"`)
    await db.execute(sql`delete from "household_week_plans"`)
    await db.execute(sql`delete from "week_plan_events"`)
    await db.execute(sql`delete from "week_plan_projections"`)
    await db.execute(sql`delete from "household_memberships"`)
    await db.execute(sql`delete from "households"`)
  })

  function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    return buildApp(db).request(path, {
      method,
      headers: {
        Authorization: `Bearer ${fakeAccessToken(userA)}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  it('answers a second free-tier generation in the same usage week with 403 and keeps the first reservation', async () => {
    await createRecipe(db, fakeAccessToken(userA), userA, householdId, {
      title: 'Gate Pasta',
      description: 'Fast family pasta',
      servings: 4,
      ingredients: [{ item: 'spaghetti', amount: '400', unit: 'g', category: 'Pantry' }],
      steps: [{ text: 'Cook pasta' }],
      tags: ['weekday'],
      prepTimeMinutes: 10,
      cookTimeMinutes: 15,
      source: 'user_created',
      isPublic: false,
    })
    const path = `/households/${householdId}/week-plans/2026-06-08/generate`

    const first = await call('POST', path, {}, { 'X-Veckly-Today': '2026-06-08' })
    expect({ status: first.status, body: await first.json() }).toEqual({ status: 200, body: { ok: true } })

    const second = await call('POST', path, {}, { 'X-Veckly-Today': '2026-06-08' })
    expect({ status: second.status, body: await second.json() }).toEqual({
      status: 403,
      body: { error: 'PREMIUM_REQUIRED', reason: 'week_generation_limit', current: 1, limit: 1 },
    })

    const usage = await db.select().from(householdAiWeeklyUsage).where(eq(householdAiWeeklyUsage.householdId, householdId))
    expect(usage).toHaveLength(1)
  })

  it('gates free-tier history older than the four most recent weeks', async () => {
    const state = {
      request: { household: { adults: 2, children: 0, priorities: [], avoidIngredients: [] }, selectedDays: [] },
      replacements: {},
      lockedDays: [],
      skippedDays: [],
    }
    await db.insert(householdWeekPlans).values({
      householdId,
      weekStartDate: '2020-01-06',
      weekNumber: 2,
      weekYear: 2020,
      timezone: 'Europe/Stockholm',
      state,
      status: 'draft',
      source: 'manual',
      updatedBy: userA,
    })

    const older = await call('GET', `/households/${householdId}/week-plans`)
    expect({ status: older.status, body: await older.json() }).toEqual({
      status: 403,
      body: { error: 'PREMIUM_REQUIRED', reason: 'week_history' },
    })

    const recentOnly = await call('GET', `/households/${householdId}/week-plans?from=2026-01-05`)
    expect({ status: recentOnly.status, body: await recentOnly.json() }).toEqual({ status: 200, body: [] })
  })
})
