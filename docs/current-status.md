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

### 2026-06-17 — POST body hang fix (critical)

**Symptom:** All POST routes with a JSON body returned 504 after exactly 30 s (Vercel `maxDuration`). POST routes without a declared body schema (e.g. `POST /households/me/bootstrap`) returned 200 normally. GET routes were unaffected.

**Root cause:** `@hono/node-server/vercel`'s `handle()` reads the request body *lazily* — only when a route handler accesses `c.req.json()` / `c.req.valid('json')`. In Vercel's serverless Node.js runtime, the `IncomingMessage` stream emits `data` events before the lazy reader sets up its listeners. The events are lost; the subsequent body read blocks indefinitely until Vercel kills the function.

**Fix:** `api/index.ts` — replaced `handle(app)` with a custom bridge function that eagerly buffers the body from the raw Node.js stream (`readBody(req)`) *before* constructing a Web Fetch `Request` and calling `app.fetch()`. This bypasses the adapter's lazy-read entirely.

Key invariant: `bodyParser: false` stays in the Vercel config export — Vercel must not consume the stream itself. The custom handler owns the read.

Deployed and verified 2026-06-17.

### 2026-06-16 — Missing Supabase migrations (critical)

**Symptom:** Backend DB operations returned errors on tables that should exist (`household_profiles`, `household_active_weeks`, `user_saved_recipes`, `household_week_plans`). Supabase logs showed "relation does not exist".

**Root cause:** Six migrations (0014–0019) had not been applied to the Veckly Supabase project. Only 12 of the expected 16 tables existed.

**Fix:** Applied migrations 0014–0019 in order via `mcp__supabase__apply_migration`. Verified all 16 tables present with correct RLS policy counts.

### 2026-06-16 — Vercel function timeout on AI routes (MealPlanner)

**Symptom:** `POST /api/recipes/fill-in` and `POST /api/recipes/import-from-url` returned 504.

**Root cause:** Vercel's default Next.js function timeout is 10 s. Anthropic AI calls (Haiku) take 15–25 s under load.

**Fix:** Added `export const maxDuration = 60` to `fill-in/route.ts`, `custom-recipes/route.ts`, `custom-recipes/[id]/route.ts`, and `import-from-url/route.ts` in MealPlanner.

### 2026-06-16 — iOS week summary lock state

`GET /households/{householdId}/week-plans/{weekStartDate}/summary` now returns
`isLocked` on every `WeekPlanSummaryDay`. iOS uses this per-day read model as the
source of truth for locked-day UI state, avoiding a second client-side `lockedDays`
collection that can drift from the summary rows.

The OpenAPI specs in `Veckly-backend/openapi.json` and
`Veckly-ios/OpenAPI/veckly-openapi.json` include the new field.

Deployed 2026-06-16:
- Staging/preview: `https://veckly-backend-mrmllqbe3-nimaalikhani5s-projects.vercel.app`
- Production: `https://veckly-backend.vercel.app`

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
