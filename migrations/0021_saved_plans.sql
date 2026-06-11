CREATE TABLE IF NOT EXISTS "saved_plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"label" text NOT NULL,
	"state_json" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "saved_plans_user_created_idx" ON "saved_plans" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "saved_plans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "saved_plans_select_own"
  ON "saved_plans"
  FOR SELECT
  USING (user_id = auth.uid());--> statement-breakpoint
CREATE POLICY "saved_plans_insert_own"
  ON "saved_plans"
  FOR INSERT
  WITH CHECK (user_id = auth.uid());--> statement-breakpoint
CREATE POLICY "saved_plans_update_own"
  ON "saved_plans"
  FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());--> statement-breakpoint
CREATE POLICY "saved_plans_delete_own"
  ON "saved_plans"
  FOR DELETE
  USING (user_id = auth.uid());
