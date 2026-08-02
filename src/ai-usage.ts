import { and, eq } from 'drizzle-orm'
import type { Db } from './db.js'
import { householdAiWeeklyUsage } from './schema.js'

export function weeklyUsagePeriodStart(today: string) {
  const date = new Date(`${today}T00:00:00.000Z`)
  const mondayOffset = (date.getUTCDay() + 6) % 7
  date.setUTCDate(date.getUTCDate() - mondayOffset)
  return date.toISOString().slice(0, 10)
}

export function serverWeeklyUsagePeriodStart(now = new Date()) {
  return weeklyUsagePeriodStart(now.toISOString().slice(0, 10))
}

export async function reserveWeeklyGeneration(db: Db, householdId: string, periodStartDate: string, regenerate: boolean) {
  const usageKind = regenerate ? 'week_regeneration' : 'week_generation'
  const inserted = await db.insert(householdAiWeeklyUsage).values({ householdId, periodStartDate, usageKind })
    .onConflictDoNothing().returning()
  const rows = await db.select().from(householdAiWeeklyUsage).where(and(
    eq(householdAiWeeklyUsage.householdId, householdId),
    eq(householdAiWeeklyUsage.periodStartDate, periodStartDate),
    eq(householdAiWeeklyUsage.usageKind, usageKind),
  ))
  return { recorded: inserted.length === 1, current: rows.length, limit: 1 }
}

export async function releaseWeeklyGeneration(db: Db, householdId: string, periodStartDate: string, regenerate: boolean) {
  const usageKind = regenerate ? 'week_regeneration' : 'week_generation'
  await db.delete(householdAiWeeklyUsage).where(and(
    eq(householdAiWeeklyUsage.householdId, householdId),
    eq(householdAiWeeklyUsage.periodStartDate, periodStartDate),
    eq(householdAiWeeklyUsage.usageKind, usageKind),
  ))
}

export async function releaseWeeklyGenerationBestEffort(db: Db, householdId: string, periodStartDate: string, regenerate: boolean) {
  try {
    await releaseWeeklyGeneration(db, householdId, periodStartDate, regenerate)
    return true
  } catch (error) {
    console.error('[premium-gate] failed to release weekly AI usage reservation', error)
    return false
  }
}
