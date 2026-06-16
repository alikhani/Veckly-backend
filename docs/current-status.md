# Current Status — Veckly-backend

## Roadmap snapshot

See `docs/plans/backend-move-ios-testflight-plan-2026-06.md` for the full phased plan.

| Phase | Status |
|---|---|
| Phase 0 — Migration inventory | Complete |
| Phase 1 — Backend parity foundation | Complete |
| Phase 2 — Backend product parity | Not started (remaining: billing/Stripe, recipe translation) |
| Phase 3 — Web strangler migration | Not started |
| Phase 4 — iOS foundation | In progress |
| Phase 5 — iOS product parity | Not started |
| Phase 6 — TestFlight readiness | Not started |

## What is working

- Hono + `@hono/zod-openapi` serving all core domain routes
- Supabase Auth (bearer token) + RLS-backed household isolation on every route
- OpenAPI spec generated and committed; iOS client auto-generated from spec
- Deployed to Vercel (`https://veckly-backend.vercel.app`)
- Postgres via Supabase (eu-north-1, project `ydzykuwqfslzewxisliv`)

### Routes in production

- Households: create, list, rename, delete
- Household profile/preferences
- Household members: list, role update, remove
- Household invites: create, list, revoke, accept
- Active week pointer
- Week plan events (assign, lock, skip, move, servings, clear, planning request)
- Week history: list, detail, finalize
- Shopping list state (checked items, pantry, clear, OCC)
- Recipes: list, create, edit, archive, fork, detail
- Public/community recipe search
- Saved/bookmarked recipes
- Recipe AI fill-in (Claude Haiku)
- Recipe URL import
- Recipe recommendations (Claude Haiku)
- Meal prep batches

## Recent changes

### 2026-06-16 — DB client fix (critical)

**Symptom:** iOS week view meal assignment failed with "We could not assign the meal" after a ~30 s delay. Vercel logs showed function timeout.

**Root cause:** `postgres-js` defaults to `prepare: true` (named prepared statements), which is incompatible with Supabase's transaction-mode PgBouncer pooler (port 6543). Every DB operation runs inside `withRls` → `db.transaction()`. The driver hung waiting for a response from the pooler that never came cleanly, until Vercel's 30 s `maxDuration` killed the request.

**Fix:** `src/db.ts` — `postgres(connectionString, { prepare: false, max: 1 })`.
- `prepare: false` makes the driver compatible with the transaction-mode pooler.
- `max: 1` is the standard single-connection-per-serverless-instance pattern for Supabase on Vercel (avoids pool thrashing on cold starts).

Deployed and verified in production.

## What is stable enough to build on

- Auth contract (Supabase bearer token → `auth.uid()` → RLS)
- Household isolation model
- Event-sourced week plan (events + projections)
- OpenAPI → Swift client generation pipeline
- Route-level and RLS test coverage for household isolation

## Next focus

Phase 4 — iOS foundation: auth on device, session persistence, environment switching, and fetching real household/week data from the backend.

See `docs/plans/backend-move-ios-testflight-plan-2026-06.md` for detail.
