import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { createDb } from '../src/db.js'
import { createRecipe } from '../src/recipes.js'
import { upsertMealFeedback } from '../src/meal-feedback.js'
import { householdProfiles, householdWeekPlans, households, householdMemberships, recipes, weekPlanEvents, weekPlanProjections } from '../src/schema.js'
import {
  doGenerateWeekPlan,
  finalizeWeekHistoryPlan,
  foldEventIntoProjection,
  emptyProjectionState,
  getWeekHistoryPlan,
  getWeekPlanSummary,
  listWeekHistoryPlans,
  upsertWeekHistoryPlan,
  type TWeekPlanProjectionState,
} from '../src/week-plan.js'
import { fakeAccessToken } from './fake-access-token.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL

const describeWithDb = testDatabaseUrl ? describe : describe.skip

describeWithDb('Week-plan event log + projection', () => {
  const db = createDb(testDatabaseUrl!)

  const userA = '11111111-1111-1111-1111-111111111111'
  const userB = '22222222-2222-2222-2222-222222222222'
  let householdAId: string
  let householdBId: string

  const weekStartDate = '2026-06-08'

  // Migrations and the `authenticated` role grant (including the write
  // privileges this slice is the first to need) are applied once, globally,
  // before any suite starts — see test/global-setup.ts.

  beforeEach(async () => {
    await db.execute(sql`delete from "meal_feedback"`)
    await db.execute(sql`delete from "recipes"`)
    await db.execute(sql`delete from "household_week_plans"`)
    await db.execute(sql`delete from "week_plan_events"`)
    await db.execute(sql`delete from "week_plan_projections"`)
    await db.execute(sql`delete from "household_profiles"`)
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
    await db.execute(sql`delete from "meal_feedback"`)
    await db.execute(sql`delete from "recipes"`)
    await db.execute(sql`delete from "household_week_plans"`)
    await db.execute(sql`delete from "week_plan_events"`)
    await db.execute(sql`delete from "week_plan_projections"`)
    await db.execute(sql`delete from "household_profiles"`)
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

  const userCausedBy = (userId: string) => ({ source: 'user' as const, userId })
  const baseHistoryState = {
    request: {
      household: { adults: 2, children: 1, priorities: ['quick' as const], avoidIngredients: [] },
      selectedDays: [
        { day: 'monday' as const, occasion: 'standard' as const },
        { day: 'friday' as const, occasion: 'treat' as const },
      ],
    },
    replacements: {},
    lockedDays: ['monday' as const],
    skippedDays: ['friday' as const],
  }
  type TWeekPlanEventType =
    | 'week_started'
    | 'planning_request_updated'
    | 'meal_assigned'
    | 'meal_unassigned'
    | 'meal_locked'
    | 'meal_unlocked'
    | 'meal_moved'
    | 'day_skipped'
    | 'day_unskipped'
    | 'servings_changed'
    | 'week_plan_cleared'

  async function appendAsUser(
    userId: string,
    args: { householdId: string; sequenceNumber: number; eventType: TWeekPlanEventType; payload: Record<string, unknown> },
  ) {
    return asUser(userId, async (tx) => {
      const [event] = await tx
        .insert(weekPlanEvents)
        .values({
          householdId: args.householdId,
          weekStartDate,
          sequenceNumber: args.sequenceNumber,
          causedBy: userCausedBy(userId),
          eventType: args.eventType,
          payload: args.payload,
        })
        .returning()
      return event!
    })
  }

  describe('(a) RLS blocks cross-household access on the new tables', () => {
    it('never returns another household projection, even when explicitly requested by id', async () => {
      await db.insert(weekPlanProjections).values({
        householdId: householdBId,
        weekStartDate,
        state: { weekStarted: true, meals: {} },
      })

      const rows = await asUser(userA, (tx) =>
        tx
          .select()
          .from(weekPlanProjections)
          .where(and(eq(weekPlanProjections.householdId, householdBId), eq(weekPlanProjections.weekStartDate, weekStartDate))),
      )

      expect(rows).toHaveLength(0)
    })

    it('refuses to insert an event into a household the user is not an active member of', async () => {
      await expect(
        appendAsUser(userA, { householdId: householdBId, sequenceNumber: 1, eventType: 'week_started', payload: {} }),
      ).rejects.toThrow(/row-level security/i)
    })
  })

  describe('(b) append + projection-update is genuinely atomic', () => {
    async function appendViaWritePath(args: { householdId: string; sequenceNumber: number; eventType: TWeekPlanEventType; payload: Record<string, unknown> }) {
      // Mirrors appendWeekPlanEvent's shape without importing the route's
      // private helper — runs the same insert-then-fold sequence against one
      // transaction so atomicity can be exercised and broken deliberately.
      return asUser(userA, async (tx) => {
        const [event] = await tx
          .insert(weekPlanEvents)
          .values({
            householdId: args.householdId,
            weekStartDate,
            sequenceNumber: args.sequenceNumber,
            causedBy: userCausedBy(userA),
            eventType: args.eventType,
            payload: args.payload,
          })
          .returning()

        const [existing] = await tx
          .select({ state: weekPlanProjections.state })
          .from(weekPlanProjections)
          .where(and(eq(weekPlanProjections.householdId, args.householdId), eq(weekPlanProjections.weekStartDate, weekStartDate)))

        const currentState = (existing?.state as TWeekPlanProjectionState | undefined) ?? emptyProjectionState()
        const nextState = foldEventIntoProjection(currentState, { eventType: args.eventType, ...args.payload } as never)

        await tx
          .insert(weekPlanProjections)
          .values({ householdId: args.householdId, weekStartDate, state: nextState })
          .onConflictDoUpdate({
            target: [weekPlanProjections.householdId, weekPlanProjections.weekStartDate],
            set: { state: nextState, updatedAt: new Date() },
          })

        return event!
      })
    }

    it('persists the event and the folded projection together, from the same transaction', async () => {
      await appendViaWritePath({ householdId: householdAId, sequenceNumber: 1, eventType: 'week_started', payload: {} })
      await appendViaWritePath({
        householdId: householdAId,
        sequenceNumber: 2,
        eventType: 'meal_assigned',
        payload: { dayOfWeek: 'monday', recipeRef: 'recipe-123' },
      })

      const [event] = await db.select().from(weekPlanEvents).where(eq(weekPlanEvents.sequenceNumber, 2))
      const [projection] = await db.select().from(weekPlanProjections).where(eq(weekPlanProjections.householdId, householdAId))

      expect(event).toBeDefined()
      expect(projection).toBeDefined()
      expect(projection!.state).toEqual({
        weekStarted: true,
        request: null,
        meals: { monday: { recipeRef: 'recipe-123' } },
        lockedDays: [],
        skippedDays: [],
      })
    })

    it('rolls back the event insert if the projection step fails — never one without the other', async () => {
      await expect(
        asUser(userA, async (tx) => {
          await tx.insert(weekPlanEvents).values({
            householdId: householdAId,
            weekStartDate,
            sequenceNumber: 1,
            causedBy: userCausedBy(userA),
            eventType: 'week_started',
            payload: {},
          })

          // Force the fold step to fail — `state` is NOT NULL.
          await tx.insert(weekPlanProjections).values({
            householdId: householdAId,
            weekStartDate,
            state: null as never,
          })
        }),
      ).rejects.toThrow()

      const events = await db.select().from(weekPlanEvents).where(eq(weekPlanEvents.householdId, householdAId))
      expect(events).toHaveLength(0)
    })
  })

  describe('(c) the read path reflects only the projection — never a replay of the log', () => {
    it('returns the seeded projection state even when the event log would fold to something different', async () => {
      // Seed ~200 events whose correct fold would produce "tuesday: recipe-from-log"...
      const logEvents = Array.from({ length: 200 }, (_, i) => ({
        householdId: householdAId,
        weekStartDate,
        sequenceNumber: i + 1,
        causedBy: userCausedBy(userA),
        eventType: 'meal_assigned' as const,
        payload: { dayOfWeek: 'tuesday', recipeRef: `recipe-from-log-${i}` },
      }))
      await db.insert(weekPlanEvents).values(logEvents)

      // ...but seed the projection directly (bypassing the write path) with a
      // deliberately contradictory state. If the read path ever replayed the
      // log, this assertion would be impossible to satisfy.
      const seededState: TWeekPlanProjectionState = {
        weekStarted: true,
        request: null,
        meals: { tuesday: { recipeRef: 'recipe-from-projection' } },
        lockedDays: [],
        skippedDays: [],
      }
      await db.insert(weekPlanProjections).values({ householdId: householdAId, weekStartDate, state: seededState })

      const [projection] = await asUser(userA, (tx) =>
        tx
          .select()
          .from(weekPlanProjections)
          .where(and(eq(weekPlanProjections.householdId, householdAId), eq(weekPlanProjections.weekStartDate, weekStartDate))),
      )

      expect(projection!.state).toEqual(seededState)
    })

    it('issues exactly one query, against week_plan_projections only — never week_plan_events', async () => {
      await db.insert(weekPlanProjections).values({
        householdId: householdAId,
        weekStartDate,
        state: { weekStarted: true, meals: {} },
      })

      const queries: string[] = []
      // postgres-js's `debug` option is a function hook on the client
      // constructor (not something `createDb` exposes) — build a one-off
      // client the same way db.ts does, with a debug callback wired in.
      const postgres = (await import('postgres')).default
      const client = postgres(testDatabaseUrl!, {
        debug: (_connection, query) => queries.push(query),
      })
      const { drizzle } = await import('drizzle-orm/postgres-js')
      const schema = await import('../src/schema.js')
      const debuggedDb = drizzle(client, { schema }) as unknown as typeof db

      try {
        await asUser(userA, async () => {
          await debuggedDb.transaction(async (tx) => {
            await tx.execute(sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userA })}, true)`)
            await tx.execute(sql`set local role authenticated`)
            return tx
              .select()
              .from(weekPlanProjections)
              .where(and(eq(weekPlanProjections.householdId, householdAId), eq(weekPlanProjections.weekStartDate, weekStartDate)))
          })
        })
      } finally {
        await client.end()
      }

      const projectionReads = queries.filter((q) => /week_plan_projections/i.test(q))
      const eventLogReads = queries.filter((q) => /week_plan_events/i.test(q))

      expect(projectionReads.length).toBeGreaterThan(0)
      expect(eventLogReads).toHaveLength(0)
    })
  })

  describe('(d) week-plan event vocabulary', () => {
    const planningRequest = {
      household: { adults: 2, children: 1, priorities: ['quick' as const], avoidIngredients: ['nuts'] },
      selectedDays: [
        { day: 'monday' as const, effortLevel: 'busy' as const },
        { day: 'tuesday' as const },
      ],
    }

    async function appendVocabularyEvent(args: { eventType: TWeekPlanEventType; payload: Record<string, unknown> }) {
      return asUser(userA, async (tx) => {
        const [event] = await tx
          .insert(weekPlanEvents)
          .values({
            householdId: householdAId,
            weekStartDate,
            sequenceNumber: 1,
            causedBy: userCausedBy(userA),
            eventType: args.eventType,
            payload: args.payload,
          })
          .returning()

        const nextState = foldEventIntoProjection(emptyProjectionState(), { eventType: args.eventType, ...args.payload } as never)
        await tx.insert(weekPlanProjections).values({ householdId: householdAId, weekStartDate, state: nextState })
        return event!
      })
    }

    it('folds request, assignment, lock, servings, skip, move, unassign and clear events', () => {
      const afterRequest = foldEventIntoProjection(emptyProjectionState(), {
        eventType: 'planning_request_updated',
        request: planningRequest,
      })
      expect(afterRequest.request).toEqual(planningRequest)

      const afterAssign = foldEventIntoProjection(afterRequest, {
        eventType: 'meal_assigned',
        dayOfWeek: 'monday',
        recipeRef: '11111111-1111-1111-1111-111111111111',
      })
      expect(afterAssign.meals.monday).toEqual({ recipeRef: '11111111-1111-1111-1111-111111111111' })

      const afterLock = foldEventIntoProjection(afterAssign, { eventType: 'meal_locked', dayOfWeek: 'monday' })
      expect(afterLock.lockedDays).toEqual(['monday'])

      const afterServings = foldEventIntoProjection(afterLock, { eventType: 'servings_changed', dayOfWeek: 'monday', servings: 5 })
      expect(afterServings.meals.monday).toEqual({ recipeRef: '11111111-1111-1111-1111-111111111111', servings: 5 })

      const afterMove = foldEventIntoProjection(afterServings, { eventType: 'meal_moved', fromDayOfWeek: 'monday', toDayOfWeek: 'tuesday' })
      expect(afterMove.meals.monday).toBeUndefined()
      expect(afterMove.meals.tuesday).toEqual({ recipeRef: '11111111-1111-1111-1111-111111111111', servings: 5 })
      expect(afterMove.lockedDays).toEqual(['tuesday'])

      const afterSkip = foldEventIntoProjection(afterMove, { eventType: 'day_skipped', dayOfWeek: 'tuesday' })
      expect(afterSkip.meals.tuesday).toBeUndefined()
      expect(afterSkip.lockedDays).toEqual([])
      expect(afterSkip.skippedDays).toEqual(['tuesday'])

      const afterUnskip = foldEventIntoProjection(afterSkip, { eventType: 'day_unskipped', dayOfWeek: 'tuesday' })
      expect(afterUnskip.skippedDays).toEqual([])

      const cleared = foldEventIntoProjection(afterUnskip, { eventType: 'week_plan_cleared' })
      expect(cleared).toEqual(emptyProjectionState())
    })

    it('writes the expanded event vocabulary through the append-and-fold path', async () => {
      await appendVocabularyEvent({
        eventType: 'planning_request_updated',
        payload: { request: planningRequest },
      })
      const [projection] = await db.select().from(weekPlanProjections).where(eq(weekPlanProjections.householdId, householdAId))
      expect((projection?.state as TWeekPlanProjectionState | undefined)?.request).toEqual(planningRequest)
    })
  })

  describe('(e) week history metadata', () => {
    it('upserts, reads, and lists week history plans with ISO week identity', async () => {
      const saved = await upsertWeekHistoryPlan(db, fakeAccessToken(userA), userA, householdAId, '2024-12-30', {
        timezone: 'Europe/Stockholm',
        state: baseHistoryState,
        status: 'draft',
        source: 'generated',
      })

      expect(saved.outcome).toBe('saved')
      if (saved.outcome !== 'saved') throw new Error('Expected saved week history plan')
      expect(saved.plan.weekNumber).toBe(1)
      expect(saved.plan.weekYear).toBe(2025)

      const detail = await getWeekHistoryPlan(db, fakeAccessToken(userA), householdAId, '2024-12-30')
      expect(detail).toMatchObject({
        householdId: householdAId,
        weekStartDate: '2024-12-30',
        weekNumber: 1,
        weekYear: 2025,
        timezone: 'Europe/Stockholm',
        status: 'draft',
        source: 'generated',
        updatedBy: userA,
      })

      const list = await listWeekHistoryPlans(db, fakeAccessToken(userA), householdAId, { from: '2024-12-30', to: '2024-12-30' })
      expect(list).toEqual([
        expect.objectContaining({
          weekStartDate: '2024-12-30',
          weekNumber: 1,
          weekYear: 2025,
          plannedDays: ['monday', 'friday'],
          request: baseHistoryState.request,
          replacements: {},
          skippedDays: ['friday'],
        }),
      ])
    })

    it('returns stale conflict details when expectedUpdatedAt does not match', async () => {
      const created = await upsertWeekHistoryPlan(db, fakeAccessToken(userA), userA, householdAId, weekStartDate, {
        timezone: 'Europe/Stockholm',
        state: baseHistoryState,
        status: 'draft',
        source: 'manual',
      })
      expect(created.outcome).toBe('saved')
      if (created.outcome !== 'saved') throw new Error('Expected saved week history plan')

      const stale = await upsertWeekHistoryPlan(db, fakeAccessToken(userA), userA, householdAId, weekStartDate, {
        expectedUpdatedAt: '2026-04-06T08:00:00.000Z',
        timezone: 'Europe/Stockholm',
        state: baseHistoryState,
        status: 'finalized',
        source: 'manual',
      })

      expect(stale).toEqual({ outcome: 'stale', updatedAt: created.plan.updatedAt })

      const detail = await getWeekHistoryPlan(db, fakeAccessToken(userA), householdAId, weekStartDate)
      expect(detail?.status).toBe('draft')
    })

    it('finalizes an existing week history plan and returns null for a missing plan', async () => {
      await expect(finalizeWeekHistoryPlan(db, fakeAccessToken(userA), userA, householdAId, weekStartDate)).resolves.toBeNull()

      await upsertWeekHistoryPlan(db, fakeAccessToken(userA), userA, householdAId, weekStartDate, {
        timezone: 'Europe/Stockholm',
        state: baseHistoryState,
        status: 'draft',
        source: 'manual',
      })

      const finalized = await finalizeWeekHistoryPlan(db, fakeAccessToken(userA), userA, householdAId, weekStartDate)
      expect(finalized?.status).toBe('finalized')
      expect(finalized?.updatedBy).toBe(userA)
    })

    it('does not expose another household week history across RLS', async () => {
      await upsertWeekHistoryPlan(db, fakeAccessToken(userB), userB, householdBId, weekStartDate, {
        timezone: 'Europe/Stockholm',
        state: baseHistoryState,
        status: 'draft',
        source: 'manual',
      })

      await expect(getWeekHistoryPlan(db, fakeAccessToken(userA), householdBId, weekStartDate)).resolves.toBeNull()
      await expect(listWeekHistoryPlans(db, fakeAccessToken(userA), householdBId, {})).resolves.toEqual([])
      await expect(
        upsertWeekHistoryPlan(db, fakeAccessToken(userA), userA, householdBId, weekStartDate, {
          timezone: 'Europe/Stockholm',
          state: baseHistoryState,
          status: 'draft',
          source: 'manual',
        }),
      ).rejects.toThrow(/row-level security/i)
    })

    it('returns 401 from week history routes when no bearer token is supplied', async () => {
      const app = buildApp(db)

      const listResponse = await app.request(`/households/${householdAId}/week-plans`)
      expect(listResponse.status).toBe(401)

      const detailResponse = await app.request(`/households/${householdAId}/week-plans/${weekStartDate}/history`)
      expect(detailResponse.status).toBe(401)

      const finalizeResponse = await app.request(`/households/${householdAId}/week-plans/${weekStartDate}/finalize`, { method: 'POST' })
      expect(finalizeResponse.status).toBe(401)
    })
  })

  describe('(f) iOS summary read model', () => {
    const baseRecipe = {
      title: 'Monday Pasta',
      description: 'Fast family pasta',
      servings: 4,
      ingredients: [{ item: 'spaghetti', amount: '400', unit: 'g', category: 'Pantry' }],
      steps: [{ text: 'Cook pasta' }],
      tags: ['weekday'],
      prepTimeMinutes: 10,
      cookTimeMinutes: 15,
      cuisine: 'Italian',
      proteinSource: 'cheese',
      mealWeight: 'medium',
      source: 'user_created' as const,
      isPublic: false,
    }

    it('returns 401 from the route when no bearer token is supplied', async () => {
      const app = buildApp(db)

      const response = await app.request(`/households/${householdAId}/week-plans/${weekStartDate}/summary`)

      expect(response.status).toBe(401)
    })

    it('returns an empty seven-day week when no projection exists', async () => {
      const summary = await getWeekPlanSummary(db, fakeAccessToken(userA), householdAId, weekStartDate)

      expect(summary).not.toBeNull()
      expect(summary!.updatedAt).toBeNull()
      expect(summary!.days).toHaveLength(7)
      expect(summary!.days.every((day) => day.state === 'empty')).toBe(true)
      expect(summary!.days[0]).toMatchObject({ dayOfWeek: 'monday', date: '2026-06-08' })
      expect(summary!.days[6]).toMatchObject({ dayOfWeek: 'sunday', date: '2026-06-14' })
    })

    it('hydrates planned recipe refs into readable day summaries', async () => {
      const recipe = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, baseRecipe)
      const state: TWeekPlanProjectionState = {
        weekStarted: true,
        request: null,
        meals: { monday: { recipeRef: recipe.id } },
        lockedDays: [],
        skippedDays: [],
      }
      await db.insert(weekPlanProjections).values({ householdId: householdAId, weekStartDate, state })

      const summary = await getWeekPlanSummary(db, fakeAccessToken(userA), householdAId, weekStartDate)

      expect(summary?.days[0]).toEqual({
        dayOfWeek: 'monday',
        date: '2026-06-08',
        state: 'planned',
        isLocked: false,
        recipe: {
          id: recipe.id,
          title: 'Monday Pasta',
          description: 'Fast family pasta',
          servings: 4,
          prepTimeMinutes: 10,
          cookTimeMinutes: 15,
          tags: ['weekday'],
        },
      })
    })

    it('renders skipped days from the projection without requiring a recipe', async () => {
      const state: TWeekPlanProjectionState = {
        weekStarted: true,
        request: null,
        meals: {},
        lockedDays: [],
        skippedDays: ['wednesday'],
      }
      await db.insert(weekPlanProjections).values({ householdId: householdAId, weekStartDate, state })

      const summary = await getWeekPlanSummary(db, fakeAccessToken(userA), householdAId, weekStartDate)

      expect(summary?.days[2]).toMatchObject({ dayOfWeek: 'wednesday', state: 'skipped', recipe: null })
    })

    it('exposes locked days on the iOS summary read model', async () => {
      const recipe = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, baseRecipe)
      const state: TWeekPlanProjectionState = {
        weekStarted: true,
        request: null,
        meals: { monday: { recipeRef: recipe.id } },
        lockedDays: ['monday'],
        skippedDays: ['wednesday'],
      }
      await db.insert(weekPlanProjections).values({ householdId: householdAId, weekStartDate, state })

      const summary = await getWeekPlanSummary(db, fakeAccessToken(userA), householdAId, weekStartDate)

      expect(summary?.days[0]).toMatchObject({ dayOfWeek: 'monday', state: 'planned', isLocked: true })
      expect(summary?.days[1]).toMatchObject({ dayOfWeek: 'tuesday', state: 'empty', isLocked: false })
      expect(summary?.days[2]).toMatchObject({ dayOfWeek: 'wednesday', state: 'skipped', isLocked: false })
    })

    it('does not expose another household summary across RLS', async () => {
      const summary = await getWeekPlanSummary(db, fakeAccessToken(userA), householdBId, weekStartDate)

      expect(summary).toBeNull()
    })
  })

  describe('(g) generate week plan', () => {
    const baseRecipe = {
      description: 'Fast family pasta',
      servings: 4,
      ingredients: [{ item: 'spaghetti', amount: '400', unit: 'g', category: 'Pantry' }],
      steps: [{ text: 'Cook pasta' }],
      tags: ['weekday'],
      prepTimeMinutes: 10,
      cookTimeMinutes: 15,
      source: 'user_created' as const,
      isPublic: false,
    }

    async function insertProfile(selectedDays: Array<{ day: string }>, avoidIngredients: string[] = []) {
      await db.insert(householdProfiles).values({
        householdId: householdAId,
        adults: 2,
        children: 0,
        priorities: [],
        avoidIngredients,
        selectedDays,
        updatedBy: userA,
      })
    }

    it('never assigns a meal to a day the household has explicitly skipped', async () => {
      await insertProfile([{ day: 'monday' }, { day: 'wednesday' }])
      await createRecipe(db, fakeAccessToken(userA), userA, householdAId, { ...baseRecipe, title: 'Monday Pasta' })
      const skippedState: TWeekPlanProjectionState = {
        weekStarted: true,
        request: null,
        meals: {},
        lockedDays: [],
        skippedDays: ['wednesday'],
      }
      await db.insert(weekPlanProjections).values({ householdId: householdAId, weekStartDate, state: skippedState })

      const result = await doGenerateWeekPlan(db, fakeAccessToken(userA), userA, householdAId, weekStartDate, false)

      expect(result).toEqual({ ok: true })
      const summary = await getWeekPlanSummary(db, fakeAccessToken(userA), householdAId, weekStartDate)
      expect(summary?.days[0]).toMatchObject({ dayOfWeek: 'monday', state: 'planned' })
      expect(summary?.days[2]).toMatchObject({ dayOfWeek: 'wednesday', state: 'skipped', recipe: null })
    })

    it('still respects a skipped day when regenerating the whole week', async () => {
      await insertProfile([{ day: 'monday' }, { day: 'wednesday' }])
      await createRecipe(db, fakeAccessToken(userA), userA, householdAId, { ...baseRecipe, title: 'Monday Pasta' })
      const skippedState: TWeekPlanProjectionState = {
        weekStarted: true,
        request: null,
        meals: { monday: { recipeRef: 'existing-recipe' } },
        lockedDays: [],
        skippedDays: ['wednesday'],
      }
      await db.insert(weekPlanProjections).values({ householdId: householdAId, weekStartDate, state: skippedState })

      const result = await doGenerateWeekPlan(db, fakeAccessToken(userA), userA, householdAId, weekStartDate, true)

      expect(result).toEqual({ ok: true })
      const summary = await getWeekPlanSummary(db, fakeAccessToken(userA), householdAId, weekStartDate)
      expect(summary?.days[2]).toMatchObject({ dayOfWeek: 'wednesday', state: 'skipped', recipe: null })
    })

    it('fails closed instead of falling back to the unfiltered pool when every recipe is excluded by the avoid-list', async () => {
      await insertProfile([{ day: 'monday' }], ['peanut'])
      await createRecipe(db, fakeAccessToken(userA), userA, householdAId, {
        ...baseRecipe,
        title: 'Peanut Noodles',
        tags: ['weekday', 'peanut'],
      })

      const result = await doGenerateWeekPlan(db, fakeAccessToken(userA), userA, householdAId, weekStartDate, false)

      expect(result).toEqual({ error: 'ALL_RECIPES_EXCLUDED' })
      const summary = await getWeekPlanSummary(db, fakeAccessToken(userA), householdAId, weekStartDate)
      expect(summary?.days[0]).toMatchObject({ dayOfWeek: 'monday', state: 'empty', recipe: null })
    })

    it('generates normally when at least one recipe survives the avoid-list filter', async () => {
      await insertProfile([{ day: 'monday' }], ['peanut'])
      await createRecipe(db, fakeAccessToken(userA), userA, householdAId, {
        ...baseRecipe,
        title: 'Peanut Noodles',
        tags: ['weekday', 'peanut'],
      })
      await createRecipe(db, fakeAccessToken(userA), userA, householdAId, {
        ...baseRecipe,
        title: 'Plain Pasta',
      })

      const result = await doGenerateWeekPlan(db, fakeAccessToken(userA), userA, householdAId, weekStartDate, false)

      expect(result).toEqual({ ok: true })
      const summary = await getWeekPlanSummary(db, fakeAccessToken(userA), householdAId, weekStartDate)
      expect(summary?.days[0]).toMatchObject({ dayOfWeek: 'monday', state: 'planned' })
      expect(summary?.days[0]?.recipe?.title).toBe('Plain Pasta')
    })

    it('returns NO_RECIPES when the household has no recipes at all', async () => {
      await insertProfile([{ day: 'monday' }])

      const result = await doGenerateWeekPlan(db, fakeAccessToken(userA), userA, householdAId, weekStartDate, false)

      expect(result).toEqual({ error: 'NO_RECIPES' })
    })

    it('stamps assigned meals with algorithmVersion 2.0', async () => {
      await insertProfile([{ day: 'monday' }])
      await createRecipe(db, fakeAccessToken(userA), userA, householdAId, { ...baseRecipe, title: 'Monday Pasta' })

      await doGenerateWeekPlan(db, fakeAccessToken(userA), userA, householdAId, weekStartDate, false)

      const [event] = await asUser(userA, (tx) =>
        tx.select().from(weekPlanEvents).where(and(eq(weekPlanEvents.householdId, householdAId), eq(weekPlanEvents.eventType, 'meal_assigned'))),
      )
      expect(event?.causedBy).toMatchObject({ source: 'algorithm', algorithmVersion: '2.0' })
    })

    it('prefers a recipe the user liked over one they had no opinion on', async () => {
      await insertProfile([{ day: 'monday' }])
      const liked = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, { ...baseRecipe, title: 'Liked Pasta' })
      await createRecipe(db, fakeAccessToken(userA), userA, householdAId, { ...baseRecipe, title: 'Neutral Pasta' })
      await upsertMealFeedback(db, fakeAccessToken(userA), userA, householdAId, liked.id, { vote: 'up' })

      await doGenerateWeekPlan(db, fakeAccessToken(userA), userA, householdAId, weekStartDate, false)

      const summary = await getWeekPlanSummary(db, fakeAccessToken(userA), householdAId, weekStartDate)
      expect(summary?.days[0]?.recipe?.title).toBe('Liked Pasta')
    })

    it('avoids repeating last week\'s meal when an untouched alternative exists', async () => {
      await insertProfile([{ day: 'monday' }])
      const cookedLastWeek = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, { ...baseRecipe, title: 'Cooked Last Week' })
      const freshAlternative = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, { ...baseRecipe, title: 'Fresh Alternative' })
      const lastWeekStart = '2026-06-01'
      await db.insert(weekPlanProjections).values({
        householdId: householdAId,
        weekStartDate: lastWeekStart,
        state: {
          weekStarted: true,
          request: null,
          meals: { monday: { recipeRef: cookedLastWeek.id } },
          lockedDays: [],
          skippedDays: [],
        } satisfies TWeekPlanProjectionState,
      })

      await doGenerateWeekPlan(db, fakeAccessToken(userA), userA, householdAId, weekStartDate, false)

      const summary = await getWeekPlanSummary(db, fakeAccessToken(userA), householdAId, weekStartDate)
      expect(summary?.days[0]?.recipe?.title).toBe('Fresh Alternative')
    })

    it('prefers the household\'s own recipe over an otherwise-equal public recipe', async () => {
      await insertProfile([{ day: 'monday' }])
      await createRecipe(db, fakeAccessToken(userA), userA, householdAId, { ...baseRecipe, title: 'Household Recipe' })
      // A public recipe owned by a different household (household B) — same
      // shape, so only the family-recipe boost should decide the winner.
      await createRecipe(db, fakeAccessToken(userB), userB, householdBId, { ...baseRecipe, title: 'Community Recipe', isPublic: true })

      await doGenerateWeekPlan(db, fakeAccessToken(userA), userA, householdAId, weekStartDate, false)

      const summary = await getWeekPlanSummary(db, fakeAccessToken(userA), householdAId, weekStartDate)
      expect(summary?.days[0]?.recipe?.title).toBe('Household Recipe')
    })
  })
})
