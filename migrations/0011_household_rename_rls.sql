-- Custom SQL migration file, put your code below! --

-- Owners may update (rename) a household they own. The `using` clause ensures
-- the row is visible to the caller before the update proceeds — i.e. the caller
-- holds an active owner membership in the target household. The `with check`
-- enforces the same constraint on the post-update row, preventing an owner from
-- changing `household_id` to a household they don't own. In practice `id` is a
-- primary key and cannot change, so `with check` is belt-and-suspenders here,
-- but naming the attack it forecloses makes the intent legible when this file
-- is read in isolation later.
create policy "households_update_owner_only"
  on "households"
  for update
  using (
    exists (
      select 1
      from "household_memberships" m
      where m.household_id = "households".id
        and m.user_id = auth.uid()
        and m.role = 'owner'
        and m.status = 'active'
    )
  )
  with check (
    exists (
      select 1
      from "household_memberships" m
      where m.household_id = "households".id
        and m.user_id = auth.uid()
        and m.role = 'owner'
        and m.status = 'active'
    )
  );