CREATE TYPE "public"."meal_outcome_status" AS ENUM('cooked', 'changed_plan', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."meal_portion_outcome" AS ENUM('too_little', 'right_amount', 'too_much');--> statement-breakpoint
CREATE TYPE "public"."meal_outcome_reason" AS ENUM(
  'easy_weeknight',
  'family_approved',
  'good_leftovers',
  'too_much_effort',
  'family_pushback',
  'poor_leftovers'
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "household_meal_outcomes" (
  "household_id" uuid NOT NULL,
  "week_start_date" date NOT NULL,
  "date" date NOT NULL,
  "planned_recipe_id" uuid NOT NULL,
  "status" "meal_outcome_status" NOT NULL,
  "portion_outcome" "meal_portion_outcome",
  "reason" "meal_outcome_reason",
  "actual_recipe_id" uuid,
  "actual_meal_label" text,
  "updated_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "household_meal_outcomes_pk" PRIMARY KEY("household_id", "week_start_date", "date"),
  CONSTRAINT "household_meal_outcomes_date_in_week_check"
    CHECK ("date" >= "week_start_date" AND "date" <= "week_start_date" + 6),
  CONSTRAINT "household_meal_outcomes_actual_meal_check"
    CHECK (
      "status" = 'changed_plan'
      OR ("actual_recipe_id" IS NULL AND "actual_meal_label" IS NULL)
    ),
  CONSTRAINT "household_meal_outcomes_skipped_portion_check"
    CHECK ("status" <> 'skipped' OR "portion_outcome" IS NULL),
  CONSTRAINT "household_meal_outcomes_actual_meal_label_check"
    CHECK (
      "actual_meal_label" IS NULL
      OR (char_length(btrim("actual_meal_label")) BETWEEN 1 AND 120)
    )
);--> statement-breakpoint
ALTER TABLE "household_meal_outcomes"
  ADD CONSTRAINT "household_meal_outcomes_household_id_households_id_fk"
  FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "household_meal_outcomes_household_week_idx"
  ON "household_meal_outcomes" USING btree ("household_id", "week_start_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "household_meal_outcomes_planned_recipe_idx"
  ON "household_meal_outcomes" USING btree ("planned_recipe_id");--> statement-breakpoint
ALTER TABLE "household_meal_outcomes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "household_meal_outcomes_select_via_active_membership"
  ON "household_meal_outcomes"
  FOR SELECT
  USING (caller_is_active_member("household_id"));--> statement-breakpoint
CREATE POLICY "household_meal_outcomes_insert_via_active_membership"
  ON "household_meal_outcomes"
  FOR INSERT
  WITH CHECK (
    "updated_by" = auth.uid()
    AND caller_is_active_member("household_id")
  );--> statement-breakpoint
CREATE POLICY "household_meal_outcomes_update_via_active_membership"
  ON "household_meal_outcomes"
  FOR UPDATE
  USING (caller_is_active_member("household_id"))
  WITH CHECK (
    "updated_by" = auth.uid()
    AND caller_is_active_member("household_id")
  );
