import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { createDb } from '../src/db.js'
import { getShoppingPreferences, putShoppingPreferences } from '../src/shopping-preferences.js'
import { householdMemberships, householdShoppingPreferences, households } from '../src/schema.js'
import { fakeAccessToken } from './fake-access-token.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const describeWithDb = testDatabaseUrl ? describe : describe.skip

describeWithDb('Household shopping preferences + RLS', () => {
  const db = createDb(testDatabaseUrl!)
  const userA = '11111111-1111-1111-1111-111111111111'
  const userB = '22222222-2222-2222-2222-222222222222'
  const userC = '33333333-3333-3333-3333-333333333333'
  let householdAId: string
  let householdBId: string

  beforeEach(async () => {
    await db.execute(sql`delete from "household_shopping_preferences"`)
    await db.execute(sql`delete from "household_memberships"`)
    await db.execute(sql`delete from "households"`)

    const [householdA] = await db.insert(households).values({ name: 'Household A' }).returning({ id: households.id })
    const [householdB] = await db.insert(households).values({ name: 'Household B' }).returning({ id: households.id })
    householdAId = householdA!.id
    householdBId = householdB!.id
    await db.insert(householdMemberships).values([
      { householdId: householdAId, userId: userA, role: 'owner', status: 'active' },
      { householdId: householdAId, userId: userB, role: 'member', status: 'active' },
      { householdId: householdBId, userId: userC, role: 'owner', status: 'active' },
    ])
  })

  afterAll(async () => {
    await db.execute(sql`delete from "household_shopping_preferences"`)
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

  it('returns the canonical order before the household customizes it', async () => {
    await expect(getShoppingPreferences(db, fakeAccessToken(userA), householdAId)).resolves.toEqual({
      categoryOrder: ['produce', 'protein', 'dairy', 'pantry', 'frozen', 'bakery', 'other'],
      updatedAt: null,
    })
  })

  it('shares a saved order with every active household member', async () => {
    const categoryOrder = ['pantry', 'produce', 'protein', 'dairy', 'frozen', 'bakery', 'other']
    await putShoppingPreferences(db, fakeAccessToken(userA), userA, householdAId, categoryOrder)

    await expect(getShoppingPreferences(db, fakeAccessToken(userB), householdAId)).resolves.toMatchObject({ categoryOrder })
  })

  it('blocks direct reads of another household through RLS', async () => {
    await putShoppingPreferences(
      db,
      fakeAccessToken(userC),
      userC,
      householdBId,
      ['other', 'bakery', 'frozen', 'pantry', 'dairy', 'protein', 'produce'],
    )

    const rows = await asUser(userA, (tx) => tx
      .select()
      .from(householdShoppingPreferences)
      .where(eq(householdShoppingPreferences.householdId, householdBId)))

    expect(rows).toEqual([])
  })

  it('blocks a removed member through RLS', async () => {
    await putShoppingPreferences(
      db,
      fakeAccessToken(userA),
      userA,
      householdAId,
      ['pantry', 'produce', 'protein', 'dairy', 'frozen', 'bakery', 'other'],
    )
    await db.update(householdMemberships)
      .set({ status: 'removed' })
      .where(eq(householdMemberships.userId, userB))

    const rows = await asUser(userB, (tx) => tx
      .select()
      .from(householdShoppingPreferences)
      .where(eq(householdShoppingPreferences.householdId, householdAId)))

    expect(rows).toEqual([])
  })

  it('returns 401 from the public route without a bearer token', async () => {
    const response = await buildApp(db).request(`/households/${householdAId}/shopping-preferences`)
    expect(response.status).toBe(401)
  })
})
