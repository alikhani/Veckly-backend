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

// Sibling to `withRls`, for the one shape that needs a SECOND per-transaction
// config value: token-gated invite operations (preview-by-token, accept-via-
// token — see migrations/0006_household_invites_rls.sql). `auth.uid()` answers
// "who are you"; `current_setting('request.invite_token', ...)` answers "what
// secret do you hold" — a structurally different visibility primitive an
// invite's accepting user needs *before* they have a membership to be "who"
// about. Kept as a separate function rather than an optional third argument to
// `withRls` so the much more common single-config call sites stay exactly as
// simple as they already are — most policies never need to reason about a token.
export async function withRlsAndToken<T>(db: Db, accessToken: string, token: string, run: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: decodeUserId(accessToken) })}, true)`)
    await tx.execute(sql`select set_config('request.invite_token', ${token}, true)`)
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
