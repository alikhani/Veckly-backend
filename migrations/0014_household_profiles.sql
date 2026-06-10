CREATE TABLE "household_profiles" (
	"household_id" uuid PRIMARY KEY NOT NULL,
	"adults" integer NOT NULL,
	"children" integer NOT NULL,
	"priorities" jsonb NOT NULL,
	"avoid_ingredients" jsonb NOT NULL,
	"selected_days" jsonb NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "household_profiles" ADD CONSTRAINT "household_profiles_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "household_profiles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "household_profiles_select_via_active_membership"
  ON "household_profiles"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "household_memberships" m
      WHERE m.household_id = "household_profiles".household_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY "household_profiles_insert_via_active_membership"
  ON "household_profiles"
  FOR INSERT
  WITH CHECK (
    updated_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM "household_memberships" m
      WHERE m.household_id = "household_profiles".household_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY "household_profiles_update_via_active_membership"
  ON "household_profiles"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "household_memberships" m
      WHERE m.household_id = "household_profiles".household_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  )
  WITH CHECK (
    updated_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM "household_memberships" m
      WHERE m.household_id = "household_profiles".household_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );
