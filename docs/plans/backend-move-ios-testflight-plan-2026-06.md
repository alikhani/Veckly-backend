# Backend Move and iOS TestFlight Plan

Status: active plan
Created: 2026-06-10
Owner: Veckly workspace

## Goal

Move all backend functionality out of `MealPlanner` and into `Veckly-backend`, then build
`Veckly-ios` against that backend until the native app is ready for TestFlight.

The order is deliberate:

1. `MealPlanner` remains the reference implementation for behavior, domain decisions, and edge cases.
2. `Veckly-backend` becomes the canonical API and data boundary.
3. `Veckly-ios` builds only against the generated OpenAPI client from `Veckly-backend`.

## Current Status

| Phase | Status | Notes |
|---|---|---|
| Phase 0 — Migration inventory | Complete | API parity matrix exists in `docs/migration/api-parity.md`; first implementation slice selected. |
| Phase 1 — Backend parity foundation | In progress | `Veckly-backend` already has Hono, Drizzle, Supabase Auth/RLS direction, OpenAPI, households, invites, week summary, shopping list, and recipes foundations. Needs parity audit before extending. |
| Phase 2 — Backend product parity | Not started | Move remaining MealPlanner API behavior route by route. |
| Phase 3 — Web strangler migration | Not started | Existing web app starts calling/proxying to `Veckly-backend`. |
| Phase 4 — iOS foundation | In progress | `Veckly-ios` exists with generated OpenAPI client, tabs, week/shopping/settings foundations. Needs auth and full environment setup. |
| Phase 5 — iOS product parity | Not started | Build native planning workflows. |
| Phase 6 — TestFlight readiness | Not started | App Store Connect, signing, QA, telemetry, beta checklist. |

## Working Rules

- Do backend parity before iOS feature parity.
- Do not hand-write iOS networking for API routes that belong in OpenAPI.
- Every backend route that touches household data must be protected by Supabase Auth and RLS-backed authorization.
- Preserve observable product behavior from `MealPlanner` unless this plan explicitly marks a behavior as deprecated.
- Move route by route. Avoid a big-bang cutover.
- Keep the OpenAPI spec generated and committed when route contracts change.
- Treat `MealPlanner/docs/` as the product and behavior source of truth during migration.

## Phase 0 — Migration Inventory

Status: complete

Purpose: define exactly what "all backend functionality is moved" means.

Work order:

1. Inventory every active route under `MealPlanner/src/app/api/**`.
2. Inventory existing routes in `Veckly-backend/src/**`.
3. Create an API parity matrix with these columns:
   - MealPlanner route
   - current product behavior
   - target backend route
   - OpenAPI operation id
   - auth requirement
   - household/RLS requirement
   - status: `missing`, `partial`, `migrated`, `deprecated`
   - test coverage
4. Identify deprecated routes that should not move.
5. Identify route groups that must move together because they share state.

Exit criteria:

- API parity matrix exists and is committed.
- Every MealPlanner API route has a target status.
- First backend implementation slice is selected.

Recommended first slice:

1. Auth/session assumptions
2. Households and memberships
3. Household profile/preferences
4. Week summary read path
5. Shopping list read/write path

## Phase 1 — Backend Parity Foundation

Status: in progress

Purpose: make the backend foundation production-shaped before moving the long tail of features.

Work order:

1. Confirm Supabase Auth integration contract:
   - bearer access token accepted by every protected route
   - `auth.uid()` available to RLS policies
   - local/staging/prod env vars documented
2. Confirm RLS coverage:
   - households
   - memberships
   - invites
   - week plan events/projections
   - shopping list events/projections
   - recipes
3. Harden core route tests:
   - unauthenticated request returns 401
   - non-member cannot read/write household data
   - removed member cannot read/write household data
   - owner/member role differences are enforced where needed
4. Stabilize OpenAPI generation:
   - generated spec is deterministic
   - `npm run openapi:write` updates `Veckly-ios/OpenAPI/veckly-openapi.json`
   - iOS generated client compiles after regeneration
5. Document backend local setup and test commands.

Exit criteria:

- `npm test` passes in `Veckly-backend`.
- `npm run build` passes in `Veckly-backend`.
- OpenAPI regeneration works.
- iOS generated client compiles after spec update.

## Phase 2 — Backend Product Parity

Status: not started

Purpose: move all active backend behavior from MealPlanner into `Veckly-backend`.

Work order:

1. Households: create/read/rename, member roles, member removal, household deletion.
2. Household profile/preferences: adults, children, priorities, avoided ingredients, default days.
3. Invites: create, revoke, accept, optional email delivery, expired/revoked/accepted state rules.
4. Week planning: lifecycle, planning request, day settings, assign/replace, lock, skip, move, servings, pool, generate/regenerate.
5. Week history: finalize, list, detail, and historical read-only behavior.
6. Shopping list: derived items, checked state, manual items, pantry behavior, bulk clear/undo if retained.
7. Recipes: list/search, create/edit/archive, fork, public/community search, saved/bookmarked recipes, detail.
8. Recipe intelligence: AI fill-in, URL import, translation cache, recommendations.
9. Meal prep: prep batches, lunch coverage, shopping list scaling, batch-friendly recommendations.
10. Billing and premium: trial state, subscription state, Stripe checkout/webhook, premium gates.
11. Operations: rate limiting, security events, analytics where backend-owned, health checks, migration smoke tests.

Exit criteria:

- Every non-deprecated MealPlanner API route is represented in `Veckly-backend`.
- API parity matrix has no `missing` rows.
- Route-level and RLS tests cover household isolation.
- OpenAPI spec includes every iOS-needed operation.
- Backend build and tests are green.

## Phase 3 — Web Strangler Migration

Status: not started

Purpose: prove the new backend with the existing web product before relying on it for iOS beta.

Work order:

1. Add backend base URL and server-to-server auth strategy to `MealPlanner`.
2. Move read-only routes first: household summary, week summary, recipe list/detail.
3. Move low-risk writes: shopping list checked state and household preferences.
4. Move high-risk week writes: generation, meal changes, locks/skips/moves, finalization/history.
5. Move recipes and AI-backed routes.
6. Move billing/webhooks last.
7. Delete or permanently proxy old API routes once stable.

Exit criteria:

- Web app can run against `Veckly-backend` for all active product flows.
- E2E smoke journey passes through the new backend.
- Old backend route ownership is documented: deleted, proxied, or deprecated.

## Phase 4 — iOS Foundation

Status: in progress

Purpose: make iOS a stable native client of the backend contract.

Work order:

1. Auth: Supabase Auth SDK, Sign in with Apple, session persistence, sign out, expired-token recovery.
2. Environments: local, staging, production, and clear app-level switching for development builds.
3. OpenAPI workflow: regenerate from `Veckly-backend`, compile generated code, keep generated types out of manual edits.
4. App shell: signed-out state, signed-in tab structure, household loading/empty states, global error patterns.
5. Observability: crash reporting decision, basic analytics decision, API error logging for beta builds.

Exit criteria:

- User can sign in on device.
- App restores session after restart.
- App fetches household and current week from real backend.
- Generated OpenAPI client is the only API client for backend routes.

## Phase 5 — iOS Product Parity

Status: not started

Purpose: build the native app to the point where a family can test Veckly without depending on the web app for core planning.

Work order:

1. Week read experience: current week, empty week, today focus, meal detail.
2. Week planning actions: generate, regenerate, choose/change meal, lock, skip, move, edit servings.
3. Meal picker: search, household recipes, recommendations, saved/community recipes if supported.
4. Shopping list: grouped ingredients, checked state sync, manual items, share list if retained.
5. Recipes: list, detail, create/edit, archive, URL import, AI fill-in.
6. Household: preferences, members, invite/join.
7. Meal prep: prep batch display, create/delete prep batch, lunch coverage.
8. Premium: trial/subscription status, premium gates, upgrade entry point.

Exit criteria:

- A beta family can sign in, create or join a household, plan the week, adjust meals, and use the shopping list from iOS.
- Web and iOS show the same household state.
- Any remaining web-only behavior is explicitly listed as out of scope for the first TestFlight build.

## Phase 6 — TestFlight Readiness

Status: not started

Purpose: prepare iOS for internal and then external beta testing.

Work order:

1. Apple project setup: bundle id, signing, app icon, launch screen, display name.
2. App Store Connect: app record, TestFlight groups, beta review metadata.
3. Privacy and compliance: privacy manifest, data collection notes, account deletion/support path, Sign in with Apple compliance.
4. Backend production readiness: staging/prod separation, env vars, rate limits, security headers, migration runbook, rollback plan.
5. QA: simulator, device, small/large iPhone, dark mode, poor network/offline, fresh install, upgrade install.
6. Release: archive, upload, internal TestFlight pass, external TestFlight submission.

Exit criteria:

- Archive succeeds.
- Internal TestFlight build is installed and smoke-tested.
- External TestFlight build is approved or ready for beta review submission.

## Immediate Next Tasks

Start here:

1. Create the API parity matrix for `MealPlanner/src/app/api/**`.
2. Compare it with current `Veckly-backend` routes.
3. Mark missing/partial/migrated/deprecated rows.
4. Pick the first backend slice from the matrix.
5. Implement and test that slice end-to-end:
   - backend route
   - RLS/auth tests
   - OpenAPI update
   - iOS generated client compile

## Progress Log

- 2026-06-10: Plan created. Phase 0 is the next active task. Phase 1 and Phase 4 already have foundations in place but need parity validation before being marked complete.
- 2026-06-10: Phase 0 started. API parity matrix created at `docs/migration/api-parity.md`; first recommended implementation slice is household profile/preferences, public member routes, active week pointer, week event expansion, then shopping-list compatibility.
- 2026-06-10: Phase 0 completed. Next implementation work starts in Phase 1 with household profile/preferences as the first backend parity slice.
- 2026-06-10: Phase 1 first slice completed. Household profile/preferences added as `GET/PUT /households/{householdId}/profile`, backed by `household_profiles` RLS table, OpenAPI generation, and iOS client regeneration.
- 2026-06-10: Phase 1 member route slice completed. Public OpenAPI operations added for member list, role update, and member removal; iOS client regenerated and compiled.
- 2026-06-10: Phase 1 active week slice completed. Active week pointer added as `GET/PUT/DELETE /households/{householdId}/active-week`, backed by active-membership RLS; iOS client regenerated and compiled.
- 2026-06-10: Phase 1 week-plan event vocabulary slice completed. Projection now folds planning request update, assign/unassign, lock/unlock, move, skip/unskip, servings change, and clear events; iOS client regenerated and compiled.
