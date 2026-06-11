CREATE TYPE "public"."meal_feedback_vote" AS ENUM('up', 'down');--> statement-breakpoint
CREATE TYPE "public"."meal_feedback_signal" AS ENUM('easy-weeknight', 'family-approved', 'good-leftovers', 'too-much-effort', 'family-pushback', 'poor-leftovers');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "meal_feedback" (
	"household_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"meal_id" text NOT NULL,
	"vote" "meal_feedback_vote" NOT NULL,
	"signal" "meal_feedback_signal",
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meal_feedback_pk" PRIMARY KEY("household_id","user_id","meal_id")
);
--> statement-breakpoint
ALTER TABLE "meal_feedback" ADD CONSTRAINT "meal_feedback_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "meal_feedback_household_updated_idx" ON "meal_feedback" USING btree ("household_id","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "meal_feedback_user_updated_idx" ON "meal_feedback" USING btree ("user_id","updated_at");--> statement-breakpoint
ALTER TABLE "meal_feedback" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "meal_feedback_select_own_via_active_membership"
  ON "meal_feedback"
  FOR SELECT
  USING (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM "household_memberships" m
      WHERE m.household_id = "meal_feedback".household_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );--> statement-breakpoint
CREATE POLICY "meal_feedback_insert_own_via_active_membership"
  ON "meal_feedback"
  FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM "household_memberships" m
      WHERE m.household_id = "meal_feedback".household_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );--> statement-breakpoint
CREATE POLICY "meal_feedback_update_own_via_active_membership"
  ON "meal_feedback"
  FOR UPDATE
  USING (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM "household_memberships" m
      WHERE m.household_id = "meal_feedback".household_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  )
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM "household_memberships" m
      WHERE m.household_id = "meal_feedback".household_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );--> statement-breakpoint
CREATE POLICY "meal_feedback_delete_own_via_active_membership"
  ON "meal_feedback"
  FOR DELETE
  USING (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM "household_memberships" m
      WHERE m.household_id = "meal_feedback".household_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );
