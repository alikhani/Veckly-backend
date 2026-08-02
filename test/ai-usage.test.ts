import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createDb } from '../src/db.js'
import { households } from '../src/schema.js'
import { releaseWeeklyGeneration, releaseWeeklyGenerationBestEffort, reserveWeeklyGeneration, serverWeeklyUsagePeriodStart, weeklyUsagePeriodStart } from '../src/ai-usage.js'

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
    await expect(reserveWeeklyGeneration(db, householdId, '2026-08-03', false)).resolves.toMatchObject({ recorded: true, current: 1, limit: 1 })
    await expect(reserveWeeklyGeneration(db, householdId, '2026-08-03', true)).resolves.toMatchObject({ recorded: true, current: 1, limit: 1 })
    await expect(reserveWeeklyGeneration(db, householdId, '2026-08-03', false)).resolves.toMatchObject({ recorded: false, current: 1, limit: 1 })
  })

  it('derives a Monday usage period from an ISO date', () => {
    expect(weeklyUsagePeriodStart('2026-08-09')).toBe('2026-08-03')
    expect(weeklyUsagePeriodStart('2026-08-10')).toBe('2026-08-10')
  })

  it('derives the enforced usage period from server time', () => {
    expect(serverWeeklyUsagePeriodStart(new Date('2026-08-09T23:59:59.000Z'))).toBe('2026-08-03')
    expect(serverWeeklyUsagePeriodStart(new Date('2026-08-10T00:00:00.000Z'))).toBe('2026-08-10')
  })

  it('releases a reservation when generation fails or does no work', async () => {
    await reserveWeeklyGeneration(db, householdId, '2026-08-03', false)
    await releaseWeeklyGeneration(db, householdId, '2026-08-03', false)
    await expect(reserveWeeklyGeneration(db, householdId, '2026-08-03', false)).resolves.toMatchObject({ recorded: true })
  })

  it('never throws when releasing a reservation fails', async () => {
    const failingDb = { delete: () => ({ where: async () => { throw new Error('database unavailable') } }) } as unknown as typeof db
    await expect(releaseWeeklyGenerationBestEffort(failingDb, householdId, '2026-08-03', false)).resolves.toBe(false)
  })
})
