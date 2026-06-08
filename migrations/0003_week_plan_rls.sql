-- Custom SQL migration file, put your code below! --

-- Same membership-as-database-invariant pattern as 0001_household_rls.sql,
-- extended to the week-plan event log and its projection. New territory here:
-- these policies gate WRITES (insert/update), not just reads — the append/fold
-- path runs as the authenticated user via withRls, with no service-role bypass,
-- so the database is the only thing standing between a forged request and a
-- cross-household write.

alter table "week_plan_events" enable row level security;
alter table "week_plan_projections" enable row level security;

-- A user can read a household's event log only while holding an active
-- membership in that household — mirrors "households_select_via_active_membership".
create policy "week_plan_events_select_via_active_membership"
  on "week_plan_events"
  for select
  using (
    exists (
      select 1
      from "household_memberships" m
      where m.household_id = "week_plan_events".household_id
        and m.user_id = auth.uid()
        and m.status = 'active'
    )
  );

-- A user can append an event only to a household they actively belong to.
-- `with check` (not `using`) is what's evaluated against the *new* row on
-- insert — this is the clause that stops "insert an event into household B
-- while authenticated as a member of household A only".
create policy "week_plan_events_insert_via_active_membership"
  on "week_plan_events"
  for insert
  with check (
    exists (
      select 1
      from "household_memberships" m
      where m.household_id = "week_plan_events".household_id
        and m.user_id = auth.uid()
        and m.status = 'active'
    )
  );

create policy "week_plan_projections_select_via_active_membership"
  on "week_plan_projections"
  for select
  using (
    exists (
      select 1
      from "household_memberships" m
      where m.household_id = "week_plan_projections".household_id
        and m.user_id = auth.uid()
        and m.status = 'active'
    )
  );

create policy "week_plan_projections_insert_via_active_membership"
  on "week_plan_projections"
  for insert
  with check (
    exists (
      select 1
      from "household_memberships" m
      where m.household_id = "week_plan_projections".household_id
        and m.user_id = auth.uid()
        and m.status = 'active'
    )
  );

-- The fold step upserts the projection (`onConflictDoUpdate`) — `for update`
-- needs both `using` (which existing rows may be touched) and `with check`
-- (what the row may become afterwards). Both clauses are the same membership
-- check: a user may only update a projection row that belongs to — and, after
-- the update, still belongs to — a household they actively belong to.
create policy "week_plan_projections_update_via_active_membership"
  on "week_plan_projections"
  for update
  using (
    exists (
      select 1
      from "household_memberships" m
      where m.household_id = "week_plan_projections".household_id
        and m.user_id = auth.uid()
        and m.status = 'active'
    )
  )
  with check (
    exists (
      select 1
      from "household_memberships" m
      where m.household_id = "week_plan_projections".household_id
        and m.user_id = auth.uid()
        and m.status = 'active'
    )
  );
