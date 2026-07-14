# Beta Research Script — 2-Week Family Test, 2026-07

## Status

Ready for first 5-10 TestFlight families.

## Goal

Validate whether a household can complete Veckly's core weekly loop twice:

1. Set up the household.
2. Create a real dinner plan.
3. Finish the week plan.
4. Use or share the shopping list.
5. Come back the following week and reflect.

This is not a feature discovery test. Keep the script focused on the weekly habit and the handoff from planning to shopping.

## Participants

Recruit 5-10 households that match at least two of these:

- They cook dinner at home at least 3 nights per week.
- More than one person cares about what gets cooked or bought.
- They currently coordinate meals through memory, notes, chat, or a grocery app.
- They are willing to use TestFlight for two consecutive weeks.

Avoid households that only want recipe inspiration. Veckly is being tested as a weekly household planning tool, not a recipe browsing product.

## Before The Test

Send this setup note:

```text
We are testing whether Veckly helps a household plan dinners for the week and know what to buy.

Please use it for two real weeks, not as a demo:
1. Install the TestFlight build.
2. Complete onboarding.
3. Plan dinners for the coming week.
4. Use the shopping list if you shop for the week.
5. Come back next week and do it again.

It is useful if you tell us where you get stuck. It is also useful if you ignore a feature because it does not fit your routine.
```

## Operator Checklist

Before inviting a household:

- Confirm they can install TestFlight.
- Confirm at least one adult will do the Sunday planning flow.
- Confirm whether a second adult can receive the shopping/share/invite handoff.
- Record household label outside the app, for example `beta-family-01`.
- Do not ask them to create fake meals or fake shopping behavior.

After they start:

- Check Supabase event funnel after onboarding.
- Follow up manually only if they are blocked, not just because an event is missing.
- Capture quotes verbatim when they describe confusion, trust, or repeated use.

## Week 1 Script

### Task 1 — Onboard

Prompt:

```text
Open Veckly and set up your household like you normally eat at home.
```

Observe:

- Do they understand what the go-to dish is for?
- Do they choose real planning days?
- Do avoid-ingredients feel like allergies, preferences, or both?

Expected event:

- `onboarding_completed`

### Task 2 — Create The First Plan

Prompt:

```text
Create a plan for the coming week. You can generate, swap, skip, or manually pick meals until it looks usable.
```

Observe:

- Do they know what to do after onboarding dismisses?
- Does "Generate" feel like the obvious next action?
- Do they trust the first result enough to edit it instead of abandoning it?
- Which days get changed first?

Expected events:

- `first_week_generated`
- `week_completed`

### Task 3 — Move To Shopping

Prompt:

```text
When the week feels planned, open the shopping list and decide if it is useful for your real shopping.
```

Observe:

- Do they notice the completion card?
- Do they tap the shopping CTA or navigate manually?
- Does the list feel complete enough to act on?
- Do staples create confusion or confidence?

Expected events:

- `shopping_opened_after_week_completed`
- `shopping_main_list_completed` if they check off the main list

### Task 4 — Household Handoff

Prompt:

```text
If someone else in the household shops or helps decide dinners, share the plan/list or invite them.
```

Observe:

- Does the share action solve the immediate need?
- Does the invite CTA appear at a moment that makes sense?
- Do they understand why another household member would join?

Expected events:

- `shopping_shared`
- `partner_invite_clicked`

## Midweek Check-In

Send after 2-3 days:

```text
Quick check: did you look back at Veckly during the week, or was it mainly useful on planning/shopping day?

If anything felt wrong, what was the first moment where it stopped matching your real week?
```

Record:

- Did they cook from the plan?
- Did they adjust outside the app?
- Did they use the shopping list in store, before store, or not at all?
- Did another household member see or use the plan?

## Week 2 Script

### Task 5 — Return And Reflect

Prompt:

```text
Open Veckly again for next week. If you see any recap or reflection prompt, answer it based on what actually happened.
```

Observe:

- Do they remember to return without heavy prompting?
- Does retro feel helpful or like homework?
- Do they use feedback/family-signal surfaces?

Expected event:

- `retro_completed`

### Task 6 — Plan The Second Week

Prompt:

```text
Plan next week using what you learned from the first week.
```

Observe:

- Is the second planning session faster?
- Do they expect Veckly to remember what worked?
- Do they reuse go-to/family meals?
- Are swaps more targeted than in week 1?

Expected events:

- `week_completed`
- `shopping_opened_after_week_completed`
- `shopping_shared` or `shopping_main_list_completed` when applicable

## Metrics To Review

Primary funnel:

- `onboarding_completed` → `first_week_generated`
- `first_week_generated` → `week_completed`
- `week_completed` → `shopping_opened_after_week_completed`
- `shopping_opened_after_week_completed` → `shopping_shared` or `shopping_main_list_completed`
- week 1 activity → `retro_completed`
- week 1 `week_completed` → week 2 `week_completed`

Interpretation:

- Missing `first_week_generated`: onboarding-to-week transition is unclear or the household does not want generation first.
- Missing `week_completed`: editing/swap/skip flow is not enough to make a usable week.
- Missing shopping events: the week plan may be useful, but the shopping handoff is not yet a habit.
- Missing `retro_completed`: reflection timing/copy is likely too weak, too late, or not valuable.
- Week 2 drop-off: Veckly did not create enough memory/trust after the first week.

## Success Bar For First 5 Families

Do not overfit small numbers. Use this as a decision filter:

- At least 4 of 5 complete onboarding.
- At least 3 of 5 generate a first week.
- At least 3 of 5 complete a week plan.
- At least 2 of 5 use shopping share or complete the main shopping list.
- At least 2 of 5 return in week 2.
- At least 1 household mentions unprompted that Veckly remembered or adapted to them.

If fewer than 3 households complete the first week plan, do not start Phase 8 advanced intelligence. Fix the basic planning loop first.

## Interview Questions

Ask after week 2:

- What did Veckly help you avoid doing manually?
- Where did you stop trusting the app?
- Which part felt most like your real household routine?
- Which part felt like extra admin?
- Did anyone else in the household benefit?
- What would make you open it next Sunday without a reminder?
- If this disappeared tomorrow, what would you go back to?

## Output After First 5 Families

Fill in `docs/plans/beta-first-five-review-template-2026-07.md` with:

- Funnel table from Supabase.
- 5 strongest quotes.
- Top 3 blockers.
- Top 3 retention signals.
- Decision: fix core loop, improve feedback/shopping, or proceed to Phase 8.
