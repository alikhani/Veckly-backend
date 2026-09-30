ALTER TYPE "public"."week_plan_event_type"
  ADD VALUE IF NOT EXISTS 'previous_week_reused';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "week_plan_events_previous_week_proposal_id_unique_idx"
  ON "week_plan_events" ("household_id", "week_start_date", (("payload" ->> 'proposalId')))
  WHERE "event_type" = 'previous_week_reused';
