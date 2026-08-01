ALTER TABLE "household_ai_weekly_usage" RENAME COLUMN "week_start_date" TO "period_start_date";--> statement-breakpoint
ALTER TABLE "premium_gate_observations" ALTER COLUMN "household_id" DROP NOT NULL;
