-- Custom SQL migration file, put your code below! --

-- Every other write policy so far (0003) gates on "does an active membership
-- already exist for this household". That gate is structurally unusable here:
-- a brand-new user has NO membership yet — that's exactly the case these
-- policies must allow. This is the chicken-and-egg case the rest of the
-- system is built to assume away.

-- Any authenticated user may create a household row. This looks permissive in
-- isolation, but a bare household with no membership is inert:
-- "households_select_via_active_membership" (0001) makes it permanently
-- invisible — including to its creator — until a membership exists, and the
-- membership policy below only allows joining BRAND NEW households as owner.
create policy "households_insert_any_authenticated"
  on "households"
  for insert
  with check (true);

-- Checks "does this household already have an active member" WITHOUT going
-- through RLS. This is not a stylistic choice — it's load-bearing, and the
-- reason is worth spelling out because the obvious declarative alternative
-- looks correct and isn't:
--
--   ... and not exists (
--     select 1 from "household_memberships" existing
--     where existing.household_id = "household_memberships".household_id
--       and existing.status = 'active'
--   )
--
-- That subquery is itself a SELECT against "household_memberships" — which
-- carries "memberships_select_own" (`using (user_id = auth.uid())`, from
-- 0001). So as the attacker, the subquery can only ever see the ATTACKER's
-- OWN rows; it can never see the victim's existing membership. `not exists`
-- is therefore always true for a non-member, and the very takeover this
-- clause exists to stop sails through. (Caught live: a `not exists` policy
-- shaped exactly like this passed every other check and still let user B
-- insert themself as owner of user A's household — `EXPLAIN ANALYZE` showed
-- `Rows Removed by Filter: 1`, the filter silently dropping A's row before
-- `not exists` ever got to evaluate it.)
--
-- `security definer` runs this function as its OWNER (the migration role,
-- which owns these tables and — absent `FORCE ROW LEVEL SECURITY`, which
-- isn't set — is exempt from RLS by default), so it sees every membership
-- row regardless of who's asking. That's exactly the visibility a security
-- check needs and a normal authenticated query structurally cannot have.
create function household_has_active_member(p_household_id uuid) returns boolean
  language sql security definer stable
  as $$
    select exists (
      select 1 from "household_memberships"
      where household_id = p_household_id and status = 'active'
    )
  $$;

-- A user may insert a membership for themself, as owner, ONLY when the target
-- household has no active members yet. All three clauses are load-bearing:
--
--   - user_id = auth.uid()              — blocks inserting a membership for
--                                          someone else
--   - role = 'owner'                    — blocks self-granting any other role
--                                          via this path
--   - not household_has_active_member() — blocks CROSS-HOUSEHOLD TAKEOVER:
--     without it, a user could insert {householdId: <someone else's existing
--     household>, userId: themself, role: 'owner'} — the first two clauses
--     alone would pass (they're inserting for themself, as owner), and they'd
--     walk away owning someone else's household. With it, that target
--     household already has an active owner, so the check is false and the
--     insert is rejected. The genuine bootstrap case — a brand new household
--     with zero active members — is the only shape that satisfies all three
--     clauses at once.
create policy "memberships_insert_self_as_owner_for_new_household"
  on "household_memberships"
  for insert
  with check (
    user_id = auth.uid()
    and role = 'owner'
    and not household_has_active_member(household_id)
  );
