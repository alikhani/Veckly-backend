CREATE TYPE "public"."product_event_name" AS ENUM(
  'onboarding_completed',
  'first_week_generated',
  'week_completed',
  'shopping_opened_after_week_completed',
  'shopping_shared',
  'partner_invite_clicked',
  'shopping_main_list_completed',
  'retro_completed'
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "household_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "event_name" "product_event_name" NOT NULL,
  "week_start_date" date,
  "properties" jsonb NOT NULL,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "product_events" ADD CONSTRAINT "product_events_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_events_household_occurred_idx" ON "product_events" USING btree ("household_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_events_name_occurred_idx" ON "product_events" USING btree ("event_name","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_events_user_occurred_idx" ON "product_events" USING btree ("user_id","occurred_at");--> statement-breakpoint
ALTER TABLE "product_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "product_events_select_via_active_membership"
  ON "product_events"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM "household_memberships" m
      WHERE m.household_id = "product_events".household_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );--> statement-breakpoint
CREATE POLICY "product_events_insert_via_active_membership"
  ON "product_events"
  FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM "household_memberships" m
      WHERE m.household_id = "product_events".household_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );
