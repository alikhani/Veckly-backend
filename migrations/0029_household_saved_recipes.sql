CREATE TABLE IF NOT EXISTS "household_saved_recipes" (
	"household_id" uuid NOT NULL,
	"recipe_id" uuid NOT NULL,
	"added_by" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "household_saved_recipes_pk" PRIMARY KEY("household_id","recipe_id")
);
--> statement-breakpoint
ALTER TABLE "household_saved_recipes" ADD CONSTRAINT "household_saved_recipes_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_saved_recipes" ADD CONSTRAINT "household_saved_recipes_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "household_saved_recipes_household_added_idx" ON "household_saved_recipes" USING btree ("household_id","added_at");--> statement-breakpoint
ALTER TABLE "household_saved_recipes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "household_saved_recipes_select_via_active_membership"
  ON "household_saved_recipes"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM "household_memberships" m
      WHERE m.household_id = "household_saved_recipes".household_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );--> statement-breakpoint
CREATE POLICY "household_saved_recipes_insert_via_active_membership"
  ON "household_saved_recipes"
  FOR INSERT
  WITH CHECK (
    added_by = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM "household_memberships" m
      WHERE m.household_id = "household_saved_recipes".household_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );--> statement-breakpoint
CREATE POLICY "household_saved_recipes_delete_via_active_membership"
  ON "household_saved_recipes"
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1
      FROM "household_memberships" m
      WHERE m.household_id = "household_saved_recipes".household_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );
