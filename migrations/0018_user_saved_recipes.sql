CREATE TABLE IF NOT EXISTS "user_saved_recipes" (
	"user_id" uuid NOT NULL,
	"recipe_id" uuid NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_saved_recipes_pk" PRIMARY KEY("user_id","recipe_id")
);
--> statement-breakpoint
ALTER TABLE "user_saved_recipes" ADD CONSTRAINT "user_saved_recipes_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_saved_recipes_user_saved_at_idx" ON "user_saved_recipes" USING btree ("user_id","saved_at");--> statement-breakpoint
ALTER TABLE "user_saved_recipes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "user_saved_recipes_select_own"
  ON "user_saved_recipes"
  FOR SELECT
  USING (user_id = auth.uid());--> statement-breakpoint
CREATE POLICY "user_saved_recipes_insert_own_readable_recipe"
  ON "user_saved_recipes"
  FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM "recipes" r
      WHERE r.id = "user_saved_recipes".recipe_id
    )
  );--> statement-breakpoint
CREATE POLICY "user_saved_recipes_delete_own"
  ON "user_saved_recipes"
  FOR DELETE
  USING (user_id = auth.uid());
