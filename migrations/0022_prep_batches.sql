create table "household_prep_batches" (
  "id" uuid primary key default gen_random_uuid(),
  "household_id" uuid not null references "households"("id") on delete cascade,
  "recipe_id" uuid references "recipes"("id") on delete set null,
  "custom_recipe_id" uuid,
  "cook_date" date not null,
  "total_portions" integer not null,
  "created_by" uuid not null,
  "created_at" timestamptz not null default now()
);
--> statement-breakpoint
create table "household_prep_batch_assignments" (
  "id" uuid primary key default gen_random_uuid(),
  "batch_id" uuid not null references "household_prep_batches"("id") on delete cascade,
  "date" date not null,
  "meal_type" text not null
);
--> statement-breakpoint
alter table "household_prep_batches" enable row level security;
--> statement-breakpoint
alter table "household_prep_batch_assignments" enable row level security;
--> statement-breakpoint
create policy "members can read their household prep batches"
  on "household_prep_batches"
  for select
  using (
    exists (
      select 1 from "household_memberships"
      where "household_memberships"."household_id" = "household_prep_batches"."household_id"
        and "household_memberships"."user_id" = auth.uid()
        and "household_memberships"."status" = 'active'
    )
  );
--> statement-breakpoint
create policy "members can insert into their household prep batches"
  on "household_prep_batches"
  for insert
  with check (
    exists (
      select 1 from "household_memberships"
      where "household_memberships"."household_id" = "household_prep_batches"."household_id"
        and "household_memberships"."user_id" = auth.uid()
        and "household_memberships"."status" = 'active'
    )
  );
--> statement-breakpoint
create policy "members can delete their household prep batches"
  on "household_prep_batches"
  for delete
  using (
    exists (
      select 1 from "household_memberships"
      where "household_memberships"."household_id" = "household_prep_batches"."household_id"
        and "household_memberships"."user_id" = auth.uid()
        and "household_memberships"."status" = 'active'
    )
  );
--> statement-breakpoint
create policy "members can read prep batch assignments"
  on "household_prep_batch_assignments"
  for select
  using (
    exists (
      select 1 from "household_prep_batches" pb
      join "household_memberships" m on m."household_id" = pb."household_id"
      where pb."id" = "household_prep_batch_assignments"."batch_id"
        and m."user_id" = auth.uid()
        and m."status" = 'active'
    )
  );
--> statement-breakpoint
create policy "members can insert prep batch assignments"
  on "household_prep_batch_assignments"
  for insert
  with check (
    exists (
      select 1 from "household_prep_batches" pb
      join "household_memberships" m on m."household_id" = pb."household_id"
      where pb."id" = "household_prep_batch_assignments"."batch_id"
        and m."user_id" = auth.uid()
        and m."status" = 'active'
    )
  );
--> statement-breakpoint
create policy "members can delete prep batch assignments"
  on "household_prep_batch_assignments"
  for delete
  using (
    exists (
      select 1 from "household_prep_batches" pb
      join "household_memberships" m on m."household_id" = pb."household_id"
      where pb."id" = "household_prep_batch_assignments"."batch_id"
        and m."user_id" = auth.uid()
        and m."status" = 'active'
    )
  );
