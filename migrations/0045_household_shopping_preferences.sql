CREATE TABLE "household_shopping_preferences" (
  "household_id" uuid PRIMARY KEY REFERENCES "households"("id") ON DELETE CASCADE,
  "category_order" jsonb NOT NULL,
  "updated_by" uuid NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
ALTER TABLE "household_shopping_preferences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "members can read household shopping preferences"
  ON "household_shopping_preferences" FOR SELECT TO authenticated
  USING (caller_is_active_member(household_id));--> statement-breakpoint
CREATE POLICY "members can insert household shopping preferences"
  ON "household_shopping_preferences" FOR INSERT TO authenticated
  WITH CHECK (caller_is_active_member(household_id));--> statement-breakpoint
CREATE POLICY "members can update household shopping preferences"
  ON "household_shopping_preferences" FOR UPDATE TO authenticated
  USING (caller_is_active_member(household_id))
  WITH CHECK (caller_is_active_member(household_id));--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "household_shopping_preferences" TO authenticated;
