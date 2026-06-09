CREATE TYPE "public"."recipe_source" AS ENUM('user_created', 'url_import', 'ai_generated');--> statement-breakpoint
CREATE TABLE "recipes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"servings" integer DEFAULT 4 NOT NULL,
	"ingredients" jsonb NOT NULL,
	"steps" jsonb NOT NULL,
	"tags" jsonb NOT NULL,
	"prep_time_minutes" integer,
	"cook_time_minutes" integer,
	"cuisine" text,
	"protein_source" text,
	"meal_weight" text,
	"source_url" text,
	"source" "recipe_source" DEFAULT 'user_created' NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recipes_household_updated_idx" ON "recipes" USING btree ("household_id","updated_at");