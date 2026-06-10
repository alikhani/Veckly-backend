CREATE TYPE "public"."household_week_plan_status" AS ENUM('draft', 'finalized', 'archived');--> statement-breakpoint
CREATE TYPE "public"."household_week_plan_source" AS ENUM('generated', 'copied_from_previous', 'template_applied', 'manual');--> statement-breakpoint
CREATE TABLE "household_week_plans" (
	"household_id" uuid NOT NULL,
	"week_start_date" date NOT NULL,
	"week_number" integer NOT NULL,
	"week_year" integer NOT NULL,
	"timezone" text NOT NULL,
	"state" jsonb NOT NULL,
	"status" "household_week_plan_status" NOT NULL,
	"source" "household_week_plan_source" NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "household_week_plans" ADD CONSTRAINT "household_week_plans_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "household_week_plans_household_week_idx" ON "household_week_plans" USING btree ("household_id","week_start_date");--> statement-breakpoint
CREATE INDEX "household_week_plans_household_week_number_idx" ON "household_week_plans" USING btree ("household_id","week_year","week_number");--> statement-breakpoint
CREATE INDEX "household_week_plans_updated_idx" ON "household_week_plans" USING btree ("updated_at");--> statement-breakpoint
ALTER TABLE "household_week_plans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "household_week_plans_select_via_active_membership"
  ON "household_week_plans"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "household_memberships" m
      WHERE m.household_id = "household_week_plans".household_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );--> statement-breakpoint
CREATE POLICY "household_week_plans_insert_via_active_membership"
  ON "household_week_plans"
  FOR INSERT
  WITH CHECK (
    updated_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM "household_memberships" m
      WHERE m.household_id = "household_week_plans".household_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );--> statement-breakpoint
CREATE POLICY "household_week_plans_update_via_active_membership"
  ON "household_week_plans"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "household_memberships" m
      WHERE m.household_id = "household_week_plans".household_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  )
  WITH CHECK (
    updated_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM "household_memberships" m
      WHERE m.household_id = "household_week_plans".household_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );
