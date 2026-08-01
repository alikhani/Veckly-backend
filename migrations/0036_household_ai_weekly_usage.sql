CREATE TYPE "public"."household_ai_usage_kind" AS ENUM('week_generation', 'week_regeneration');--> statement-breakpoint
CREATE TABLE "household_ai_weekly_usage" (
  "household_id" uuid NOT NULL REFERENCES "households"("id") ON DELETE CASCADE,
  "week_start_date" date NOT NULL,
  "usage_kind" "household_ai_usage_kind" NOT NULL,
  "used_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY("household_id", "week_start_date", "usage_kind")
);--> statement-breakpoint
ALTER TABLE "household_ai_weekly_usage" ENABLE ROW LEVEL SECURITY;
