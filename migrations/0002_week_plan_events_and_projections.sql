CREATE TYPE "public"."week_plan_event_type" AS ENUM('week_started', 'meal_assigned');--> statement-breakpoint
CREATE TABLE "week_plan_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"week_start_date" date NOT NULL,
	"sequence_number" integer NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"caused_by" jsonb NOT NULL,
	"event_type" "week_plan_event_type" NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "week_plan_projections" (
	"household_id" uuid NOT NULL,
	"week_start_date" date NOT NULL,
	"state" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "week_plan_events" ADD CONSTRAINT "week_plan_events_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "week_plan_projections" ADD CONSTRAINT "week_plan_projections_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "week_plan_events_household_week_sequence_idx" ON "week_plan_events" USING btree ("household_id","week_start_date","sequence_number");--> statement-breakpoint
CREATE UNIQUE INDEX "week_plan_projections_household_week_idx" ON "week_plan_projections" USING btree ("household_id","week_start_date");