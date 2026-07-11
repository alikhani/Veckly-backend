import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { createDb } from '../src/db.js'
import { households, householdMemberships, householdSavedRecipes } from '../src/schema.js'
import { createRecipe } from '../src/recipes.js'
import {
  addHouseholdSavedRecipe,
  listHouseholdSavedRecipes,
  removeHouseholdSavedRecipe,
} from '../src/household-saved-recipes.js'
import { fakeAccessToken } from './fake-access-token.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const describeWithDb = testDatabaseUrl ? describe : describe.skip

describeWithDb('Household saved recipes', () => {
  const db = createDb(testDatabaseUrl!)

  const userA = '11111111-1111-1111-1111-111111111111'
  const userB = '22222222-2222-2222-2222-222222222222'
  let householdAId: string
  let householdBId: string

  const baseRecipe = {
    title: 'Community Tacos',
    description: '',
    servings: 4,
    ingredients: [{ item: 'tortillas', amount: '8' }],
    steps: [{ text: 'Assemble' }],
    tags: ['mexican'],
    source: 'user_created' as const,
    isPublic: true,
  }

  beforeEach(async () => {
    await db.execute(sql`delete from "household_saved_recipes"`)
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
    await db.execute(sql`delete from "household_saved_recipes"`)
    await db.execute(sql`delete from "recipes"`)
    await db.execute(sql`delete from "household_memberships"`)
    await db.execute(sql`delete from "households"`)
  })

  it('adds a community recipe to the household list, visible to every member', async () => {
    const community = await createRecipe(db, fakeAccessToken(userB), userB, householdBId, baseRecipe)

    await expect(addHouseholdSavedRecipe(db, fakeAccessToken(userA), userA, householdAId, community.id)).resolves.toBe('saved')

    const list = await listHouseholdSavedRecipes(db, fakeAccessToken(userA), householdAId)
    expect(list.map((r) => r.id)).toEqual([community.id])
  })

  it('is idempotent — adding the same recipe twice does not error or duplicate', async () => {
    const community = await createRecipe(db, fakeAccessToken(userB), userB, householdBId, baseRecipe)

    await addHouseholdSavedRecipe(db, fakeAccessToken(userA), userA, householdAId, community.id)
    await expect(addHouseholdSavedRecipe(db, fakeAccessToken(userA), userA, householdAId, community.id)).resolves.toBe('saved')

    const list = await listHouseholdSavedRecipes(db, fakeAccessToken(userA), householdAId)
    expect(list).toHaveLength(1)
  })

  it('refuses to save a recipe the caller cannot read through RLS', async () => {
    const privateOther = await createRecipe(db, fakeAccessToken(userB), userB, householdBId, { ...baseRecipe, isPublic: false })

    await expect(addHouseholdSavedRecipe(db, fakeAccessToken(userA), userA, householdAId, privateOther.id)).resolves.toBe('not_found')
    await expect(listHouseholdSavedRecipes(db, fakeAccessToken(userA), householdAId)).resolves.toEqual([])
  })

  it('lets any active member remove a bookmark added by someone else (veto), without touching the personal saved list', async () => {
    const userC = '33333333-3333-3333-3333-333333333333'
    await db.insert(householdMemberships).values({ householdId: householdAId, userId: userC, role: 'member', status: 'active' })
    const community = await createRecipe(db, fakeAccessToken(userB), userB, householdBId, baseRecipe)

    await addHouseholdSavedRecipe(db, fakeAccessToken(userA), userA, householdAId, community.id)
    await removeHouseholdSavedRecipe(db, fakeAccessToken(userC), householdAId, community.id)

    await expect(listHouseholdSavedRecipes(db, fakeAccessToken(userA), householdAId)).resolves.toEqual([])
  })

  it('keeps household bookmarks isolated per household', async () => {
    const community = await createRecipe(db, fakeAccessToken(userB), userB, householdBId, baseRecipe)
    await addHouseholdSavedRecipe(db, fakeAccessToken(userB), userB, householdBId, community.id)

    await expect(listHouseholdSavedRecipes(db, fakeAccessToken(userA), householdAId)).resolves.toEqual([])
  })

  it('records who added a bookmark for attribution, without gating removal on it', async () => {
    const community = await createRecipe(db, fakeAccessToken(userB), userB, householdBId, baseRecipe)
    await addHouseholdSavedRecipe(db, fakeAccessToken(userA), userA, householdAId, community.id)

    const [row] = await db.select({ addedBy: householdSavedRecipes.addedBy })
      .from(householdSavedRecipes)
      .where(and(eq(householdSavedRecipes.householdId, householdAId), eq(householdSavedRecipes.recipeId, community.id)))
    expect(row?.addedBy).toBe(userA)
  })
})
