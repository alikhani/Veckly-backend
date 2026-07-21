-- Custom SQL migration file, put your code below! --

-- `deleteHousehold` (src/households.ts) was added without a matching RLS
-- policy — RLS defaults to deny for any command with no applicable policy, so
-- every DELETE on "households" was silently a no-op (0 rows affected, not an
-- error) regardless of caller. Mirrors "households_update_owner_only"
-- (0011_household_rename_rls.sql): only an active owner membership permits
-- deleting the household.
create policy "households_delete_owner_only"
  on "households"
  for delete
  using (
    exists (
      select 1
      from "household_memberships" m
      where m.household_id = "households".id
        and m.user_id = auth.uid()
        and m.role = 'owner'
        and m.status = 'active'
    )
  );
