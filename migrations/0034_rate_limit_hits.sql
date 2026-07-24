CREATE TABLE IF NOT EXISTS "rate_limit_hits" (
  "user_id" text NOT NULL,
  "scope" text NOT NULL,
  "hit_at" timestamp with time zone NOT NULL,
  CONSTRAINT "rate_limit_hits_pk" PRIMARY KEY("user_id","scope")
);
--> statement-breakpoint
-- Every other production table has RLS enabled; match that even though this
-- table is server-internal-only. No policies means no access for `anon` or
-- `authenticated` (deny by default) — the app's own connection uses the table
-- owner role, which bypasses RLS regardless, so this has no effect on the app.
ALTER TABLE "rate_limit_hits" ENABLE ROW LEVEL SECURITY;
