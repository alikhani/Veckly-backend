ALTER TYPE "public"."week_plan_event_type" ADD VALUE IF NOT EXISTS 'planning_request_updated';
--> statement-breakpoint
ALTER TYPE "public"."week_plan_event_type" ADD VALUE IF NOT EXISTS 'meal_unassigned';
--> statement-breakpoint
ALTER TYPE "public"."week_plan_event_type" ADD VALUE IF NOT EXISTS 'meal_locked';
--> statement-breakpoint
ALTER TYPE "public"."week_plan_event_type" ADD VALUE IF NOT EXISTS 'meal_unlocked';
--> statement-breakpoint
ALTER TYPE "public"."week_plan_event_type" ADD VALUE IF NOT EXISTS 'meal_moved';
--> statement-breakpoint
ALTER TYPE "public"."week_plan_event_type" ADD VALUE IF NOT EXISTS 'day_skipped';
--> statement-breakpoint
ALTER TYPE "public"."week_plan_event_type" ADD VALUE IF NOT EXISTS 'day_unskipped';
--> statement-breakpoint
ALTER TYPE "public"."week_plan_event_type" ADD VALUE IF NOT EXISTS 'servings_changed';
--> statement-breakpoint
ALTER TYPE "public"."week_plan_event_type" ADD VALUE IF NOT EXISTS 'week_plan_cleared';
