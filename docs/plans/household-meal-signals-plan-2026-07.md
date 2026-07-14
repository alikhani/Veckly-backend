# Household Meal Signals Plan (2026-07)

## Status

In progress — product and technical contract decided 2026-07-14. Implementation not started.

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

Create a new table instead of extending `meal_feedback`.

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

Add public OpenAPI routes under households:

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

## Scoring Rules

Initial generation behavior should be simple and explainable:

- `works_for_family`: meaningful positive boost across the household.
- `not_for_us`: strong negative penalty across the household.
- Personal `meal_feedback` still applies for the generating user.
- Allergy/avoid-ingredient filtering remains stronger than household signal scoring.

`not_for_us` should not be an absolute exclusion in v1. Families may change their mind, and the product copy should avoid implying safety/allergy semantics.

## iOS Placement

Preferred first UI surface:

- Sunday retro: after a meal gets a thumbs-up, optionally let the user mark "Works for the family".
- Day detail sheet: show a calm shared-memory row for the selected meal.

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

Implement the backend migration, schema, routes, OpenAPI generation, and RLS tests first. Then regenerate the iOS client and add the smallest iOS store/UI surface.
