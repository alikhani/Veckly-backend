# Beta Product Events Plan — 2026-07

## Status

In progress — Supabase-backed event log, iOS event wiring, 2-week beta script, and first-five review template ready 2026-07-14.

## Goal

Measure whether beta households complete the first real Veckly planning loop without turning the app into an analytics project.

The first version intentionally logs only high-signal lifecycle events. Results are read in Supabase SQL/dashboard, not exposed through a client read API.

## Event Table

Table: `product_events`

Each row has:

- `household_id`
- `user_id`
- `event_name`
- optional `week_start_date`
- `properties` JSONB
- `occurred_at`

RLS allows active household members to insert/select rows for their household only. The public API currently only writes events.

## V1 Events

- `onboarding_completed`
- `first_week_generated`
- `week_completed`
- `shopping_opened_after_week_completed`
- `shopping_shared`
- `partner_invite_clicked`
- `shopping_main_list_completed`
- `retro_completed`

## Write API

`POST /households/{householdId}/product-events`

```json
{
  "eventName": "week_completed",
  "weekStartDate": "2026-07-13",
  "properties": {
    "plannedDinners": 5
  }
}
```

## Supabase Queries

Event volume by moment:

```sql
select
  event_name,
  count(*) as events,
  count(distinct household_id) as households
from product_events
where occurred_at >= now() - interval '30 days'
group by event_name
order by event_name;
```

First-week funnel:

```sql
select
  household_id,
  min(occurred_at) filter (where event_name = 'onboarding_completed') as onboarded_at,
  min(occurred_at) filter (where event_name = 'first_week_generated') as first_week_generated_at,
  min(occurred_at) filter (where event_name = 'week_completed') as week_completed_at,
  min(occurred_at) filter (where event_name = 'shopping_opened_after_week_completed') as shopping_opened_at,
  min(occurred_at) filter (where event_name = 'shopping_shared') as shopping_shared_at,
  min(occurred_at) filter (where event_name = 'partner_invite_clicked') as partner_invite_clicked_at,
  min(occurred_at) filter (where event_name = 'shopping_main_list_completed') as shopping_done_at,
  min(occurred_at) filter (where event_name = 'retro_completed') as retro_completed_at
from product_events
group by household_id
order by onboarded_at desc nulls last;
```

## Beta Script

Use `docs/plans/beta-research-script-2026-07.md` for the first 5-10 TestFlight households. The script maps household tasks directly to the v1 events above so qualitative notes can be compared with Supabase funnel data.

## First-Five Review

Use `docs/plans/beta-first-five-review-template-2026-07.md` after the first five households complete or drop from the two-week test. The template forces one decision before Phase 8: fix the core loop, improve shopping/feedback handoff, or proceed to advanced intelligence.

## Next Step

Run the first five household beta and fill in the review template before starting Phase 8.
