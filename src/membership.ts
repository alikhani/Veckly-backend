import { and, eq } from 'drizzle-orm'
import type { Db } from './db.js'
import { withRls } from './rls.js'
import { householdMemberships } from './schema.js'

export async function assertMembership(db: Db, accessToken: string, householdId: string, userId: string) {
  const [row] = await withRls(db, accessToken, (tx) =>
    tx.select({ id: householdMemberships.id }).from(householdMemberships)
      .where(and(
        eq(householdMemberships.householdId, householdId),
        eq(householdMemberships.userId, userId),
        eq(householdMemberships.status, 'active'),
      )).limit(1),
  )
  return row ?? null
}
