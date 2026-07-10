# Current Status — Veckly-backend

## Roadmap snapshot

See `docs/plans/backend-move-ios-testflight-plan-2026-06.md` for the full phased plan.

| Phase | Status |
|---|---|
| Phase 0 — Migration inventory | Complete |
| Phase 1 — Backend parity foundation | Complete |
| Phase 2 — Backend product parity | In progress (remaining: billing/Stripe, recipe translation unless parity matrix says otherwise) |
| Phase 3 — Web strangler migration | Not started |
| Phase 4 — iOS foundation | In progress |
| Phase 5 — iOS product parity | In progress |
| Phase 6 — TestFlight readiness | In progress — internal TestFlight live; security headers + migration runbook added 2026-06-21; remaining: rate limiting, staging DB, observability, QA pass, external submission |

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

### 2026-07-10 — Week generation: fail-closed allergy filter, respect skipped days

Part of a broader Sunday-ritual/family-memory initiative — see `PLAN-veckoritual-familjeminne-2026-07.md` in the workspace root for the full plan and priority order (this is Plan 0, the bug-fix slice; Plan A is the next step: porting `MealPlanner`'s feedback/recency/variety scoring into `doGenerateWeekPlan`, which today is still a random shuffle).

Fixed in `POST /households/{id}/week-plans/{weekStartDate}/generate`:
- **Allergy filter now fails closed.** If every candidate recipe is excluded by the household's `avoidIngredients`, the route now returns `422 { error: 'ALL_RECIPES_EXCLUDED' }` instead of silently falling back to the unfiltered pool — the old behavior could serve a recipe containing an ingredient the household explicitly flagged (e.g. an allergen). `GenerateWeekPlanErrorSchema` gained this new enum value alongside the existing `NO_RECIPES` (no recipes in the household at all).
- **Generate/regenerate now respects skipped days.** `daysToFill` previously filtered out locked days but not `skippedDays`, and the `meal_assigned` fold un-skips a day — so Generate could silently re-fill a day the household explicitly skipped (e.g. "eating out Wednesday"). `skippedDays` is now excluded from `daysToFill` in both the fill-empty-days and full-regenerate paths.

No iOS client changes required — `generateWeekPlan` in `VecklyAPIClient.swift` already maps any `422` to `APIError.noRecipesForGeneration` by status code, not by inspecting the error body. OpenAPI spec regenerated and committed in both repos (`Veckly-backend/openapi.json`, `Veckly-ios/OpenAPI/veckly-openapi.json`); the iOS Swift client was regenerated via `Veckly-ios/scripts/generate-openapi-client.sh`.

**Unrelated drift caught by the same regen:** `UpsertSavedPlan`'s generated Swift shape had drifted significantly from the current backend schema (an `allOf`/intersection type, not the old flat `{id, createdAt, label, state}` shape) — the committed generated client predated a schema change that was never followed by a regen. Verified zero blast radius: no non-generated iOS code references `UpsertSavedPlan`. Fixed as a side effect of this regen; worth a periodic `openapi:write` + client-regen pass independent of route changes to catch this class of drift earlier.

6 new backend tests added to `test/week-plan.test.ts` (`doGenerateWeekPlan` exported for direct testing, matching the file's existing pattern). 2 companion iOS fixes landed in the same session (swipe-to-skip removal, skip-then-undo meal preservation) — see the plan doc for detail.

### 2026-06-21 — Phase 6 production-readiness audit

Audited backend against the Phase 6 TestFlight-readiness checklist (the iOS app already has an internal TestFlight build live, ahead of what this doc previously reflected).

Fixed:
- Security headers were entirely missing — added `hono/secure-headers` middleware in `src/app.ts` (default config: HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, removes `X-Powered-By`).
- No migration/rollback process was documented — written up in `docs/runbooks/migration-and-rollback-runbook.md`, motivated directly by the 2026-06-16 missing-migrations incident below.

Still open, by design decision rather than oversight at this point:
- Rate limiting on AI routes is in-memory (per serverless instance, resets on cold start) — fine for internal testing, needs Redis/Upstash before a larger external beta.
- One Supabase project total — no separate staging database to test migrations against before production.
- No structured observability (Sentry or a Vercel log drain) — only `console.error`.
- No systematic QA pass yet (device matrix, dark mode, locale, offline, fresh/upgrade install).

### 2026-06-18 — iOS language signal

`Veckly-ios` now sends `Accept-Language` on generated OpenAPI requests and
manual URLSession requests, based on iOS `Locale.preferredLanguages`.

Backend behavior is unchanged in this step. The header is now available for
future AI responses, recipe/content translation, and language-aware copy where
backend-owned text is appropriate. Client-side iOS localization is handled in
`Veckly-ios/Veckly/Localizable.xcstrings` with English fallback and Swedish
system-language UI.

### 2026-06-17 — Recipe URL import error contract

`POST /recipes/import-from-url` now exposes stable `RecipeImportError` response
bodies in OpenAPI for 400, 422, 429, and 500 responses. iOS maps those error
codes to user-facing import messages instead of treating every URL import
failure as a generic backend error.

The OpenAPI specs in `Veckly-backend/openapi.json` and
`Veckly-ios/OpenAPI/veckly-openapi.json` have been regenerated.

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

iOS-first TestFlight path:

1. Finish Phase 4 foundation: auth on device, session persistence, environment switching, generated client compile health.
2. Close backend parity gaps only where they block the first iOS beta scope.
3. Keep OpenAPI committed and deterministic after every route contract change.
4. Support Phase 5 iOS product parity for the weekly planning and shopping loop.

See `docs/plans/backend-move-ios-testflight-plan-2026-06.md` for detail.
