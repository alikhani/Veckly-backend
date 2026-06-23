-- Custom SQL migration file, put your code below! --

-- 0001 deliberately scoped "household_memberships" SELECT to
-- `user_id = auth.uid()` ("active or not — but never another user's"). That
-- was correct for the household-takeover threat it was written against, but
-- it has a consequence the comment didn't anticipate: it also blocks a member
-- from ever seeing their OWN household's OTHER members. `listHouseholdMembers`
-- queries `where household_id = :householdId` under the caller's RLS context
-- — but RLS intersects with the policy's USING clause before that WHERE
-- clause is even evaluated, so every other member's row is silently dropped
-- regardless of the query. The owner sees only themself, forever, no matter
-- how long they wait or how many times they refresh — this is not a caching
-- issue, it's the database returning a 1-row result set by design.

-- Same `security definer` rationale as `household_has_active_member` (0004):
-- a plain subquery against "household_memberships" from inside a new policy
-- would itself be filtered by the existing "memberships_select_own" policy
-- before it could check "is the caller a member of THIS household" — it could
-- only ever see the caller's own row, making the check trivially true/false
-- regardless of the actual household in question. `security definer` runs as
-- the table owner, exempt from RLS, which is exactly the visibility this
-- check needs.
create function caller_is_active_member(p_household_id uuid) returns boolean
  language sql security definer stable
  as $$
    select exists (
      select 1 from "household_memberships"
      where household_id = p_household_id
        and user_id = auth.uid()
        and status = 'active'
    )
  $$;

-- Additive — Postgres OR's multiple SELECT policies together, so this never
-- narrows what "memberships_select_own" already allowed (your own row, even
-- if removed, stays visible). It only adds: any row in a household where YOU
-- currently hold an active membership. Lose that membership (removed/left)
-- and this policy stops applying — you keep seeing your own (now-removed)
-- row via the original policy, but not your former housemates'.
create policy "memberships_select_household_peers"
  on "household_memberships"
  for select
  using (caller_is_active_member(household_id));
