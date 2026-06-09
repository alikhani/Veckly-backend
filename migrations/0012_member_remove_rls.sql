-- Custom SQL migration file, put your code below! --

-- Owners may set a member's status to 'removed'. The `using` clause restricts
-- which rows can be targeted: only memberships in a household where auth.uid()
-- holds an active owner membership. The `with check` locks the update to the
-- single legal outcome of this path — status = 'removed' — preventing a
-- misconfigured caller from using this policy to change roles or re-activate
-- removed memberships.
--
-- LAST_OWNER protection (preventing removal of the final owner) is enforced by
-- the domain layer before this UPDATE is issued, not here — RLS would need a
-- subquery that counts owners and compares to 1, which is both expensive and
-- fragile under concurrent writes. The domain check is the right layer for
-- this invariant; this policy's job is purely "is the caller authorized to
-- remove any member at all", not "is this particular removal safe".
create policy "memberships_update_status_removed_via_owner"
  on "household_memberships"
  for update
  using (
    exists (
      select 1
      from "household_memberships" owner_m
      where owner_m.household_id = "household_memberships".household_id
        and owner_m.user_id = auth.uid()
        and owner_m.role = 'owner'
        and owner_m.status = 'active'
    )
  )
  with check (
    status = 'removed'
  );