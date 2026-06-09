-- Custom SQL migration file, put your code below! --

-- Owners may change another member's role. The `using` clause requires the
-- caller to hold an active owner membership in the same household. The
-- `with check` constrains the outcome to an active membership with a valid
-- role — preventing this policy from being used to deactivate or remove a
-- member (that's memberships_update_status_removed_via_owner's job, 0012).
--
-- LAST_OWNER protection (blocking demotion of the sole owner) is enforced by
-- the domain layer before this UPDATE is issued, for the same reasons stated
-- in 0012: the RLS subquery would be expensive and fragile under concurrent
-- writes.
create policy "memberships_update_role_via_owner"
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
    status = 'active'
  );