ALTER TABLE "household_meal_outcomes"
  ADD COLUMN "intentional_leftovers" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "household_meal_outcomes"
  ADD CONSTRAINT "household_meal_outcomes_intentional_leftovers_check"
  CHECK (NOT "intentional_leftovers" OR "portion_outcome" = 'too_much');--> statement-breakpoint
CREATE TABLE "household_portion_memories" (
  "household_id" uuid NOT NULL REFERENCES "households"("id") ON DELETE CASCADE,
  "recipe_id" uuid NOT NULL,
  "ignored_through" timestamptz NOT NULL,
  "updated_by" uuid NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "household_portion_memories_pk" PRIMARY KEY("household_id", "recipe_id")
);--> statement-breakpoint
ALTER TABLE "household_portion_memories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "members can read household portion memories"
  ON "household_portion_memories" FOR SELECT TO authenticated
  USING (caller_is_active_member(household_id));--> statement-breakpoint
CREATE POLICY "members can insert household portion memories"
  ON "household_portion_memories" FOR INSERT TO authenticated
  WITH CHECK (updated_by = auth.uid() AND caller_is_active_member(household_id));--> statement-breakpoint
CREATE POLICY "members can update household portion memories"
  ON "household_portion_memories" FOR UPDATE TO authenticated
  USING (caller_is_active_member(household_id))
  WITH CHECK (updated_by = auth.uid() AND caller_is_active_member(household_id));--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "household_portion_memories" TO authenticated;
