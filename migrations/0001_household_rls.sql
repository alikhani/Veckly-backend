-- Custom SQL migration file, put your code below! --

-- RLS is the actual security boundary for household-scoped data (see
-- docs/architecture/foundational-design-2026-06.md §3): a forgotten route-layer
-- check must not be able to leak rows across households. The database itself
-- enforces it, so every query — including ones we forget to scope — is safe.

alter table "household_memberships" enable row level security;
alter table "households" enable row level security;

-- A user can see their own membership rows, active or not — but never another
-- user's. This is the base invariant everything else is built on.
create policy "memberships_select_own"
  on "household_memberships"
  for select
  using (user_id = auth.uid());

-- A user can see a household only if they hold an active membership in it.
-- Without this, "household_memberships" alone would scope row visibility but
-- joining out to "households" would silently return every household, because
-- RLS is evaluated per-table, not per-query-result.
create policy "households_select_via_active_membership"
  on "households"
  for select
  using (
    exists (
      select 1
      from "household_memberships" m
      where m.household_id = "households".id
        and m.user_id = auth.uid()
        and m.status = 'active'
    )
  );
