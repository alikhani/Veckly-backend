-- Custom SQL migration file, put your code below! --

alter table "recipes" enable row level security;

-- Household members can see all of their household's recipes (including
-- archived ones — filtering archived is the application's job, not RLS's).
create policy "recipes_select_via_active_membership"
  on "recipes"
  for select
  using (
    exists (
      select 1 from "household_memberships" m
      where m.household_id = "recipes".household_id
        and m.user_id = auth.uid()
        and m.status = 'active'
    )
  );

-- Public recipes are discoverable by any authenticated user, regardless of
-- household — used for AI recommendation candidates and recipe browsing.
-- Deliberately limited to non-archived public recipes only: is_archived is a
-- household-internal concern and should never be visible cross-household.
create policy "recipes_select_public"
  on "recipes"
  for select
  using (is_public = true and is_archived = false);

-- Members may create recipes for their own household, as themselves.
-- `created_by = auth.uid()` prevents inserting a recipe attributed to someone
-- else — the same self-attribution check as `invites_insert_via_active_membership`.
create policy "recipes_insert_via_active_membership"
  on "recipes"
  for insert
  with check (
    created_by = auth.uid()
    and exists (
      select 1 from "household_memberships" m
      where m.household_id = "recipes".household_id
        and m.user_id = auth.uid()
        and m.status = 'active'
    )
  );

-- Members may update (edit or archive) their household's recipes.
-- Both `using` and `with check` use the same active-membership clause: a
-- member can only touch a recipe that already belongs to their household, and
-- the updated row must still belong to that household. This prevents a member
-- from "adopting" a recipe by updating its household_id to theirs.
create policy "recipes_update_via_active_membership"
  on "recipes"
  for update
  using (
    exists (
      select 1 from "household_memberships" m
      where m.household_id = "recipes".household_id
        and m.user_id = auth.uid()
        and m.status = 'active'
    )
  )
  with check (
    exists (
      select 1 from "household_memberships" m
      where m.household_id = "recipes".household_id
        and m.user_id = auth.uid()
        and m.status = 'active'
    )
  );
