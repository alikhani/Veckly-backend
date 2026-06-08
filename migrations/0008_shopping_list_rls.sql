-- Custom SQL migration file, put your code below! --

-- Identical shape to 0003_week_plan_rls.sql, applied to the second named event
-- stream the architecture doc calls for ("shopping-list:<date>", §3.2). Same
-- membership-as-database-invariant pattern, same five policies, same reasoning
-- for each clause — the duplication here is the point: it's what proves the
-- pattern generalizes rather than being a one-off shape that happened to fit
-- week plans. (See src/event-stream.ts for where the *mechanism* — not the
-- RLS shape, which stays per-table by Postgres's design — gets extracted once
-- this second instance reveals what's actually shared.)

alter table "shopping_list_events" enable row level security;
alter table "shopping_list_projections" enable row level security;

create policy "shopping_list_events_select_via_active_membership"
  on "shopping_list_events"
  for select
  using (
    exists (
      select 1
      from "household_memberships" m
      where m.household_id = "shopping_list_events".household_id
        and m.user_id = auth.uid()
        and m.status = 'active'
    )
  );

create policy "shopping_list_events_insert_via_active_membership"
  on "shopping_list_events"
  for insert
  with check (
    exists (
      select 1
      from "household_memberships" m
      where m.household_id = "shopping_list_events".household_id
        and m.user_id = auth.uid()
        and m.status = 'active'
    )
  );

create policy "shopping_list_projections_select_via_active_membership"
  on "shopping_list_projections"
  for select
  using (
    exists (
      select 1
      from "household_memberships" m
      where m.household_id = "shopping_list_projections".household_id
        and m.user_id = auth.uid()
        and m.status = 'active'
    )
  );

create policy "shopping_list_projections_insert_via_active_membership"
  on "shopping_list_projections"
  for insert
  with check (
    exists (
      select 1
      from "household_memberships" m
      where m.household_id = "shopping_list_projections".household_id
        and m.user_id = auth.uid()
        and m.status = 'active'
    )
  );

create policy "shopping_list_projections_update_via_active_membership"
  on "shopping_list_projections"
  for update
  using (
    exists (
      select 1
      from "household_memberships" m
      where m.household_id = "shopping_list_projections".household_id
        and m.user_id = auth.uid()
        and m.status = 'active'
    )
  )
  with check (
    exists (
      select 1
      from "household_memberships" m
      where m.household_id = "shopping_list_projections".household_id
        and m.user_id = auth.uid()
        and m.status = 'active'
    )
  );
