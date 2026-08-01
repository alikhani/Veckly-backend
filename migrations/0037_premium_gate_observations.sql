CREATE TABLE "premium_gate_observations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "household_id" uuid NOT NULL REFERENCES "households"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL,
  "reason" text NOT NULL,
  "limit_value" integer,
  "current_value" integer,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "premium_gate_observations_household_occurred_idx" ON "premium_gate_observations" ("household_id", "occurred_at");--> statement-breakpoint
ALTER TABLE "premium_gate_observations" ENABLE ROW LEVEL SECURITY;
