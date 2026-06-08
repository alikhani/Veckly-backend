CREATE TYPE "public"."shopping_list_event_type" AS ENUM('list_started', 'item_checked');--> statement-breakpoint
CREATE TABLE "shopping_list_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"week_start_date" date NOT NULL,
	"sequence_number" integer NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"caused_by" jsonb NOT NULL,
	"event_type" "shopping_list_event_type" NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shopping_list_projections" (
	"household_id" uuid NOT NULL,
	"week_start_date" date NOT NULL,
	"state" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shopping_list_events" ADD CONSTRAINT "shopping_list_events_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopping_list_projections" ADD CONSTRAINT "shopping_list_projections_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shopping_list_events_household_week_sequence_idx" ON "shopping_list_events" USING btree ("household_id","week_start_date","sequence_number");--> statement-breakpoint
CREATE UNIQUE INDEX "shopping_list_projections_household_week_idx" ON "shopping_list_projections" USING btree ("household_id","week_start_date");