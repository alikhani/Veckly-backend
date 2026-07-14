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
- Product events: beta funnel event writes

## Recent changes

### 2026-07-14 — Supabase-backed beta product events

Phase 7 beta measurement now has a backend-owned event log instead of relying on a third-party analytics SDK. Added migration `0031_product_events.sql`, Drizzle schema, active-member RLS, and public `POST /households/{householdId}/product-events`.

The v1 event vocabulary is intentionally small: onboarding completed, first week generated, week completed, shopping opened after completion, shopping shared, partner invite clicked, shopping main list completed, and retro completed. Results are read from Supabase SQL/dashboard; the public client API only writes events. See `docs/plans/beta-product-events-plan-2026-07.md`.

The first 2-week family beta script is ready in `docs/plans/beta-research-script-2026-07.md`. It maps onboarding, first planning, shopping handoff, household sharing, week-2 return, and retro prompts to the v1 event funnel so qualitative notes and Supabase data can be reviewed together after the first 5 households. The first-five synthesis template is in `docs/plans/beta-first-five-review-template-2026-07.md`.

Production note: `0031_product_events.sql` was applied directly against the Veckly Supabase project on 2026-07-14 after Vercel runtime logs exposed the adjacent missing `0030` table. Verified with `to_regclass('public.product_events')` and RLS policy inspection.

### 2026-07-14 — Household meal signals complete for v1 (Phase 5)

Phase 5 of the iOS family-experience work needs a real household-level signal for "this works for us" without exposing partner-private feedback. Decision preserved: keep `meal_feedback` private and per-user exactly as-is, and add a separate shared household model: `household_meal_signals` with `works_for_family` / `not_for_us`, active-member RLS, and no partner vote exposure.

Implemented for v1: migration `0030_household_meal_signals.sql`, Drizzle schema, public `GET/PUT /households/{householdId}/meal-signals`, OpenAPI regeneration, Swift client regeneration, RLS tests, generation scoring support, and a first iOS DayDetail surface. `works_for_family` now gives a shared household boost; `not_for_us` strongly penalizes but does not absolutely exclude a meal. The backend plan is captured in `docs/plans/household-meal-signals-plan-2026-07.md`.

Production note: `0030_household_meal_signals.sql` was applied directly against the Veckly Supabase project on 2026-07-14 after iOS week generation returned `HTTP 500`. Vercel runtime logs showed `PostgresError: relation "household_meal_signals" does not exist` on `POST /households/{id}/week-plans/{weekStartDate}/generate` and `GET /households/{id}/meal-signals`. Verified after applying: `to_regclass('public.household_meal_signals')` returns the table and all four active-member RLS policies are present.

Follow-up note: after `0030` fixed the 500, production generation returned `200` and wrote five `meal_assigned` events, but iOS still showed an empty week. Root cause was the existing builtin recipe seed: all 150 builtin recipes had `tags`, `ingredients`, and `steps` stored as JSONB strings rather than JSONB arrays, which made summary decoding brittle. Production data was normalized in place on 2026-07-14, the seed script now writes JSON values via `sql.json(...)`, and `getWeekPlanSummary`/generation now tolerate legacy stringified JSONB arrays defensively.

Shopping list summary now normalizes singular/plural ingredient variants only when both variants appear in the same category/unit bucket. This keeps standalone labels like `tomatoes` intact, but merges duplicate rows like `carrot` + `carrots`, sums amounts, and preserves checked state from either the canonical or legacy item key.

For Swedish iOS clients, shopping list summary applies a small response-level localization dictionary for common builtin ingredient labels and units, driven by `Accept-Language`. This is deliberately not a recipe data migration: item keys remain stable for shared checklist state, user-owned recipe text is not rewritten, and unknown labels pass through unchanged.

Production deploy note: the backend was manually deployed to Vercel on 2026-07-14 (`dpl_A9zjwkpL3RugZFW2UzhB2UEHZVqA`) so production now includes the builtin JSON hardening, shopping singular/plural normalization, and Swedish shopping-summary localization changes that were ahead of the previous GitHub-triggered production deployment (`00bb6b6`).

Shopping list summary now excludes meals whose dinner date is before today. This keeps week history intact in the plan while preventing yesterday's ingredients from staying in the active shopping basket. Tests pin the behavior with `today` injected so date-sensitive cases remain deterministic. Deployed to production on 2026-07-14 as `dpl_HCR2vMwAeaDse41Qz2nXN32gXkJv` (`https://veckly-backend.vercel.app`).

Follow-up fix: iOS now sends `X-Veckly-Today: YYYY-MM-DD` from the device's local day, and shopping summary uses that value when present. This avoids server-clock drift in simulator/TestFlight: yesterday's meals can be excluded while a newly added future meal, such as Wednesday carbonara, still contributes ingredients immediately. Deployed to production on 2026-07-14 as `dpl_GHcWbP68amBmfMx1Hmso3n6yZL9m` (`https://veckly-backend.vercel.app`).

Follow-up fix: shopping summary responses now use `Cache-Control: no-store`. The previous `private, max-age=300` allowed URLSession to reuse a stale grouped summary for up to five minutes, so pull-to-refresh could still show removed Carbonara ingredients or miss a newly added Thursday dinner even after the app-level cache had been invalidated.

### 2026-07-12 — Household-shared recipe bookmarks (Plan A3), migration applied to production

`migrations/0029_household_saved_recipes.sql` had been committed (2026-07-11, Plan A3) but not yet applied to the Veckly Supabase project — same category of gap as the 2026-06-16 incident below. Verified via `to_regclass('public.household_saved_recipes')` before touching anything, then applied the migration statement-by-statement directly against production `DATABASE_URL` (no Supabase MCP session available in this session; same net effect as `mcp__supabase__apply_migration`). Confirmed after: table exists, RLS enabled, all 3 policies present, and the `authenticated` role already has full grants on the new table via Supabase's project-level default privileges (consistent with every other RLS table in this project — none of the migration files contain explicit `GRANT` statements, confirming grants are handled automatically at the project level here, not per-migration).

### 2026-07-10 — Fix: skipping a day deleted its assigned recipe instead of preserving it

Found while building Plan D1/D2 (surfacing `reason`/`confidence` in the week view) — see `PLAN-veckoritual-familjeminne-2026-07.md`. The `day_skipped` fold case in `foldEventIntoProjection` (`src/week-plan.ts`) deleted `state.meals[dayOfWeek]` entirely, contradicting the "skip is a state layered on top of the assignment" model the iOS client already assumed (`WeekDayRowViewModel.withSkipped` — added 2026-07-10 as Plan 0.4 — keeps `recipe`/`mealTitle` locally when skipping, expecting the server to do the same). In practice: skip a planned day, then reload from the server (e.g. `scenePhase == .active`) — the day would come back as `state: 'empty'`, silently losing the recipe, reason, and confidence instead of showing them dimmed alongside a "Skipped" badge.

Fixed: `day_skipped` now only moves the day into `skippedDays` and clears any lock — it no longer touches `meals`. `getWeekPlanSummary` already read `recipeIds`/`recipe` from every day's `meals` entry regardless of skip status, so once the entry survives, a skipped day's response now correctly includes its recipe (and `reason`/`confidence`) alongside `state: 'skipped'`. Un-skipping (`day_unskipped`) needed no change — it never touched `meals` in the first place, so it now correctly "restores" a recipe that was never actually gone.

One existing unit test hard-coded the old (buggy) deletion behavior and was updated; one new integration test added confirming a skipped day's recipe survives in the summary response.

### 2026-07-10 — Reason and confidence per meal assignment (Plan A2)

Part of the same initiative — see `PLAN-veckoritual-familjeminne-2026-07.md` (Plan A2). This is what makes Plan D's "why this meal" UI possible: `doGenerateWeekPlan` now attaches a `reason` and `confidence` to every algorithmically-assigned meal, surfaced per day in `GET /households/{id}/week-plans/{weekStartDate}/summary`.

- Two new pure functions in `src/week-scoring.ts`: `deriveAssignmentReason` (one of `liked-before`, `family-recipe`, `back-after-break`, `based-on-feedback`, `new-for-variety`, or `undefined` — checked in order of how specific/informative the signal is to the user, not how strongly it scored; an explicit vote outranks mere household-recipe ownership when both are true) and `evaluateAssignmentConfidence` (`'ok' | 'low'`, ported from the web engine's `evaluateConfidence` minus the day-selection-dependent `hearty-on-busy-day` branch — no day-level signals exist in the backend yet, see A4). Both are evaluated against the running `TWeekContext`/candidate pool *before* the pick updates that context, matching the web engine's call order.
- Reduced from the web engine's `deriveReasonTags`/`evaluateConfidence` on purpose: the web versions depend on per-day planning selections (`occasion`, `effortLevel`, `lateEvening`, `cookingTolerance`) that this backend has no UI or data model for yet. `quick-weekday` from the plan doc's original reason enum is therefore never emitted in this pass — deferred alongside A4.
- `meal_assigned` event payload gained optional `reason`/`confidence`; the projection fold now sets both unconditionally from the event (not merged with the prior assignment) so a manual re-pick correctly clears a stale reason left over from an earlier generated pick. `GET .../summary` exposes them as nullable fields per day (`null` for empty/skipped days and manual assignments).
- OpenAPI regenerated and committed in both repos; iOS Swift client regenerated (`Components.Schemas.WeekPlanSummaryDay.reason`/`.confidence`, both optional enums) — additive only, no other contract drift. No consuming iOS UI code yet; that's Plan D1/D2.
- 9 new unit tests in `test/week-scoring.test.ts`, 2 new integration assertions + 1 new test in `test/week-plan.test.ts` (manual assignment leaves both fields `null`).

### 2026-07-10 — Week generation scoring engine v2.0 (feedback, recency, fatigue, variety)

Part of the same initiative as the fixes below — see `PLAN-veckoritual-familjeminne-2026-07.md` (Plan A). `doGenerateWeekPlan` previously picked meals via `sort(() => Math.random() - 0.5)` — pure chance, so a user's thumbs up/down had zero effect on what got generated. Replaced with a scoring engine ported from `MealPlanner`'s proven web planner (`src/lib/planner/meal-scoring.ts`, `week-constraint-scoring.ts`, `week-history-analysis.ts`), same formulas, adapted to this backend's recipe-row/feedback-row shapes:

- New pure module `src/week-scoring.ts` (zero DB dependency, fully unit-tested in isolation — `test/week-scoring.test.ts`, 25 tests): explicit feedback (+8 liked / −12 disliked, plus signal and tag-spillover scoring), recency penalty (−8 last week / −4 two weeks ago), fatigue detection (−10 for 2 weeks after a ≥3-week streak breaks), week-level variety (cuisine/protein 3rd+ repeat penalty, hearty-meal-adjacency penalty), and a +12 boost for the household's own recipes over the shared/public pool.
- `doGenerateWeekPlan` now fetches the triggering user's feedback (`meal_feedback`, scoped by `(householdId, userId)` — see the per-user note below) and up to 6 prior weeks of `week_plan_projections` in the same parallel query batch as before, builds a running `TWeekContext` (seeded from this week's already-locked/placed meals so variety scoring sees the whole week, not just the days being filled), and picks the highest-scoring unused candidate per day — ties break deterministically on recipe id (matches the web engine exactly; there is no randomness in the ranking itself, unlike the old v1.0 shuffle). `algorithmVersion` bumped `'1.0'` → `'2.0'`.
- **Feedback is per-user, not household-shared** — confirmed from both this backend's RLS policy (`meal_feedback_select_own_via_active_membership` requires `user_id = auth.uid()` even for SELECT) and `MealPlanner`'s own schema (`meal_feedback` primary key is `(user_id, meal_id)`, no `household_id` at all). So generation scores using only the feedback of whoever clicked Generate — this matches the reference implementation's actual behavior, not a regression.
- 4 new integration tests in `test/week-plan.test.ts`: algorithmVersion stamping, feedback preference, recency avoidance, family-recipe boost over an equivalent public recipe.
- OpenAPI unchanged (no route contract change) — regenerated and diffed clean.

Not done in this pass (tracked as Plan A2/A3/A4 in the plan doc): exposing `reason`/`confidence` per assignment in the API response (needed before the family-memory UI work can show "why" a meal was picked), and a decision on whether generation should draw from the full public-recipe pool or a narrower curated+bookmarked set.

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
