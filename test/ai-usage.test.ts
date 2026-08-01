import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createDb } from '../src/db.js'
import { households } from '../src/schema.js'
import { reserveWeeklyGeneration } from '../src/ai-usage.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const describeWithDb = testDatabaseUrl ? describe : describe.skip

describeWithDb('weekly AI generation usage', () => {
  const db = createDb(testDatabaseUrl!)
  let householdId: string

  beforeEach(async () => {
    await db.execute(sql`delete from "household_ai_weekly_usage"`)
    await db.execute(sql`delete from "households"`)
    const [household] = await db.insert(households).values({ name: 'Usage household' }).returning()
    householdId = household!.id
  })

  afterAll(async () => {
    await db.execute(sql`delete from "household_ai_weekly_usage"`)
    await db.execute(sql`delete from "households"`)
  })

  it('records exactly one generation and one regeneration per household week', async () => {
    await expect(reserveWeeklyGeneration(db, householdId, '2026-08-03', false)).resolves.toMatchObject({ recorded: true, current: 1, limit: 2 })
    await expect(reserveWeeklyGeneration(db, householdId, '2026-08-03', true)).resolves.toMatchObject({ recorded: true, current: 2, limit: 2 })
    await expect(reserveWeeklyGeneration(db, householdId, '2026-08-03', false)).resolves.toMatchObject({ recorded: false, current: 2, limit: 2 })
  })
})
