-- Custom SQL migration file, put your code below! --

-- 0022 wrote the prep_batches/prep_batch_assignments policies as raw
-- `EXISTS (select 1 from household_memberships where household_id = ... and
-- user_id = auth.uid() and status = 'active')`. That happens to be safe for
-- THESE particular checks (the row being checked is always the caller's own
-- membership row, which "memberships_select_own" — `user_id = auth.uid()` —
-- already lets them see regardless of which household it's scoped to), but
-- it's the same raw-EXISTS-against-household_memberships shape that bit us in
-- 0024 for a check that genuinely needed to see ANOTHER member's row. Relying
-- on every future caller to re-derive "is this particular shape safe?" is a
-- footgun: tighten "memberships_select_own" in any future migration (e.g. to
-- stop showing a removed member their own stale row) and these policies could
-- silently start failing closed, or — if changed the other way — open.
-- `caller_is_active_member()` (security definer, from 0024) sidesteps the
-- question entirely by running outside RLS, so it can't regress with it.
-- Belt-and-suspenders, not a fix for a live exploit.

drop policy "members can read their household prep batches" on "household_prep_batches";
--> statement-breakpoint
create policy "members can read their household prep batches"
  on "household_prep_batches"
  for select
  using (caller_is_active_member("household_id"));
--> statement-breakpoint
drop policy "members can insert into their household prep batches" on "household_prep_batches";
--> statement-breakpoint
create policy "members can insert into their household prep batches"
  on "household_prep_batches"
  for insert
  with check (caller_is_active_member("household_id"));
--> statement-breakpoint
drop policy "members can delete their household prep batches" on "household_prep_batches";
--> statement-breakpoint
create policy "members can delete their household prep batches"
  on "household_prep_batches"
  for delete
  using (caller_is_active_member("household_id"));
--> statement-breakpoint
drop policy "members can read prep batch assignments" on "household_prep_batch_assignments";
--> statement-breakpoint
create policy "members can read prep batch assignments"
  on "household_prep_batch_assignments"
  for select
  using (
    exists (
      select 1 from "household_prep_batches" pb
      where pb."id" = "household_prep_batch_assignments"."batch_id"
        and caller_is_active_member(pb."household_id")
    )
  );
--> statement-breakpoint
drop policy "members can insert prep batch assignments" on "household_prep_batch_assignments";
--> statement-breakpoint
create policy "members can insert prep batch assignments"
  on "household_prep_batch_assignments"
  for insert
  with check (
    exists (
      select 1 from "household_prep_batches" pb
      where pb."id" = "household_prep_batch_assignments"."batch_id"
        and caller_is_active_member(pb."household_id")
    )
  );
--> statement-breakpoint
drop policy "members can delete prep batch assignments" on "household_prep_batch_assignments";
--> statement-breakpoint
create policy "members can delete prep batch assignments"
  on "household_prep_batch_assignments"
  for delete
  using (
    exists (
      select 1 from "household_prep_batches" pb
      where pb."id" = "household_prep_batch_assignments"."batch_id"
        and caller_is_active_member(pb."household_id")
    )
  );
