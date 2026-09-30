ALTER TYPE "public"."week_plan_event_type"
  ADD VALUE IF NOT EXISTS 'week_rescued';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "week_plan_events_rescue_id_unique_idx"
  ON "week_plan_events" ("household_id", "week_start_date", (("payload" ->> 'rescueId')))
  WHERE "event_type" = 'week_rescued';
