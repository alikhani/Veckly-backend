import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { createDb } from '../src/db.js'
import { households, householdMemberships, recipes, userSavedRecipes } from '../src/schema.js'
import { createRecipe, listRecipes, getRecipe, updateRecipe, listPublicRecipes, listSavedRecipes, saveRecipe, unsaveRecipe } from '../src/recipes.js'
import { fakeAccessToken } from './fake-access-token.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const describeWithDb = testDatabaseUrl ? describe : describe.skip

describeWithDb('Recipes + RLS', () => {
  const db = createDb(testDatabaseUrl!)

  const userA = '11111111-1111-1111-1111-111111111111'
  const userB = '22222222-2222-2222-2222-222222222222'
  let householdAId: string
  let householdBId: string

  const baseRecipe = {
    title: 'Pasta Carbonara',
    description: 'A classic Roman pasta dish',
    servings: 4,
    ingredients: [{ item: 'spaghetti', amount: '400', unit: 'g' }, { item: 'eggs', amount: '4' }],
    steps: [{ text: 'Boil pasta' }, { text: 'Mix eggs and cheese' }],
    tags: ['italian', 'pasta'],
    prepTimeMinutes: 10,
    cookTimeMinutes: 20,
    cuisine: 'Italian',
    proteinSource: 'eggs',
    mealWeight: 'medium',
    source: 'user_created' as const,
    isPublic: false,
  }

  beforeEach(async () => {
    await db.execute(sql`delete from "user_saved_recipes"`)
    await db.execute(sql`delete from "recipes"`)
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
    await db.execute(sql`delete from "user_saved_recipes"`)
    await db.execute(sql`delete from "recipes"`)
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

  describe('(a) RLS — cross-household access is blocked', () => {
    it('does not return another household\'s recipe even when queried directly', async () => {
      const recipe = await createRecipe(db, fakeAccessToken(userB), userB, householdBId, baseRecipe)

      const rows = await asUser(userA, (tx) =>
        tx.select().from(recipes).where(eq(recipes.id, recipe.id)),
      )

      expect(rows).toHaveLength(0)
    })

    it('refuses to insert a recipe for a household the user is not a member of', async () => {
      await expect(
        asUser(userA, (tx) =>
          tx.insert(recipes).values({
            householdId: householdBId,
            createdBy: userA,
            title: 'Sneaky recipe',
            description: '',
            servings: 2,
            ingredients: [],
            steps: [],
            tags: [],
            source: 'user_created',
            isPublic: false,
            isArchived: false,
          }),
        ),
      ).rejects.toThrow(/row-level security/i)
    })

    it('refuses to update a recipe belonging to another household', async () => {
      const recipe = await createRecipe(db, fakeAccessToken(userB), userB, householdBId, baseRecipe)

      const result = await asUser(userA, (tx) =>
        tx.update(recipes).set({ title: 'Hijacked' }).where(eq(recipes.id, recipe.id)).returning(),
      )

      expect(result).toEqual([])

      const [persisted] = await db.select({ title: recipes.title }).from(recipes).where(eq(recipes.id, recipe.id))
      expect(persisted?.title).toBe('Pasta Carbonara')
    })
  })

  describe('(b) Public recipe visibility', () => {
    it('lets any authenticated user see a public non-archived recipe from another household', async () => {
      const pub = await createRecipe(db, fakeAccessToken(userB), userB, householdBId, { ...baseRecipe, isPublic: true })

      const rows = await asUser(userA, (tx) =>
        tx.select({ id: recipes.id }).from(recipes).where(eq(recipes.id, pub.id)),
      )

      expect(rows).toHaveLength(1)
    })

    it('does not expose a public but archived recipe cross-household', async () => {
      const archivedPub = await createRecipe(db, fakeAccessToken(userB), userB, householdBId, { ...baseRecipe, isPublic: true })
      await updateRecipe(db, fakeAccessToken(userB), householdBId, archivedPub.id, { isArchived: true })

      const rows = await asUser(userA, (tx) =>
        tx.select({ id: recipes.id }).from(recipes).where(eq(recipes.id, archivedPub.id)),
      )

      expect(rows).toHaveLength(0)
    })

    it('searches public community recipes and excludes the caller household recipes', async () => {
      await createRecipe(db, fakeAccessToken(userA), userA, householdAId, { ...baseRecipe, title: 'Family Pasta', isPublic: true })
      const publicOther = await createRecipe(db, fakeAccessToken(userB), userB, householdBId, { ...baseRecipe, title: 'Community Pasta', isPublic: true })
      await createRecipe(db, fakeAccessToken(userB), userB, householdBId, { ...baseRecipe, title: 'Community Stew', isPublic: true })

      const results = await listPublicRecipes(db, fakeAccessToken(userA), userA, 'pasta')

      expect(results.map((recipe) => recipe.id)).toEqual([publicOther.id])
      expect(results[0]?.title).toBe('Community Pasta')
    })

    it('returns no public recipes for blank or too-long queries', async () => {
      await createRecipe(db, fakeAccessToken(userB), userB, householdBId, { ...baseRecipe, title: 'Community Pasta', isPublic: true })

      await expect(listPublicRecipes(db, fakeAccessToken(userA), userA, '')).resolves.toEqual([])
      await expect(listPublicRecipes(db, fakeAccessToken(userA), userA, 'x'.repeat(121))).resolves.toEqual([])
    })
  })

  describe('(c) CRUD happy paths', () => {
    it('creates a recipe with all fields, persists correctly', async () => {
      const recipe = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, baseRecipe)

      expect(recipe.title).toBe('Pasta Carbonara')
      expect(recipe.householdId).toBe(householdAId)
      expect(recipe.createdBy).toBe(userA)
      expect(recipe.ingredients).toHaveLength(2)
      expect(recipe.steps).toHaveLength(2)
      expect(recipe.tags).toEqual(['italian', 'pasta'])
      expect(recipe.source).toBe('user_created')
      expect(recipe.isArchived).toBe(false)
    })

    it('lists only non-archived recipes by default', async () => {
      await createRecipe(db, fakeAccessToken(userA), userA, householdAId, baseRecipe)
      const archived = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, { ...baseRecipe, title: 'Old recipe' })
      await updateRecipe(db, fakeAccessToken(userA), householdAId, archived.id, { isArchived: true })

      const list = await listRecipes(db, fakeAccessToken(userA), householdAId, false)

      expect(list).toHaveLength(1)
      expect(list[0]?.title).toBe('Pasta Carbonara')
    })

    it('includes archived recipes when includeArchived is true', async () => {
      await createRecipe(db, fakeAccessToken(userA), userA, householdAId, baseRecipe)
      const archived = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, { ...baseRecipe, title: 'Old recipe' })
      await updateRecipe(db, fakeAccessToken(userA), householdAId, archived.id, { isArchived: true })

      const list = await listRecipes(db, fakeAccessToken(userA), householdAId, true)

      expect(list).toHaveLength(2)
    })

    it('updates individual fields without touching others', async () => {
      const recipe = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, baseRecipe)

      const updated = await updateRecipe(db, fakeAccessToken(userA), householdAId, recipe.id, {
        title: 'Pasta Amatriciana',
        servings: 2,
      })

      expect(updated?.title).toBe('Pasta Amatriciana')
      expect(updated?.servings).toBe(2)
      expect(updated?.ingredients).toEqual(baseRecipe.ingredients)
      expect(updated?.cuisine).toBe('Italian')
    })

    it('returns null from getRecipe when recipe is not in the household', async () => {
      const recipe = await createRecipe(db, fakeAccessToken(userB), userB, householdBId, baseRecipe)

      const result = await getRecipe(db, fakeAccessToken(userA), householdAId, recipe.id)

      expect(result).toBeNull()
    })

    it('archives a recipe via updateRecipe, visible via includeArchived only', async () => {
      const recipe = await createRecipe(db, fakeAccessToken(userA), userA, householdAId, baseRecipe)

      await updateRecipe(db, fakeAccessToken(userA), householdAId, recipe.id, { isArchived: true })

      const withoutArchived = await listRecipes(db, fakeAccessToken(userA), householdAId, false)
      const withArchived = await listRecipes(db, fakeAccessToken(userA), householdAId, true)

      expect(withoutArchived).toHaveLength(0)
      expect(withArchived).toHaveLength(1)
      expect(withArchived[0]?.isArchived).toBe(true)
    })
  })

  describe('(d) saved recipes', () => {
    it('saves readable public recipes idempotently and lists them newest first', async () => {
      const first = await createRecipe(db, fakeAccessToken(userB), userB, householdBId, { ...baseRecipe, title: 'Community Pasta', isPublic: true })
      const second = await createRecipe(db, fakeAccessToken(userB), userB, householdBId, { ...baseRecipe, title: 'Community Tacos', isPublic: true })

      await expect(saveRecipe(db, fakeAccessToken(userA), userA, first.id)).resolves.toBe('saved')
      await expect(saveRecipe(db, fakeAccessToken(userA), userA, first.id)).resolves.toBe('saved')
      await expect(saveRecipe(db, fakeAccessToken(userA), userA, second.id)).resolves.toBe('saved')

      await db
        .update(userSavedRecipes)
        .set({ savedAt: new Date('2026-06-01T10:00:00.000Z') })
        .where(and(eq(userSavedRecipes.userId, userA), eq(userSavedRecipes.recipeId, first.id)))
      await db
        .update(userSavedRecipes)
        .set({ savedAt: new Date('2026-06-01T11:00:00.000Z') })
        .where(and(eq(userSavedRecipes.userId, userA), eq(userSavedRecipes.recipeId, second.id)))

      const rows = await db.select().from(userSavedRecipes).where(eq(userSavedRecipes.userId, userA))
      expect(rows).toHaveLength(2)

      const saved = await listSavedRecipes(db, fakeAccessToken(userA), userA)
      expect(saved.map((recipe) => recipe.id)).toEqual([second.id, first.id])
    })

    it('does not save a private cross-household recipe because it is not readable through RLS', async () => {
      const privateOther = await createRecipe(db, fakeAccessToken(userB), userB, householdBId, { ...baseRecipe, isPublic: false })

      await expect(saveRecipe(db, fakeAccessToken(userA), userA, privateOther.id)).resolves.toBe('not_found')

      const saved = await listSavedRecipes(db, fakeAccessToken(userA), userA)
      expect(saved).toEqual([])
    })

    it('can unsave a recipe and hides archived saved recipes', async () => {
      const publicOther = await createRecipe(db, fakeAccessToken(userB), userB, householdBId, { ...baseRecipe, isPublic: true })
      await saveRecipe(db, fakeAccessToken(userA), userA, publicOther.id)

      await unsaveRecipe(db, fakeAccessToken(userA), userA, publicOther.id)
      await expect(listSavedRecipes(db, fakeAccessToken(userA), userA)).resolves.toEqual([])

      await saveRecipe(db, fakeAccessToken(userA), userA, publicOther.id)
      await updateRecipe(db, fakeAccessToken(userB), householdBId, publicOther.id, { isArchived: true })

      await expect(listSavedRecipes(db, fakeAccessToken(userA), userA)).resolves.toEqual([])
    })
  })

  describe('(e) internal MealPlanner strangle routes', () => {
    it('creates, lists, reads, updates, and archives with MealPlanner envelopes', async () => {
      const previousInternalKey = process.env.VECKLY_INTERNAL_API_KEY
      process.env.VECKLY_INTERNAL_API_KEY = 'test-internal-key'
      try {
        const app = buildApp(db)
        const headers = {
          Authorization: `Bearer ${process.env.VECKLY_INTERNAL_API_KEY}`,
          'Content-Type': 'application/json',
          'X-User-Id': userA,
        }

        const createResponse = await app.request('/internal/custom-recipes', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            title: 'Family tacos',
            description: '',
            servings: 4,
            householdId: householdAId,
            ingredients: [{ item: 'tortillas', amount: '8' }],
            steps: [{ text: 'Warm tortillas.' }],
            tags: ['quick'],
            prepTimeMinutes: 10,
            cookTimeMinutes: 15,
            cuisine: 'mexican',
            proteinSource: 'beef',
            mealWeight: 'medium',
            isPublic: false,
          }),
        })
        expect(createResponse.status).toBe(201)
        const created = await createResponse.json() as { recipe: { id: string } }
        expect(created.recipe.id).toBeTruthy()

        const listResponse = await app.request('/internal/custom-recipes?search=taco', { headers })
        expect(listResponse.status).toBe(200)
        await expect(listResponse.json()).resolves.toMatchObject({
          recipes: [
            {
              id: created.recipe.id,
              title: 'Family tacos',
              householdId: householdAId,
              ingredients: [{ item: 'tortillas', amount: '8' }],
              tags: ['quick'],
              forkedFromId: null,
              rootRecipeId: null,
            },
          ],
        })

        const detailResponse = await app.request(`/internal/custom-recipes/${created.recipe.id}`, { headers })
        expect(detailResponse.status).toBe(200)
        await expect(detailResponse.json()).resolves.toMatchObject({
          recipe: {
            id: created.recipe.id,
            title: 'Family tacos',
            steps: [{ text: 'Warm tortillas.' }],
            cookTimeMinutes: 15,
            sourceUrl: null,
          },
        })

        const updateResponse = await app.request(`/internal/custom-recipes/${created.recipe.id}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ title: 'Friday tacos', servings: 5 }),
        })
        expect(updateResponse.status).toBe(200)
        await expect(updateResponse.json()).resolves.toEqual({ ok: true })

        const archiveResponse = await app.request(`/internal/custom-recipes/${created.recipe.id}/archive`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ isArchived: true }),
        })
        expect(archiveResponse.status).toBe(200)
        await expect(archiveResponse.json()).resolves.toEqual({ ok: true })

        const activeListResponse = await app.request('/internal/custom-recipes', { headers })
        expect(activeListResponse.status).toBe(200)
        await expect(activeListResponse.json()).resolves.toEqual({ recipes: [] })

        const archivedListResponse = await app.request('/internal/custom-recipes?includeArchived=true', { headers })
        expect(archivedListResponse.status).toBe(200)
        await expect(archivedListResponse.json()).resolves.toMatchObject({
          recipes: [{ id: created.recipe.id, title: 'Friday tacos', isArchived: true }],
        })
      } finally {
        if (previousInternalKey === undefined) {
          delete process.env.VECKLY_INTERNAL_API_KEY
        } else {
          process.env.VECKLY_INTERNAL_API_KEY = previousInternalKey
        }
      }
    })
  })
})
