CREATE TABLE "household_week_pulses" (
  "household_id" uuid NOT NULL REFERENCES "households"("id") ON DELETE CASCADE,
  "week_start_date" date NOT NULL,
  "user_id" uuid NOT NULL,
  "away_dates" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "wished_meal" text,
  "simple_date" date,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "household_week_pulses_pk" PRIMARY KEY("household_id", "week_start_date", "user_id")
);--> statement-breakpoint
CREATE INDEX "household_week_pulses_household_week_idx"
  ON "household_week_pulses" ("household_id", "week_start_date");--> statement-breakpoint
ALTER TABLE "household_week_pulses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "members can read household week pulses"
  ON "household_week_pulses" FOR SELECT TO authenticated
  USING (caller_is_active_member(household_id));--> statement-breakpoint
CREATE POLICY "members can insert their own week pulse"
  ON "household_week_pulses" FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND caller_is_active_member(household_id));--> statement-breakpoint
CREATE POLICY "members can update their own week pulse"
  ON "household_week_pulses" FOR UPDATE TO authenticated
  USING (user_id = auth.uid() AND caller_is_active_member(household_id))
  WITH CHECK (user_id = auth.uid() AND caller_is_active_member(household_id));--> statement-breakpoint
CREATE POLICY "members can delete their own week pulse"
  ON "household_week_pulses" FOR DELETE TO authenticated
  USING (user_id = auth.uid() AND caller_is_active_member(household_id));--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "household_week_pulses" TO authenticated;
