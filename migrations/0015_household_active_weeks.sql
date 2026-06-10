CREATE TABLE "household_active_weeks" (
	"household_id" uuid PRIMARY KEY NOT NULL,
	"week_start_date" date NOT NULL,
	"timezone" text NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "household_active_weeks" ADD CONSTRAINT "household_active_weeks_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "household_active_weeks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "household_active_weeks_select_via_active_membership"
  ON "household_active_weeks"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "household_memberships" m
      WHERE m.household_id = "household_active_weeks".household_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY "household_active_weeks_insert_via_active_membership"
  ON "household_active_weeks"
  FOR INSERT
  WITH CHECK (
    updated_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM "household_memberships" m
      WHERE m.household_id = "household_active_weeks".household_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY "household_active_weeks_update_via_active_membership"
  ON "household_active_weeks"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "household_memberships" m
      WHERE m.household_id = "household_active_weeks".household_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  )
  WITH CHECK (
    updated_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM "household_memberships" m
      WHERE m.household_id = "household_active_weeks".household_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY "household_active_weeks_delete_via_active_membership"
  ON "household_active_weeks"
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM "household_memberships" m
      WHERE m.household_id = "household_active_weeks".household_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );
