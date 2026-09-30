ALTER TYPE "public"."week_plan_event_type"
  ADD VALUE IF NOT EXISTS 'week_context_override_upserted';--> statement-breakpoint
ALTER TYPE "public"."week_plan_event_type"
  ADD VALUE IF NOT EXISTS 'week_context_override_cleared';
