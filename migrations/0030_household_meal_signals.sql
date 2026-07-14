CREATE TYPE "public"."household_meal_signal" AS ENUM('works_for_family', 'not_for_us');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "household_meal_signals" (
	"household_id" uuid NOT NULL,
	"meal_id" text NOT NULL,
	"signal" "household_meal_signal" NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "household_meal_signals_pk" PRIMARY KEY("household_id","meal_id")
);
--> statement-breakpoint
ALTER TABLE "household_meal_signals" ADD CONSTRAINT "household_meal_signals_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "household_meal_signals_household_updated_idx" ON "household_meal_signals" USING btree ("household_id","updated_at");--> statement-breakpoint
ALTER TABLE "household_meal_signals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "household_meal_signals_select_via_active_membership"
  ON "household_meal_signals"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM "household_memberships" m
      WHERE m.household_id = "household_meal_signals".household_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );--> statement-breakpoint
CREATE POLICY "household_meal_signals_insert_via_active_membership"
  ON "household_meal_signals"
  FOR INSERT
  WITH CHECK (
    updated_by = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM "household_memberships" m
      WHERE m.household_id = "household_meal_signals".household_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );--> statement-breakpoint
CREATE POLICY "household_meal_signals_update_via_active_membership"
  ON "household_meal_signals"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM "household_memberships" m
      WHERE m.household_id = "household_meal_signals".household_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  )
  WITH CHECK (
    updated_by = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM "household_memberships" m
      WHERE m.household_id = "household_meal_signals".household_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );--> statement-breakpoint
CREATE POLICY "household_meal_signals_delete_via_active_membership"
  ON "household_meal_signals"
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1
      FROM "household_memberships" m
      WHERE m.household_id = "household_meal_signals".household_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );
