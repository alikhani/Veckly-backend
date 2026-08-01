import { and, eq } from 'drizzle-orm'
import type { Db } from './db.js'
import { householdAiWeeklyUsage } from './schema.js'

export async function reserveWeeklyGeneration(db: Db, householdId: string, weekStartDate: string, regenerate: boolean) {
  const usageKind = regenerate ? 'week_regeneration' : 'week_generation'
  const inserted = await db.insert(householdAiWeeklyUsage).values({ householdId, weekStartDate, usageKind })
    .onConflictDoNothing().returning()
  const rows = await db.select().from(householdAiWeeklyUsage).where(and(
    eq(householdAiWeeklyUsage.householdId, householdId),
    eq(householdAiWeeklyUsage.weekStartDate, weekStartDate),
  ))
  return { recorded: inserted.length === 1, current: rows.length, limit: 2 }
}
