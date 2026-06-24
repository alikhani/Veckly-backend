-- Custom SQL migration file, put your code below! --

create table "user_profiles" (
  "user_id" uuid primary key,
  "display_name" text not null,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);

alter table "user_profiles" enable row level security;

-- Same `security definer` rationale as `caller_is_active_member` (0024): a
-- plain RLS subquery against "household_memberships" from inside this check
-- would only ever see the CALLER's own rows (per "memberships_select_own"),
-- making "do these two users share a household" unanswerable from inside a
-- normal RLS-scoped query. `security definer` runs as the table owner,
-- exempt from RLS, which is exactly the cross-row visibility this check
-- needs.
create function shares_active_household(p_user_id uuid) returns boolean
  language sql security definer stable
  as $$
    select exists (
      select 1
      from "household_memberships" mine
      join "household_memberships" theirs
        on theirs.household_id = mine.household_id
      where mine.user_id = auth.uid()
        and mine.status = 'active'
        and theirs.user_id = p_user_id
        and theirs.status = 'active'
    )
  $$;

-- A user can always see their own display name, and can see anyone else's
-- only while currently sharing an active household with them.
create policy "user_profiles_select_self_or_peers"
  on "user_profiles" for select
  using (user_id = auth.uid() or shares_active_household(user_id));

create policy "user_profiles_insert_own"
  on "user_profiles" for insert
  with check (user_id = auth.uid());

create policy "user_profiles_update_own"
  on "user_profiles" for update
  using (user_id = auth.uid());
