import { sql } from 'drizzle-orm'
import type { Db } from './db.js'

// Single atomic statement replaces the old check-then-set in-memory Map — safe
// across concurrent serverless instances because Postgres serializes concurrent
// ON CONFLICT upserts against the same (user_id, scope) row. A row comes back
// only on a fresh insert or when the previous hit has aged past the window;
// the WHERE clause makes the conflict branch a no-op (0 rows) otherwise.
export async function isRateLimited(db: Db, userId: string, scope: string, windowSeconds: number): Promise<boolean> {
  const rows = await db.execute(sql`
    insert into rate_limit_hits (user_id, scope, hit_at)
    values (${userId}, ${scope}, now())
    on conflict (user_id, scope) do update
      set hit_at = excluded.hit_at
      where rate_limit_hits.hit_at <= now() - make_interval(secs => ${windowSeconds})
    returning 1
  `)
  return rows.length === 0
}
