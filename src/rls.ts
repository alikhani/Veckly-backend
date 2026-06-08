import { sql } from 'drizzle-orm'
import type { Db } from './db.js'

// auth.uid() (the primitive our RLS policies key on) reads the JWT claims that
// Supabase's auth schema exposes via `request.jwt.claims` / `request.jwt.claim.sub`.
// Setting them per-transaction — rather than opening one connection per user —
// is what lets a serverless backend enforce RLS without becoming the boundary
// itself: the database checks `auth.uid()`, we just have to tell it who's asking.
export async function withRls<T>(db: Db, accessToken: string, run: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: decodeUserId(accessToken) })}, true)`)
    await tx.execute(sql`set local role authenticated`)
    return run(tx as unknown as Db)
  })
}

function decodeUserId(accessToken: string): string {
  const payload = accessToken.split('.')[1]
  if (!payload) throw new Error('Malformed access token')
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: string }
  if (!decoded.sub) throw new Error('Access token has no subject claim')
  return decoded.sub
}
