import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { createDb } from '../src/db.js'
import { createRecipe } from '../src/recipes.js'
import { households, householdMemberships, householdProfiles, recipes, shoppingListEvents, shoppingListProjections, weekPlanProjections } from '../src/schema.js'
import {
  foldEventIntoProjection,
  emptyProjectionState,
  getShoppingListState,
  getShoppingListSummary,
  replaceShoppingListState,
  type TShoppingListProjectionState,
} from '../src/shopping-list.js'
import { fakeAccessToken } from './fake-access-token.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL

const describeWithDb = testDatabaseUrl ? describe : describe.skip

describeWithDb('Shopping-list event log + projection', () => {
  const db = createDb(testDatabaseUrl!)

  const userA = '11111111-1111-1111-1111-111111111111'
  const userB = '22222222-2222-2222-2222-222222222222'
  let householdAId: string
  let householdBId: string

  const weekStartDate = '2026-06-08'

  // Migrations and the `authenticated` role grant (including the write
  // privileges this slice is the first to need on these two tables) are
  // applied once, globally, before any suite starts — see test/global-setup.ts.

  beforeEach(async () => {
    await db.execute(sql`delete from "recipes"`)
    await db.execute(sql`delete from "week_plan_projections"`)
    await db.execute(sql`delete from "shopping_list_events"`)
    await db.execute(sql`delete from "shopping_list_projections"`)
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
    await db.execute(sql`delete from "recipes"`)
    await db.execute(sql`delete from "week_plan_projections"`)
    await db.execute(sql`delete from "shopping_list_events"`)
    await db.execute(sql`delete from "shopping_list_projections"`)
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

  async function appendAsUser(
    userId: string,
    args: {
      householdId: string
      sequenceNumber: number
      eventType: 'list_started' | 'item_checked' | 'shopping_state_replaced' | 'shopping_list_cleared'
      payload: Record<string, unknown>
    },
  ) {
    return asUser(userId, async (tx) => {
      const [event] = await tx
        .insert(shoppingListEvents)
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
      await db.insert(shoppingListProjections).values({
        householdId: householdBId,
        weekStartDate,
        state: { listStarted: true, checkedItems: {}, pantryStock: {}, customItems: [] },
      })

      const rows = await asUser(userA, (tx) =>
        tx
          .select()
          .from(shoppingListProjections)
          .where(and(eq(shoppingListProjections.householdId, householdBId), eq(shoppingListProjections.weekStartDate, weekStartDate))),
      )

      expect(rows).toHaveLength(0)
    })

    it('refuses to insert an event into a household the user is not an active member of', async () => {
      await expect(
        appendAsUser(userA, { householdId: householdBId, sequenceNumber: 1, eventType: 'list_started', payload: {} }),
      ).rejects.toThrow(/row-level security/i)
    })
  })

  describe('(b) append + projection-update is genuinely atomic', () => {
    async function appendViaWritePath(args: {
      householdId: string
      sequenceNumber: number
      eventType: 'list_started' | 'item_checked' | 'shopping_state_replaced' | 'shopping_list_cleared'
      payload: Record<string, unknown>
    }) {
      // Mirrors appendShoppingListEvent's shape without importing the route's
      // private helper — runs the same insert-then-fold sequence against one
      // transaction so atomicity can be exercised and broken deliberately.
      return asUser(userA, async (tx) => {
        const [event] = await tx
          .insert(shoppingListEvents)
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
          .select({ state: shoppingListProjections.state })
          .from(shoppingListProjections)
          .where(and(eq(shoppingListProjections.householdId, args.householdId), eq(shoppingListProjections.weekStartDate, weekStartDate)))

        const currentState = (existing?.state as TShoppingListProjectionState | undefined) ?? emptyProjectionState()
        const nextState = foldEventIntoProjection(currentState, { eventType: args.eventType, ...args.payload } as never)

        await tx
          .insert(shoppingListProjections)
          .values({ householdId: args.householdId, weekStartDate, state: nextState })
          .onConflictDoUpdate({
            target: [shoppingListProjections.householdId, shoppingListProjections.weekStartDate],
            set: { state: nextState, updatedAt: new Date() },
          })

        return event!
      })
    }

    it('persists the event and the folded projection together, from the same transaction', async () => {
      await appendViaWritePath({ householdId: householdAId, sequenceNumber: 1, eventType: 'list_started', payload: {} })
      await appendViaWritePath({
        householdId: householdAId,
        sequenceNumber: 2,
        eventType: 'item_checked',
        payload: { itemKey: 'milk', checked: true },
      })

      const [event] = await db.select().from(shoppingListEvents).where(eq(shoppingListEvents.sequenceNumber, 2))
      const [projection] = await db.select().from(shoppingListProjections).where(eq(shoppingListProjections.householdId, householdAId))

      expect(event).toBeDefined()
      expect(projection).toBeDefined()
      expect(projection!.state).toEqual({ listStarted: true, checkedItems: { milk: true }, pantryStock: {}, customItems: [] })
    })

    it('rolls back the event insert if the projection step fails — never one without the other', async () => {
      await expect(
        asUser(userA, async (tx) => {
          await tx.insert(shoppingListEvents).values({
            householdId: householdAId,
            weekStartDate,
            sequenceNumber: 1,
            causedBy: userCausedBy(userA),
            eventType: 'list_started',
            payload: {},
          })

          // Force the fold step to fail — `state` is NOT NULL.
          await tx.insert(shoppingListProjections).values({
            householdId: householdAId,
            weekStartDate,
            state: null as never,
          })
        }),
      ).rejects.toThrow()

      const events = await db.select().from(shoppingListEvents).where(eq(shoppingListEvents.householdId, householdAId))
      expect(events).toHaveLength(0)
    })
  })

  describe('(c) the read path reflects only the projection — never a replay of the log', () => {
    it('returns the seeded projection state even when the event log would fold to something different', async () => {
      // Seed ~200 events whose correct fold would produce "bread: checked"...
      const logEvents = Array.from({ length: 200 }, (_, i) => ({
        householdId: householdAId,
        weekStartDate,
        sequenceNumber: i + 1,
        causedBy: userCausedBy(userA),
        eventType: 'item_checked' as const,
        payload: { itemKey: 'bread', checked: true },
      }))
      await db.insert(shoppingListEvents).values(logEvents)

      // ...but seed the projection directly (bypassing the write path) with a
      // deliberately contradictory state. If the read path ever replayed the
      // log, this assertion would be impossible to satisfy.
      const seededState: TShoppingListProjectionState = { listStarted: true, checkedItems: { bread: false }, pantryStock: {}, customItems: [] }
      await db.insert(shoppingListProjections).values({ householdId: householdAId, weekStartDate, state: seededState })

      const [projection] = await asUser(userA, (tx) =>
        tx
          .select()
          .from(shoppingListProjections)
          .where(and(eq(shoppingListProjections.householdId, householdAId), eq(shoppingListProjections.weekStartDate, weekStartDate))),
      )

      expect(projection!.state).toEqual(seededState)
    })

    it('issues exactly one query, against shopping_list_projections only — never shopping_list_events', async () => {
      await db.insert(shoppingListProjections).values({
        householdId: householdAId,
        weekStartDate,
        state: { listStarted: true, checkedItems: {}, pantryStock: {}, customItems: [] },
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
              .from(shoppingListProjections)
              .where(and(eq(shoppingListProjections.householdId, householdAId), eq(shoppingListProjections.weekStartDate, weekStartDate)))
          })
        })
      } finally {
        await client.end()
      }

      const projectionReads = queries.filter((q) => /shopping_list_projections/i.test(q))
      const eventLogReads = queries.filter((q) => /shopping_list_events/i.test(q))

      expect(projectionReads.length).toBeGreaterThan(0)
      expect(eventLogReads).toHaveLength(0)
    })
  })

  describe('(d) shared shopping state compatibility', () => {
    it('replaces checklist and pantry state through the projection-backed write path', async () => {
      const result = await replaceShoppingListState(db, fakeAccessToken(userA), {
        householdId: householdAId,
        weekStartDate,
        causedBy: userCausedBy(userA),
        state: { checkedItems: ['rice:g', 'tomatoes:can'], pantryStock: { 'rice:g': 100 }, customItems: [] },
      })

      expect(result.outcome).toBe('updated')

      const state = await getShoppingListState(db, fakeAccessToken(userA), householdAId, weekStartDate)
      expect(state.state).toEqual({
        checkedItems: ['rice:g', 'tomatoes:can'],
        pantryStock: { 'rice:g': 100 },
        customItems: [],
      })
      expect(state.updatedAt).toEqual(result.updatedAt)

      const [event] = await db.select().from(shoppingListEvents).where(eq(shoppingListEvents.householdId, householdAId))
      expect(event!.eventType).toBe('shopping_state_replaced')
      expect(event!.payload).toEqual({ state: { checkedItems: ['rice:g', 'tomatoes:can'], pantryStock: { 'rice:g': 100 }, customItems: [] } })
    })

    it('returns null state when no projection exists or after the state is cleared', async () => {
      const missing = await getShoppingListState(db, fakeAccessToken(userA), householdAId, weekStartDate)
      expect(missing).toEqual({ state: null, updatedAt: null })

      const created = await replaceShoppingListState(db, fakeAccessToken(userA), {
        householdId: householdAId,
        weekStartDate,
        causedBy: userCausedBy(userA),
        state: { checkedItems: ['rice:g'], pantryStock: { 'rice:g': 100 }, customItems: [] },
      })
      expect(created.outcome).toBe('updated')

      const cleared = await replaceShoppingListState(db, fakeAccessToken(userA), {
        householdId: householdAId,
        weekStartDate,
        causedBy: userCausedBy(userA),
        expectedUpdatedAt: created.updatedAt,
        state: null,
      })
      expect(cleared).toEqual({ outcome: 'updated', updatedAt: null })

      const state = await getShoppingListState(db, fakeAccessToken(userA), householdAId, weekStartDate)
      expect(state).toEqual({ state: null, updatedAt: null })

      const replacedAfterClear = await replaceShoppingListState(db, fakeAccessToken(userA), {
        householdId: householdAId,
        weekStartDate,
        causedBy: userCausedBy(userA),
        expectedUpdatedAt: null,
        state: { checkedItems: ['pasta:g'], pantryStock: {}, customItems: [] },
      })
      expect(replacedAfterClear.outcome).toBe('updated')

      const events = await db
        .select({ eventType: shoppingListEvents.eventType, sequenceNumber: shoppingListEvents.sequenceNumber })
        .from(shoppingListEvents)
        .where(eq(shoppingListEvents.householdId, householdAId))
        .orderBy(shoppingListEvents.sequenceNumber)

      expect(events).toEqual([
        { sequenceNumber: 1, eventType: 'shopping_state_replaced' },
        { sequenceNumber: 2, eventType: 'shopping_list_cleared' },
        { sequenceNumber: 3, eventType: 'shopping_state_replaced' },
      ])
    })

    it('returns stale conflict details when expectedUpdatedAt does not match the projection', async () => {
      const created = await replaceShoppingListState(db, fakeAccessToken(userA), {
        householdId: householdAId,
        weekStartDate,
        causedBy: userCausedBy(userA),
        state: { checkedItems: ['rice:g'], pantryStock: {}, customItems: [] },
      })
      expect(created.outcome).toBe('updated')

      const stale = await replaceShoppingListState(db, fakeAccessToken(userA), {
        householdId: householdAId,
        weekStartDate,
        causedBy: userCausedBy(userA),
        expectedUpdatedAt: '2026-04-06T04:00:00.000Z',
        state: { checkedItems: ['pasta:g'], pantryStock: { 'pasta:g': 250 }, customItems: [] },
      })

      expect(stale).toEqual({ outcome: 'stale', updatedAt: created.updatedAt })

      const state = await getShoppingListState(db, fakeAccessToken(userA), householdAId, weekStartDate)
      expect(state.state).toEqual({ checkedItems: ['rice:g'], pantryStock: {}, customItems: [] })
    })

    it('returns 401 from the state route when no bearer token is supplied', async () => {
      const app = buildApp(db)

      const getResponse = await app.request(`/households/${householdAId}/shopping-lists/${weekStartDate}/state`)
      expect(getResponse.status).toBe(401)

      const patchResponse = await app.request(`/households/${householdAId}/shopping-lists/${weekStartDate}/state`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: { checkedItems: [], pantryStock: {}, customItems: [] } }),
      })
      expect(patchResponse.status).toBe(401)
    })
  })

  describe('(e) iOS summary read model', () => {
    const baseRecipe = {
      title: 'Monday Pasta',
      description: 'Fast family pasta',
      servings: 4,
      ingredients: [
        { item: 'spaghetti', amount: '400', unit: 'g', category: 'Pantry' },
        { item: 'tomatoes', amount: '2', unit: 'can', category: 'Produce' },
      ],
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

      const response = await app.request(`/households/${householdAId}/shopping-lists/${weekStartDate}/summary`)

      expect(response.status).toBe(401)
    })

    it('returns an empty shopping summary when no week plan exists', async () => {
      const summary = await getShoppingListSummary(db, fakeAccessToken(userA), householdAId, weekStartDate, { today: weekStartDate })

      expect(summary).not.toBeNull()
      expect(summary!.updatedAt).toBeNull()
      expect(summary!.groups).toEqual([])
    })

    it('groups planned recipe ingredients deterministically and applies checked state', async () => {
      const recipe = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, baseRecipe)
      await db.insert(weekPlanProjections).values({
        householdId: householdAId,
        weekStartDate,
        state: { weekStarted: true, meals: { monday: { recipeRef: recipe.id } } },
      })
      await db.insert(shoppingListProjections).values({
        householdId: householdAId,
        weekStartDate,
        state: { listStarted: true, checkedItems: { 'pantry:spaghetti:g': true }, pantryStock: {}, customItems: [] },
      })

      const summary = await getShoppingListSummary(db, fakeAccessToken(userA), householdAId, weekStartDate, { today: weekStartDate })

      expect(summary?.groups).toEqual([
        {
          category: 'Pantry',
          items: [{ itemKey: 'pantry:spaghetti:g', label: 'spaghetti', amount: '400', unit: 'g', checked: true, isCustom: false }],
        },
        {
          category: 'Produce',
          items: [{ itemKey: 'produce:tomatoes:can', label: 'tomatoes', amount: '2', unit: 'can', checked: false, isCustom: false }],
        },
      ])
    })

    it('merges singular and plural variants only when both are present', async () => {
      const recipe = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, {
        ...baseRecipe,
        title: 'Vegetable sides',
        ingredients: [
          { item: 'carrot', amount: '0.3', unit: 'pc', category: 'Produce' },
          { item: 'carrots', amount: '0.8', unit: 'pc', category: 'Produce' },
          { item: 'tomatoes', amount: '2', unit: 'can', category: 'Produce' },
        ],
      })
      await db.insert(weekPlanProjections).values({
        householdId: householdAId,
        weekStartDate,
        state: { weekStarted: true, meals: { monday: { recipeRef: recipe.id } } },
      })
      await db.insert(shoppingListProjections).values({
        householdId: householdAId,
        weekStartDate,
        state: { listStarted: true, checkedItems: { 'produce:carrots:pc': true }, pantryStock: {}, customItems: [] },
      })

      const summary = await getShoppingListSummary(db, fakeAccessToken(userA), householdAId, weekStartDate, { today: weekStartDate })

      expect(summary?.groups).toEqual([
        {
          category: 'Produce',
          items: [
            { itemKey: 'produce:carrot:pc', label: 'carrots', amount: '1.1', unit: 'pc', checked: true, isCustom: false },
            { itemKey: 'produce:tomatoes:can', label: 'tomatoes', amount: '2', unit: 'can', checked: false, isCustom: false },
          ],
        },
      ])
    })

    it('localizes common builtin ingredient labels for Swedish shopping summaries', async () => {
      const recipe = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, {
        ...baseRecipe,
        title: 'Rice bowl',
        ingredients: [
          { item: 'chicken breast', amount: '150', unit: 'g', category: 'Protein' },
          { item: 'bell peppers', amount: '1', unit: 'pc', category: 'Produce' },
          { item: 'soy sauce', amount: '1.5', unit: 'tbsp', category: 'Pantry' },
        ],
      })
      await db.update(recipes)
        .set({ householdId: null, source: 'builtin', isPublic: true })
        .where(eq(recipes.id, recipe.id))
      await db.insert(weekPlanProjections).values({
        householdId: householdAId,
        weekStartDate,
        state: { weekStarted: true, meals: { monday: { recipeRef: recipe.id } } },
      })
      await db.insert(shoppingListProjections).values({
        householdId: householdAId,
        weekStartDate,
        state: { listStarted: true, checkedItems: { 'protein:chicken-breast:g': true }, pantryStock: {}, customItems: [] },
      })

      const summary = await getShoppingListSummary(db, fakeAccessToken(userA), householdAId, weekStartDate, { language: 'sv', today: weekStartDate })

      expect(summary?.groups).toEqual([
        {
          category: 'Pantry',
          items: [{ itemKey: 'pantry:soy-sauce:tbsp', label: 'soja', amount: '1.5', unit: 'msk', checked: false, isCustom: false }],
        },
        {
          category: 'Produce',
          items: [{ itemKey: 'produce:bell-peppers:pc', label: 'paprika', amount: '1', unit: 'st', checked: false, isCustom: false }],
        },
        {
          category: 'Protein',
          items: [{ itemKey: 'protein:chicken-breast:g', label: 'kycklingfilé', amount: '150', unit: 'g', checked: true, isCustom: false }],
        },
      ])
    })

    it('excludes meals that are already in the past from the shopping summary', async () => {
      const mondayRecipe = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, {
        ...baseRecipe,
        title: 'Monday dinner',
        ingredients: [{ item: 'spaghetti', amount: '400', unit: 'g', category: 'Pantry' }],
      })
      const wednesdayRecipe = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, {
        ...baseRecipe,
        title: 'Wednesday dinner',
        ingredients: [{ item: 'rice', amount: '300', unit: 'g', category: 'Pantry' }],
      })
      await db.insert(weekPlanProjections).values({
        householdId: householdAId,
        weekStartDate,
        state: {
          weekStarted: true,
          meals: {
            monday: { recipeRef: mondayRecipe.id },
            wednesday: { recipeRef: wednesdayRecipe.id },
          },
        },
      })

      const summary = await getShoppingListSummary(db, fakeAccessToken(userA), householdAId, weekStartDate, { today: '2026-06-10' })

      expect(summary?.groups).toEqual([
        {
          category: 'Pantry',
          items: [{ itemKey: 'pantry:rice:g', label: 'rice', amount: '300', unit: 'g', checked: false, isCustom: false }],
        },
      ])
    })

    it('includes newly planned future meals while filtering older meals from the active shopping basket', async () => {
      const tuesdayRecipe = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, {
        ...baseRecipe,
        title: 'Tuesday bowl',
        ingredients: [{ item: 'chicken breast', amount: '150', unit: 'g', category: 'Protein' }],
      })
      const wednesdayRecipe = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, {
        ...baseRecipe,
        title: 'Wednesday carbonara',
        ingredients: [{ item: 'bacon or pancetta', amount: '200', unit: 'g', category: 'Protein' }],
      })
      await db.insert(weekPlanProjections).values({
        householdId: householdAId,
        weekStartDate,
        state: {
          weekStarted: true,
          meals: {
            tuesday: { recipeRef: tuesdayRecipe.id },
            wednesday: { recipeRef: wednesdayRecipe.id },
          },
        },
      })

      const summary = await getShoppingListSummary(db, fakeAccessToken(userA), householdAId, weekStartDate, { today: '2026-06-10' })

      expect(summary?.groups).toEqual([
        {
          category: 'Protein',
          items: [{ itemKey: 'protein:bacon-or-pancetta:g', label: 'bacon or pancetta', amount: '200', unit: 'g', checked: false, isCustom: false }],
        },
      ])
    })

    it('does not expose another household shopping summary across RLS', async () => {
      const summary = await getShoppingListSummary(db, fakeAccessToken(userA), householdBId, weekStartDate)

      expect(summary).toBeNull()
    })

    it('includes custom shopping items in the same grouped summary', async () => {
      await db.insert(shoppingListProjections).values({
        householdId: householdAId,
        weekStartDate,
        state: {
          listStarted: true,
          checkedItems: { 'custom:bananas': true },
          pantryStock: {},
          customItems: [
            { itemKey: 'custom:bananas', label: 'Bananas', category: 'Other' },
          ],
        },
      })

      const summary = await getShoppingListSummary(db, fakeAccessToken(userA), householdAId, weekStartDate)

      expect(summary?.groups).toEqual([
        {
          category: 'Other',
          items: [{ itemKey: 'custom:bananas', label: 'Bananas', amount: null, unit: null, checked: true, isCustom: true }],
        },
      ])
    })

    it('deduplicates custom shopping items by label and category in summary and state reads', async () => {
      await db.insert(shoppingListProjections).values({
        householdId: householdAId,
        weekStartDate,
        state: {
          listStarted: true,
          checkedItems: {},
          pantryStock: {},
          customItems: [
            { itemKey: 'custom:first-servetter', label: 'Servetter', category: 'Other' },
            { itemKey: 'custom:second-servetter', label: ' servetter ', category: 'Other' },
          ],
        },
      })

      const summary = await getShoppingListSummary(db, fakeAccessToken(userA), householdAId, weekStartDate)
      const state = await getShoppingListState(db, fakeAccessToken(userA), householdAId, weekStartDate)

      expect(summary?.groups).toEqual([
        {
          category: 'Other',
          items: [{ itemKey: 'custom:first-servetter', label: 'Servetter', amount: null, unit: null, checked: false, isCustom: true }],
        },
      ])
      expect(state.state?.customItems).toEqual([
        { itemKey: 'custom:first-servetter', label: 'Servetter', category: 'Other' },
      ])
    })
  })

  describe('(f) per-meal portion scaling before aggregation (Fas 2)', () => {
    const baseRecipe = {
      title: 'Base recipe',
      description: 'Fast family dinner',
      servings: 4,
      ingredients: [{ item: 'placeholder', amount: '1', unit: 'g', category: 'Pantry' }],
      steps: [{ text: 'Cook' }],
      tags: ['weekday'],
      prepTimeMinutes: 10,
      cookTimeMinutes: 15,
      cuisine: 'Italian',
      proteinSource: 'cheese',
      mealWeight: 'medium',
      source: 'user_created' as const,
      isPublic: false,
    }

    async function insertProfile(adults: number, children: number) {
      await db.insert(householdProfiles).values({
        householdId: householdAId,
        adults,
        children,
        priorities: [],
        avoidIngredients: [],
        selectedDays: [{ day: 'monday' }],
        updatedBy: userA,
      })
    }

    it('scales recipes with different base servings (2, 4, 6) to the household size before summing', async () => {
      await insertProfile(2, 2) // householdSize = 4

      const twoServing = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, {
        ...baseRecipe,
        title: 'Two-serving pasta',
        servings: 2,
        ingredients: [{ item: 'pasta', amount: '100', unit: 'g', category: 'Pantry' }],
      })
      const fourServing = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, {
        ...baseRecipe,
        title: 'Four-serving salad',
        servings: 4,
        ingredients: [{ item: 'lettuce', amount: '50', unit: 'g', category: 'Produce' }],
      })
      const sixServing = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, {
        ...baseRecipe,
        title: 'Six-serving soup',
        servings: 6,
        ingredients: [{ item: 'broth', amount: '300', unit: 'ml', category: 'Pantry' }],
      })

      await db.insert(weekPlanProjections).values({
        householdId: householdAId,
        weekStartDate,
        state: {
          weekStarted: true,
          meals: {
            monday: { recipeRef: twoServing.id },
            tuesday: { recipeRef: fourServing.id },
            wednesday: { recipeRef: sixServing.id },
          },
        },
      })

      const summary = await getShoppingListSummary(db, fakeAccessToken(userA), householdAId, weekStartDate, { today: weekStartDate })

      // pasta: 100 * (4 / 2) = 200 ; broth: 300 * (4 / 6) = 200 ; lettuce: 50 * (4 / 4) = 50
      expect(summary?.groups).toEqual([
        {
          category: 'Pantry',
          items: [
            { itemKey: 'pantry:broth:ml', label: 'broth', amount: '200', unit: 'ml', checked: false, isCustom: false },
            { itemKey: 'pantry:pasta:g', label: 'pasta', amount: '200', unit: 'g', checked: false, isCustom: false },
          ],
        },
        {
          category: 'Produce',
          items: [{ itemKey: 'produce:lettuce:g', label: 'lettuce', amount: '50', unit: 'g', checked: false, isCustom: false }],
        },
      ])
    })

    it('prefers the meal servings override over the household size', async () => {
      await insertProfile(2, 2) // householdSize = 4, would otherwise apply

      const recipe = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, {
        ...baseRecipe,
        title: 'Rice bowl',
        servings: 4,
        ingredients: [{ item: 'rice', amount: '100', unit: 'g', category: 'Pantry' }],
      })
      await db.insert(weekPlanProjections).values({
        householdId: householdAId,
        weekStartDate,
        state: { weekStarted: true, meals: { monday: { recipeRef: recipe.id, servings: 8 } } },
      })

      const summary = await getShoppingListSummary(db, fakeAccessToken(userA), householdAId, weekStartDate, { today: weekStartDate })

      // 100 * (8 / 4) = 200 — the override (8), not the household size (4), drives the scale.
      expect(summary?.groups).toEqual([
        { category: 'Pantry', items: [{ itemKey: 'pantry:rice:g', label: 'rice', amount: '200', unit: 'g', checked: false, isCustom: false }] },
      ])
    })

    it('falls back to the household size when no meal servings override is set', async () => {
      await insertProfile(3, 1) // householdSize = 4

      const recipe = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, {
        ...baseRecipe,
        title: 'Flour bake',
        servings: 2,
        ingredients: [{ item: 'flour', amount: '50', unit: 'g', category: 'Pantry' }],
      })
      await db.insert(weekPlanProjections).values({
        householdId: householdAId,
        weekStartDate,
        state: { weekStarted: true, meals: { monday: { recipeRef: recipe.id } } },
      })

      const summary = await getShoppingListSummary(db, fakeAccessToken(userA), householdAId, weekStartDate, { today: weekStartDate })

      // 50 * (4 / 2) = 100
      expect(summary?.groups).toEqual([
        { category: 'Pantry', items: [{ itemKey: 'pantry:flour:g', label: 'flour', amount: '100', unit: 'g', checked: false, isCustom: false }] },
      ])
    })

    it('leaves the amount unscaled when there is no override and no household profile', async () => {
      // No insertProfile call — no household_profiles row exists for this household.

      const recipe = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, {
        ...baseRecipe,
        title: 'Oat porridge',
        servings: 6,
        ingredients: [{ item: 'oats', amount: '60', unit: 'g', category: 'Pantry' }],
      })
      await db.insert(weekPlanProjections).values({
        householdId: householdAId,
        weekStartDate,
        state: { weekStarted: true, meals: { monday: { recipeRef: recipe.id } } },
      })

      const summary = await getShoppingListSummary(db, fakeAccessToken(userA), householdAId, weekStartDate, { today: weekStartDate })

      // plannedMealServings falls back all the way to recipeBaseServings (6) → scale factor 1.
      expect(summary?.groups).toEqual([
        { category: 'Pantry', items: [{ itemKey: 'pantry:oats:g', label: 'oats', amount: '60', unit: 'g', checked: false, isCustom: false }] },
      ])
    })

    it('regression: the same recipe planned on two days contributes twice, each scaled by that day\'s own servings', async () => {
      await insertProfile(2, 0) // householdSize = 2

      const recipe = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, {
        ...baseRecipe,
        title: 'Repeated butter chicken',
        servings: 4,
        ingredients: [{ item: 'butter', amount: '100', unit: 'g', category: 'Pantry' }],
      })
      await db.insert(weekPlanProjections).values({
        householdId: householdAId,
        weekStartDate,
        state: {
          weekStarted: true,
          meals: {
            // Monday: no override → falls back to household size (2). Scale 2/4 = 0.5 → 50.
            monday: { recipeRef: recipe.id },
            // Thursday: explicit override (10). Scale 10/4 = 2.5 → 250.
            thursday: { recipeRef: recipe.id, servings: 10 },
          },
        },
      })

      const summary = await getShoppingListSummary(db, fakeAccessToken(userA), householdAId, weekStartDate, { today: weekStartDate })

      // Before the Fas 2 fix, `recipeIds` deduplicated to a single row via the
      // SQL `IN` clause and `ingredientRows` flatMapped over recipe rows (not
      // day occurrences) — so the second planned occurrence of the same
      // recipe never contributed at all. This must be 300 (50 + 250) in a
      // single merged row, not 50 or 250 alone, and not two separate rows.
      expect(summary?.groups).toEqual([
        { category: 'Pantry', items: [{ itemKey: 'pantry:butter:g', label: 'butter', amount: '300', unit: 'g', checked: false, isCustom: false }] },
      ])
    })
  })
})
