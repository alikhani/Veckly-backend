CREATE TABLE IF NOT EXISTS "household_recipe_recommendations" (
	"household_id" uuid NOT NULL,
	"language" text NOT NULL,
	"recommendations" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "household_recipe_recommendations_pk" PRIMARY KEY("household_id","language")
);
--> statement-breakpoint
ALTER TABLE "household_recipe_recommendations" ADD CONSTRAINT "household_recipe_recommendations_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_recipe_recommendations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "household_recipe_recommendations_select_via_active_membership"
  ON "household_recipe_recommendations"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM "household_memberships" m
      WHERE m.household_id = "household_recipe_recommendations".household_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );--> statement-breakpoint
CREATE POLICY "household_recipe_recommendations_insert_via_active_membership"
  ON "household_recipe_recommendations"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM "household_memberships" m
      WHERE m.household_id = "household_recipe_recommendations".household_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );--> statement-breakpoint
CREATE POLICY "household_recipe_recommendations_update_via_active_membership"
  ON "household_recipe_recommendations"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM "household_memberships" m
      WHERE m.household_id = "household_recipe_recommendations".household_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM "household_memberships" m
      WHERE m.household_id = "household_recipe_recommendations".household_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );--> statement-breakpoint
CREATE POLICY "household_recipe_recommendations_delete_via_active_membership"
  ON "household_recipe_recommendations"
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1
      FROM "household_memberships" m
      WHERE m.household_id = "household_recipe_recommendations".household_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );
