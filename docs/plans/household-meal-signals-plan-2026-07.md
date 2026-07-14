# Household Meal Signals Plan (2026-07)

## Status

In progress — backend schema/API, generation scoring, and iOS DayDetail UI slices complete 2026-07-14. Retro prompt is not started.

## Why this exists

Veckly currently has two different ideas that can sound similar but are not the same:

- `meal_feedback`: private, per-user thumbs up/down. RLS only lets the signed-in user read their own rows, even inside the same household.
- "Family" UI such as family cookbook: currently built from the signed-in user's private feedback plus household planning history.

That privacy model is correct, but it means Veckly does not yet have a true household-level signal for "this works for us". Phase 5 of the iOS family-experience plan adds that missing layer without building a full multi-person preference engine.

## Product Contract

Household meal signals are shared household memory. Every active member can see the current household signal for a meal.

V1 supports exactly two signals:

- `works_for_family`: this meal is a reliable household option.
- `not_for_us`: this meal should usually be avoided for this household.

Private meal feedback remains private:

- A member's `meal_feedback` rows must not become visible to another member.
- Personal thumbs up/down can still affect generation for the member who clicks Generate.
- Household signals can affect everyone because they are explicitly household-scoped.

## Proposed Backend Model

Implemented as migration `0030_household_meal_signals.sql`, with a new table instead of extending `meal_feedback`.

```sql
CREATE TYPE household_meal_signal AS ENUM ('works_for_family', 'not_for_us');

CREATE TABLE household_meal_signals (
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE cascade,
  meal_id text NOT NULL,
  signal household_meal_signal NOT NULL,
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id, meal_id)
);
```

Recommended indexes:

- `(household_id, updated_at)`
- `(updated_by, updated_at)` only if moderation/audit UI needs it later.

## RLS Contract

Policies should use the same active-membership invariant as other shared household tables:

- Active household members can `SELECT` rows for their household.
- Active household members can `INSERT`, `UPDATE`, and `DELETE` rows for their household.
- `updated_by` should equal `auth.uid()` on insert/update.
- Removed members and non-members must see zero rows and fail writes.

This is intentionally different from `meal_feedback`, where SELECT is additionally constrained to `user_id = auth.uid()`.

## API Shape

Public OpenAPI routes under households:

- `GET /households/{householdId}/meal-signals`
- `PUT /households/{householdId}/meal-signals`

Suggested response:

```ts
type HouseholdMealSignalRecord = {
  householdId: string
  mealId: string
  signal: 'works_for_family' | 'not_for_us'
  updatedAt: string
}

type ListHouseholdMealSignalsResponse = {
  signals: Record<string, 'works_for_family' | 'not_for_us'>
  items: HouseholdMealSignalRecord[]
}
```

Suggested PUT body:

```ts
type UpsertHouseholdMealSignal = {
  mealId: string
  signal: 'works_for_family' | 'not_for_us' | null
}
```

`signal: null` removes the household signal.

Do not include partner-private vote data in this response.

## Implemented 2026-07-14

- `household_meal_signal` enum with `works_for_family` and `not_for_us`.
- `household_meal_signals` table keyed by `(household_id, meal_id)`.
- Active-member RLS for SELECT/INSERT/UPDATE/DELETE.
- `updated_by = auth.uid()` enforced on INSERT/UPDATE.
- `src/household-meal-signals.ts` repository/routes.
- Public operations: `listHouseholdMealSignals`, `upsertHouseholdMealSignal`.
- OpenAPI regenerated in backend and iOS; Swift OpenAPI client regenerated.
- `test/household-meal-signals.test.ts` covers shared visibility, cross-household isolation, private feedback isolation, direct RLS writes, removal, and unauthenticated route behavior.
- `test/migrations.ts` now recognizes post-0029 migrations and grants authenticated access to `household_meal_signals`.
- `doGenerateWeekPlan` now reads `household_meal_signals` and passes them into `rankCandidates`.
- `week-scoring.ts` now scores household signals separately from private `meal_feedback`.
- `test/week-scoring.test.ts` covers the scoring weights.
- `test/week-plan.test.ts` covers works-for-family preference, not-for-us penalty, and not-for-us as non-absolute when it is the only candidate.

## Scoring Rules

Implemented generation behavior is simple and explainable:

- `works_for_family`: +10 positive boost across the household.
- `not_for_us`: -20 strong negative penalty across the household.
- Personal `meal_feedback` still applies for the generating user.
- Allergy/avoid-ingredient filtering remains stronger than household signal scoring.

`not_for_us` is not an absolute exclusion in v1. Families may change their mind, and the product copy should avoid implying safety/allergy semantics. If it is the only available candidate, generation can still use it; if there is a reasonable neutral alternative, the neutral meal should win.

## iOS Placement

First UI surface implemented:

- Day detail sheet: shows a calm shared-memory row for the selected meal, separate from private thumbs up/down.

Potential follow-up:

- Sunday retro: after a meal gets a thumbs-up, optionally let the user mark "Works for the family".

Avoid putting this on every recipe card in v1. The signal should feel like household memory, not a voting dashboard.

## Test Plan

Backend:

- Active member A can write `works_for_family`.
- Active member B in the same household can read that household signal.
- Member B still cannot read member A's `meal_feedback`.
- Non-member cannot read or write household signals.
- Removed member cannot read or write household signals.
- `signal: null` removes the row.
- Week generation scoring prefers `works_for_family` and penalizes `not_for_us`.

iOS:

- Loads household signals once per household session.
- Optimistically updates signal and rolls back on failure.
- Keeps private thumbs up/down UI separate from household signal UI.
- Does not block retro completion if household-signal write fails.

## Next Slice

Evaluate whether Sunday retro should get a mild "Works for the family?" follow-up after thumbs up, or move on to Phase 6 shopping handoff if DayDetail is enough for v1 beta.
