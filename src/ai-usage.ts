import { and, eq } from 'drizzle-orm'
import type { Db } from './db.js'
import { householdAiWeeklyUsage } from './schema.js'

export function weeklyUsagePeriodStart(today: string) {
  const date = new Date(`${today}T00:00:00.000Z`)
  const mondayOffset = (date.getUTCDay() + 6) % 7
  date.setUTCDate(date.getUTCDate() - mondayOffset)
  return date.toISOString().slice(0, 10)
}

export async function reserveWeeklyGeneration(db: Db, householdId: string, periodStartDate: string, regenerate: boolean) {
  const usageKind = regenerate ? 'week_regeneration' : 'week_generation'
  const inserted = await db.insert(householdAiWeeklyUsage).values({ householdId, periodStartDate, usageKind })
    .onConflictDoNothing().returning()
  const rows = await db.select().from(householdAiWeeklyUsage).where(and(
    eq(householdAiWeeklyUsage.householdId, householdId),
    eq(householdAiWeeklyUsage.periodStartDate, periodStartDate),
  ))
  return { recorded: inserted.length === 1, current: rows.length, limit: 2 }
}

export async function releaseWeeklyGeneration(db: Db, householdId: string, periodStartDate: string, regenerate: boolean) {
  const usageKind = regenerate ? 'week_regeneration' : 'week_generation'
  await db.delete(householdAiWeeklyUsage).where(and(
    eq(householdAiWeeklyUsage.householdId, householdId),
    eq(householdAiWeeklyUsage.periodStartDate, periodStartDate),
    eq(householdAiWeeklyUsage.usageKind, usageKind),
  ))
}
