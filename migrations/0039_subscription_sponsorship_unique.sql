-- One App Store, Play, or Stripe subscription may sponsor exactly one Veckly
-- household at a time. Moving sponsorship later must be an explicit domain
-- operation rather than an accidental second entitlement row.
CREATE UNIQUE INDEX IF NOT EXISTS "household_entitlements_subscription_unique_idx"
  ON "household_entitlements" ("subscription_id")
  WHERE "subscription_id" IS NOT NULL;
