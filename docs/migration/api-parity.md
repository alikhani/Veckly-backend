# API Parity Matrix

Status: phase 0 complete
Created: 2026-06-10

This matrix tracks the backend move from `MealPlanner/src/app/api/**` into
`Veckly-backend`. `MealPlanner` remains the behavior reference until a row is
marked `migrated`.

Status values:

- `migrated`: public `Veckly-backend` route exists and covers the MealPlanner behavior.
- `partial`: some backend route exists, but contract or behavior is incomplete.
- `internal-proxy`: backend has an internal strangle route used by MealPlanner, but no final public contract.
- `missing`: no equivalent backend implementation yet.
- `deprecated`: do not move; replace or retire during the migration.

## Backend Routes Already Present

Public OpenAPI routes:

| Method | Backend route | Operation id | Notes |
|---|---|---|---|
| GET | `/households/me` | `getMyHouseholds` | Public household list, no MealPlanner auto-bootstrap semantics. |
| POST | `/households/me/bootstrap` | `bootstrapMyHousehold` | Supabase Auth replacement for MealPlanner auto-household creation. |
| PATCH | `/households/{id}` | `renameHousehold` | Owner-only rename via RLS. |
| POST | `/households/{householdId}/invites` | `createHouseholdInvite` | Invite DB write only; email delivery not moved. |
| GET | `/households/{householdId}/invites` | `listHouseholdInvites` | Pending invites. |
| DELETE | `/households/{householdId}/invites/{inviteId}` | `revokeHouseholdInvite` | Uses invite UUID, while MealPlanner client route uses token. |
| GET | `/invites/{token}` | `getInviteLanding` | Authenticated token preview. |
| POST | `/invites/{token}/accept` | `acceptInvite` | Accept invite and join household. |
| POST | `/households/{householdId}/week-plans/{weekStartDate}/events` | `appendWeekPlanEvent` | Event model proof slice. |
| GET | `/households/{householdId}/week-plans/{weekStartDate}` | `getWeekPlan` | Raw projection read. |
| GET | `/households/{householdId}/week-plans/{weekStartDate}/summary` | `getWeekPlanSummary` | iOS-friendly read model. |
| GET | `/households/{householdId}/week-plans` | `listWeekHistoryPlans` | Persisted week history list/read model. |
| GET | `/households/{householdId}/week-plans/{weekStartDate}/history` | `getWeekHistoryPlan` | Persisted week history detail. |
| PATCH | `/households/{householdId}/week-plans/{weekStartDate}/history` | `upsertWeekHistoryPlan` | Persist/update week history state with OCC. |
| POST | `/households/{householdId}/week-plans/{weekStartDate}/finalize` | `finalizeWeekHistoryPlan` | Finalize persisted week plan metadata. |
| POST | `/households/{householdId}/shopping-lists/{weekStartDate}/events` | `appendShoppingListEvent` | Event model proof slice. |
| GET | `/households/{householdId}/shopping-lists/{weekStartDate}` | `getShoppingList` | Raw projection read. |
| GET | `/households/{householdId}/shopping-lists/{weekStartDate}/summary` | `getShoppingListSummary` | iOS-friendly grouped read model. |
| GET | `/households/{householdId}/shopping-lists/{weekStartDate}/state` | `getShoppingListState` | Shared checklist and pantry state. |
| PATCH | `/households/{householdId}/shopping-lists/{weekStartDate}/state` | `updateShoppingListState` | Replace/clear shared checklist and pantry state with OCC. |
| GET | `/households/{householdId}/recipes` | `listRecipes` | Household recipes CRUD foundation. |
| POST | `/households/{householdId}/recipes` | `createRecipe` | Household recipes CRUD foundation. |
| GET | `/households/{householdId}/recipes/{recipeId}` | `getRecipe` | Household recipes CRUD foundation. |
| PATCH | `/households/{householdId}/recipes/{recipeId}` | `updateRecipe` | Includes archive via `isArchived`. |
| GET | `/recipes/public` | `listPublicRecipes` | Community recipe search; excludes caller households. |
| GET | `/recipes/saved` | `listSavedRecipes` | Current user's saved/bookmarked recipes. |
| POST | `/recipes/{recipeId}/save` | `saveRecipe` | Idempotent save for readable recipes. |
| DELETE | `/recipes/{recipeId}/save` | `unsaveRecipe` | Idempotent unsave. |

Internal strangle routes already present:

| Method | Backend route | Used by MealPlanner route | Notes |
|---|---|---|---|
| GET | `/internal/households/me` | `GET /api/households` | Preserves ensure-personal-household semantics. |
| POST | `/internal/households` | `POST /api/households` | Named household creation. |
| PATCH | `/internal/households/:id` | `PATCH /api/households/[id]` | Rename proxy. |
| GET | `/internal/households/:householdId/members` | `GET /api/households/[id]/members` | MealPlanner still hydrates emails. |
| PATCH | `/internal/households/:householdId/members/:userId` | `PATCH /api/households/[id]/members/[userId]` | Role update proxy. |
| DELETE | `/internal/households/:householdId/members/:userId` | `DELETE /api/households/[id]/members/[userId]` | Remove member proxy. |
| POST | `/internal/households/:householdId/invites` | `POST /api/households/[id]/invites` | Email remains in MealPlanner. |
| GET | `/internal/households/:householdId/invites` | `GET /api/households/[id]/invites` | Pending invite list. |
| DELETE | `/internal/households/:householdId/invites/:token` | `DELETE /api/households/[id]/invites/[token]` | Token revoke compatibility. |

## MealPlanner Route Parity

### Auth and User State

| MealPlanner route | Behavior | Target backend route | Auth | Household/RLS | Status | Test coverage / next action |
|---|---|---|---|---|---|---|
| GET/POST `/api/auth/[...all]` | Better Auth web session endpoints. | Supabase Auth, not Hono route. | Supabase Auth | n/a | deprecated | Do not port as-is. iOS and backend use Supabase Auth bearer tokens. Web migration needs a separate auth cutover plan. |
| GET `/api/users/me/trial-status` | Reads trial/subscription status for current user. | TBD `/users/me/trial-status` or billing module. | required | user scoped | missing | Move with billing/premium slice. |

### Households and Members

| MealPlanner route | Behavior | Target backend route | Auth | Household/RLS | Status | Test coverage / next action |
|---|---|---|---|---|---|---|
| GET `/api/households` | Ensure personal household, list memberships. | Public: `GET /households/me`; internal: `GET /internal/households/me`. | required | RLS memberships | internal-proxy | Backend tests cover list/bootstrap. Decide whether public route should auto-bootstrap or keep explicit bootstrap. |
| POST `/api/households` | Create named household for current user. | Internal: `POST /internal/households`; public target TBD `POST /households`. | required | RLS memberships | internal-proxy | Backend has domain function and internal proxy; add public OpenAPI operation if iOS needs create-household outside bootstrap. |
| PATCH `/api/households/[id]` | Owner renames household. | Public: `PATCH /households/{id}`; internal: `PATCH /internal/households/:id`. | required | RLS owner update | partial | Backend tests cover owner/member/non-member. Response shape differs from MealPlanner `{ ok, householdId, name }`. |
| GET `/api/households/[id]/members` | List household members with emails. | `GET /households/{householdId}/members`. | required | RLS membership | migrated | Backend public contract returns `userId` and `role`; email remains web-side/compat concern until user profile contract exists. |
| PATCH `/api/households/[id]/members/[userId]` | Owner changes role, preserves last-owner invariant. | `PATCH /households/{householdId}/members/{userId}`. | required | RLS + owner policy | migrated | Backend tests cover role update invariants; public route added to OpenAPI. |
| DELETE `/api/households/[id]/members/[userId]` | Owner removes member, preserves last-owner invariant. | `DELETE /households/{householdId}/members/{userId}`. | required | RLS + owner policy | migrated | Backend tests cover remove-member invariants; public route added to OpenAPI. |

### Household Profile and Preferences

| MealPlanner route | Behavior | Target backend route | Auth | Household/RLS | Status | Test coverage / next action |
|---|---|---|---|---|---|---|
| GET `/api/household-profile` | Read current user's household planning profile. | `GET /households/{householdId}/profile`. | required | RLS active membership | migrated | New backend profile is household-owned, not user-owned. Route returns `{ profile }`, with `null` when no profile exists. |
| PUT `/api/household-profile` | Upsert planning profile. | `PUT /households/{householdId}/profile`. | required | RLS active membership | migrated | Supports adults, children, priorities, avoid ingredients, selected days. Non-members and removed members blocked by RLS. |

### Invites

| MealPlanner route | Behavior | Target backend route | Auth | Household/RLS | Status | Test coverage / next action |
|---|---|---|---|---|---|---|
| GET `/api/households/[id]/invites` | List pending invites. | Public: `GET /households/{householdId}/invites`; internal proxy exists. | required | RLS membership | partial | Backend tests cover invite visibility. Response shape differs. |
| POST `/api/households/[id]/invites` | Create invite, optionally send Resend email. | Public: `POST /households/{householdId}/invites`; internal proxy exists. | required | RLS membership | partial | Backend creates invite; email delivery still in MealPlanner. Move email integration or keep web-owned temporarily. |
| DELETE `/api/households/[id]/invites/[token]` | Revoke invite by token. | Public uses invite id: `DELETE /households/{householdId}/invites/{inviteId}`; internal token proxy exists. | required | RLS membership | partial | Add public token revoke or update clients to use invite id consistently. |
| POST `/api/household-invites/accept` | Accept invite from token body. | `POST /invites/{token}/accept`. | required | token-assisted RLS | partial | Backend route uses path token and Supabase session. Web route compatibility wrapper needed during cutover. |

### Active Week, Week Plans, and History

| MealPlanner route | Behavior | Target backend route | Auth | Household/RLS | Status | Test coverage / next action |
|---|---|---|---|---|---|---|
| GET `/api/households/[id]/active-plan` | Read current active plan state, week-aware fallback. | `GET /households/{householdId}/week-plans/{weekStartDate}/summary` plus raw projection. | required | RLS projection | partial | Backend has iOS summary only. Need full state contract or web adapter. |
| PATCH `/api/households/[id]/active-plan` | OCC write/clear active plan, sync to week history, premium gate. | Event routes under `/week-plans/{weekStartDate}/events`. | required | RLS event append | partial | Event vocabulary now covers request update, assign/unassign, lock/unlock, move, skip/unskip, servings, and clear. Remaining gap: web compatibility adapter and premium gate. |
| GET `/api/households/[id]/active-week` | Read household active week pointer. | `GET /households/{householdId}/active-week`. | required | RLS active membership | migrated | Implemented as a small CRUD pointer resource, not an event stream. |
| PATCH `/api/households/[id]/active-week` | Set/clear active week with OCC. | `PUT /households/{householdId}/active-week`; `DELETE /households/{householdId}/active-week`. | required | RLS active membership | partial | New backend omits MealPlanner's `expectedUpdatedAt` OCC shape; event/projection writes carry ordering elsewhere. |
| GET `/api/households/[id]/weeks` | List week history with filters/pagination. | `GET /households/{householdId}/week-plans`. | required | RLS week history table | migrated | Returns planned days, request, replacements, skipped days, source/status/timezone/updated metadata. Free-tier cutoff remains web/billing policy work. |
| GET `/api/households/[id]/weeks/[weekStartDate]` | Read week history/detail. | `GET /households/{householdId}/week-plans/{weekStartDate}/history`. | required | RLS week history table | migrated | Returns `{ week }` with status/source/timezone/state metadata or `null`. |
| PATCH `/api/households/[id]/weeks/[weekStartDate]` | Upsert draft/finalized week with OCC, source, timezone. | `PATCH /households/{householdId}/week-plans/{weekStartDate}/history`. | required | RLS week history table | migrated | Supports `expectedUpdatedAt`, status/source, timezone, state, ISO week number/year, and stale conflict response. Premium gate remains billing slice. |
| POST `/api/households/[id]/weeks/[weekStartDate]/finalize` | Finalize week, premium gate. | `POST /households/{householdId}/week-plans/{weekStartDate}/finalize`. | required | RLS week history table | partial | Finalizes existing persisted week metadata. Premium gate remains billing slice. |

### Shopping List

| MealPlanner route | Behavior | Target backend route | Auth | Household/RLS | Status | Test coverage / next action |
|---|---|---|---|---|---|---|
| GET `/api/households/[id]/shopping-state` | Read checked items and pantry stock with OCC timestamp. | `GET /households/{householdId}/shopping-lists/{weekStartDate}/state`. | required | RLS projection | migrated | Backend returns `{ state, updatedAt }` with `state: null` when unset/cleared. Web adapter must supply active `weekStartDate`. |
| PATCH `/api/households/[id]/shopping-state` | Write/clear checked items and pantry stock with OCC. | `PATCH /households/{householdId}/shopping-lists/{weekStartDate}/state`. | required | RLS event append + projection | migrated | Supports replace, clear via `state: null`, pantry stock, and stale `expectedUpdatedAt` conflict response. Manual items remain local-only per ADR 0038 unless product changes. |

### Saved Plans and Meal Feedback

| MealPlanner route | Behavior | Target backend route | Auth | Household/RLS | Status | Test coverage / next action |
|---|---|---|---|---|---|---|
| GET `/api/saved-plans` | List user's saved plan templates. | Public: `GET /saved-plans`; internal: `GET /internal/saved-plans`. | required | user scoped RLS | migrated | Backend returns the MealPlanner `{ id, createdAt, label, state }[]` shape; web can proxy via internal route. |
| POST `/api/saved-plans` | Save current plan as template. | Public: `POST /saved-plans`; internal: `POST /internal/saved-plans`. | required | user scoped RLS | migrated | Premium limit remains in MealPlanner until billing moves. Backend owns persistence. |
| PATCH `/api/saved-plans/[id]` | Rename/update saved plan. | Public: `PATCH /saved-plans/{id}`; internal: `PATCH /internal/saved-plans/{id}`. | required | user scoped RLS | migrated | Internal route preserves `{ ok: true }` for web compatibility. |
| DELETE `/api/saved-plans/[id]` | Delete saved plan. | Public: `DELETE /saved-plans/{id}`; internal: `DELETE /internal/saved-plans/{id}`. | required | user scoped RLS | migrated | Delete is idempotent for caller-owned rows. |
| GET `/api/meal-feedback` | Read persisted meal feedback. | `GET /households/{householdId}/meal-feedback`. | required | user + active household membership RLS | migrated | Returns `{ feedback, items }`; `feedback` preserves MealPlanner's keyed shape for current user's votes in the household. |
| PUT `/api/meal-feedback` | Upsert/remove meal feedback. | `PUT /households/{householdId}/meal-feedback`. | required | user + active household membership RLS | migrated | Body keeps `{ mealId, feedback }`; `feedback: null` removes the vote. |

### Recipes

| MealPlanner route | Behavior | Target backend route | Auth | Household/RLS | Status | Test coverage / next action |
|---|---|---|---|---|---|---|
| GET `/api/custom-recipes` | List custom/family recipes. | `GET /households/{householdId}/recipes` plus `GET /internal/custom-recipes`. | required | RLS recipes | migrated | Internal route preserves MealPlanner `{ recipes }` envelope and title search while using the backend recipes model. |
| POST `/api/custom-recipes` | Create custom recipe. | `POST /households/{householdId}/recipes` plus `POST /internal/custom-recipes`. | required | RLS recipes | migrated | MealPlanner keeps premium gate; backend stores recipe in bootstrapped/default household when no household is provided. Fork lineage is intentionally not preserved in this first strangle slice. |
| GET `/api/custom-recipes/[id]` | Get custom recipe detail. | `GET /households/{householdId}/recipes/{recipeId}` plus `GET /internal/custom-recipes/{id}`. | required | RLS recipes | migrated | Internal route returns `{ recipe }` with MealPlanner detail fields. |
| PATCH `/api/custom-recipes/[id]` | Edit recipe. | `PATCH /households/{householdId}/recipes/{recipeId}` plus `PATCH /internal/custom-recipes/{id}`. | required | RLS recipes | migrated | MealPlanner keeps validation and publish premium gate. |
| PATCH `/api/custom-recipes/[id]/archive` | Archive recipe. | `PATCH /households/{householdId}/recipes/{recipeId}` plus `PATCH /internal/custom-recipes/{id}/archive`. | required | RLS recipes | migrated | Internal route maps archive to backend `isArchived` update. |
| GET `/api/recipes/public` | Search public community recipes. | `GET /recipes/public?q=...`. | required | public + RLS exclusions | migrated | Returns `{ recipes }`, requires non-blank query, caps at 120 chars, excludes caller households, limits to non-archived public `user_created` recipes. |
| GET `/api/recipes/saved` | List saved/bookmarked recipes. | `GET /recipes/saved`. | required | user scoped + recipe RLS | migrated | Backed by `user_saved_recipes`; archived saved recipes are hidden. |
| POST `/api/recipes/[id]/save` | Save/bookmark community recipe. | `POST /recipes/{recipeId}/save`. | required | user scoped + recipe RLS | migrated | Idempotent; saves only recipes readable by the caller. Non-readable recipe returns not found. |
| DELETE `/api/recipes/[id]/save` | Remove saved/bookmarked recipe. | `DELETE /recipes/{recipeId}/save`. | required | user scoped | migrated | Idempotent unsave for current user. |
| POST `/api/recipes/[id]/translate` | AI translate and cache recipe translation. | TBD `/recipes/{id}/translate`. | required | recipe visibility/RLS | missing | Move with AI/translation slice. |
| POST `/api/recipes/fill-in` | AI fill-in title-only recipe details. | `POST /recipes/fill-in` plus `POST /internal/recipes/fill-in`. | required | user scoped | migrated | Backend owns Claude call, schema validation, and 10s user rate limit; MealPlanner can proxy while keeping the old response envelope. |
| POST `/api/recipes/import-from-url` | Fetch URL, structured-data extraction, AI fallback, SSRF guard/rate limit. | TBD `/recipes/import-from-url`. | required | user scoped | missing | Move with URL import slice. |
| POST `/api/recipes/recommend` | AI recommendations, including prep context. | TBD `/recipes/recommend`. | required | household scoped | missing | Move after feedback/history/profile parity. |

### Meal Prep

| MealPlanner route | Behavior | Target backend route | Auth | Household/RLS | Status | Test coverage / next action |
|---|---|---|---|---|---|---|
| GET `/api/households/[id]/prep-batches` | List prep batches for a date window. | TBD `/households/{householdId}/prep-batches`. | required | household scoped | missing | Move after week/shopping base. |
| POST `/api/households/[id]/prep-batches` | Create prep batch with covered days/meals. | TBD `/households/{householdId}/prep-batches`. | required | household scoped | missing | Move with meal prep slice. |
| DELETE `/api/households/[id]/prep-batches/[batchId]` | Delete prep batch. | TBD `/households/{householdId}/prep-batches/{batchId}`. | required | household scoped | missing | Move with meal prep slice. |

### Billing, Premium, and Subscribe

| MealPlanner route | Behavior | Target backend route | Auth | Household/RLS | Status | Test coverage / next action |
|---|---|---|---|---|---|---|
| POST `/api/stripe/checkout` | Create Stripe Checkout session. | TBD `/billing/checkout`. | required | user/subscription scoped | missing | Move after core beta flows or before commercial iOS test. |
| POST `/api/stripe/webhook` | Stripe webhook updates subscription state. | TBD `/billing/stripe/webhook`. | Stripe signature | user/subscription scoped | missing | Requires raw body handling in Hono/Vercel. |
| GET `/api/subscribe/insights` | Conversion insight data for upgrade modal. | TBD `/subscribe/insights` or `/billing/insights`. | required | household scoped | missing | Depends on week history, recipes, household membership parity. |

## First Implementation Slice

Recommended next slice after this inventory:

1. Recipe fork-lineage/premium publish parity, or meal feedback/saved plans:
   - fork-lineage/premium publish closes the remaining custom recipe gaps
   - meal feedback/saved plans unblock recommendation and template flows

This order keeps the first phase focused on backend contract stability before
iOS feature parity work begins.

## Phase 0 Exit Check

- API parity matrix exists: complete.
- Every active `MealPlanner/src/app/api/**/route.ts` file has a target status: complete.
- First backend implementation slice is selected: complete.

## Progress Log

- 2026-06-10: Household profile/preferences migrated to `GET/PUT /households/{householdId}/profile` with RLS-backed household ownership, OpenAPI operations, and tests.
- 2026-06-10: Public household member routes added to OpenAPI: list members, update role, remove member. Response intentionally omits email until a user profile contract exists.
- 2026-06-10: Active week pointer added as `GET/PUT/DELETE /households/{householdId}/active-week`, backed by `household_active_weeks` with active-membership RLS.
- 2026-06-10: Week-plan event vocabulary expanded beyond `week_started`/`meal_assigned`: planning request update, unassign, lock/unlock, move, skip/unskip, servings change, and clear. Projection remains the read path.
- 2026-06-10: Shopping-state compatibility added as `GET/PATCH /households/{householdId}/shopping-lists/{weekStartDate}/state`, with checked items, pantry stock, clear semantics, stale-write conflicts, OpenAPI updates, and iOS client regeneration.
- 2026-06-10: Recipe community/saved parity added: `GET /recipes/public`, `GET /recipes/saved`, `POST/DELETE /recipes/{recipeId}/save`, plus `user_saved_recipes` RLS table and iOS client regeneration.
- 2026-06-10: Week-history parity added: `GET /households/{householdId}/week-plans`, `GET/PATCH /households/{householdId}/week-plans/{weekStartDate}/history`, and `POST /households/{householdId}/week-plans/{weekStartDate}/finalize`, backed by `household_week_plans` RLS table.
- 2026-06-11: Meal feedback migrated as `GET/PUT /households/{householdId}/meal-feedback`, backed by user-owned, household-scoped `meal_feedback` rows with active-membership RLS.
- 2026-06-11: Meal feedback gained internal strangle routes at `GET/PUT /internal/meal-feedback` so MealPlanner can keep its user-scoped `/api/meal-feedback` contract while writes land in the backend household-scoped table.
- 2026-06-11: Custom recipes gained internal strangle routes at `/internal/custom-recipes`; MealPlanner can keep its API envelopes while adapting to the backend recipes model. Fork lineage remains a follow-up rather than a blocker.
- 2026-06-11: Recipe fill-in migrated as `POST /recipes/fill-in` plus `POST /internal/recipes/fill-in`, returning the same raw validated AI recipe shape MealPlanner already consumes.
- 2026-06-11: Saved plans migrated as `GET/POST/PATCH/DELETE /saved-plans`, plus internal web-strangler routes under `/internal/saved-plans`; persistence is user-scoped with RLS.
