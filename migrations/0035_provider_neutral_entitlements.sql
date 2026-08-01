CREATE TYPE "public"."billing_provider" AS ENUM('app_store', 'google_play', 'stripe', 'manual');--> statement-breakpoint
CREATE TYPE "public"."billing_subscription_status" AS ENUM('active', 'grace_period', 'expired', 'cancelled', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."household_entitlement_source" AS ENUM('subscription', 'manual', 'beta');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider" "billing_provider" NOT NULL,
  "owner_user_id" uuid NOT NULL,
  "external_id" text NOT NULL,
  "product_id" text NOT NULL,
  "status" "billing_subscription_status" NOT NULL,
  "current_period_ends_at" timestamp with time zone,
  "environment" text NOT NULL,
  "provider_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "billing_subscriptions_provider_external_id_unique" UNIQUE("provider", "external_id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_subscriptions_owner_status_idx" ON "billing_subscriptions" ("owner_user_id", "status");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_provider_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider" "billing_provider" NOT NULL,
  "provider_event_id" text NOT NULL,
  "subscription_id" uuid REFERENCES "billing_subscriptions"("id") ON DELETE SET NULL,
  "payload" jsonb NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "billing_provider_events_provider_event_id_unique" UNIQUE("provider", "provider_event_id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_provider_events_subscription_received_idx" ON "billing_provider_events" ("subscription_id", "received_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "household_entitlements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "household_id" uuid NOT NULL REFERENCES "households"("id") ON DELETE CASCADE,
  "subscription_id" uuid REFERENCES "billing_subscriptions"("id") ON DELETE CASCADE,
  "source" "household_entitlement_source" NOT NULL,
  "starts_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ends_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "granted_by" uuid,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "household_entitlements_source_subscription_check" CHECK (
    (source = 'subscription' AND subscription_id IS NOT NULL)
    OR (source IN ('manual', 'beta') AND subscription_id IS NULL)
  )
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "household_entitlements_household_validity_idx" ON "household_entitlements" ("household_id", "ends_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "household_entitlements_subscription_idx" ON "household_entitlements" ("subscription_id");--> statement-breakpoint
-- These are server-authoritative financial/access records. There are
-- intentionally no authenticated policies: client JWTs can neither inspect
-- nor mutate them, and later read endpoints resolve a safe public shape.
ALTER TABLE "billing_subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "billing_provider_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "household_entitlements" ENABLE ROW LEVEL SECURITY;
