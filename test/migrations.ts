import { sql } from 'drizzle-orm'
import fs from 'node:fs'
import path from 'node:path'
import type { Db } from '../src/db.js'

// `auth.uid()` is a Supabase-provided primitive, not a vanilla Postgres one — it
// reads the `sub` claim that Supabase's PostgREST/GoTrue layer injects into
// `request.jwt.claims` per request. Recreating that shim is what lets RLS
// policies be exercised against a plain local Postgres (or CI service
// container) instead of requiring a live Supabase project just to prove the
// boundary holds.
export const AUTH_SCHEMA_SHIM = `
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid
    language sql stable
    as $$
      select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
    $$;
`

// Several test files share one TEST_DATABASE_URL (vitest runs all suites
// against the same database) — applying the migration set unconditionally in
// each file's beforeAll would collide on "type already exists" the moment a
// second DB-touching suite exists. Check for the marker table first so the
// migrations only run once, no matter which suite happens to start first.
export async function ensureMigrationsApplied(db: Db, migrationsDir: string) {
  await db.execute(sql.raw(AUTH_SCHEMA_SHIM))

  const [rateLimitHitsMarker] = await db.execute<{ exists: string | null }>(sql`select to_regclass('public.rate_limit_hits') as exists`)
  const [householdEntitlementsMarker] = await db.execute<{ exists: string | null }>(sql`select to_regclass('public.household_entitlements') as exists`)
  const [householdAiUsageMarker] = await db.execute<{ exists: string | null }>(sql`select to_regclass('public.household_ai_weekly_usage') as exists`)
  const [premiumGateObservationsMarker] = await db.execute<{ exists: string | null }>(sql`select to_regclass('public.premium_gate_observations') as exists`)
  const [gateHardeningMarker] = await db.execute<{ exists: string | null }>(sql`
    select column_name as exists from information_schema.columns
    where table_name = 'household_ai_weekly_usage' and column_name = 'period_start_date'
  `)
  const [subscriptionSponsorshipMarker] = await db.execute<{ exists: string | null }>(sql`
    select indexname as exists from pg_indexes
    where tablename = 'household_entitlements'
      and indexname = 'household_entitlements_subscription_unique_idx'
  `)
  const [householdRecipeRecommendationsMarker] = await db.execute<{ exists: string | null }>(sql`select to_regclass('public.household_recipe_recommendations') as exists`)
  const [householdsDeleteRlsMarker] = await db.execute<{ exists: string | null }>(sql`
    select policyname as exists from pg_policies
    where tablename = 'households'
      and policyname = 'households_delete_owner_only'
  `)
  const [householdMealSignalsMarker] = await db.execute<{ exists: string | null }>(sql`select to_regclass('public.household_meal_signals') as exists`)
  const [productEventsMarker] = await db.execute<{ exists: string | null }>(sql`select to_regclass('public.product_events') as exists`)
  const [householdSavedRecipesMarker] = await db.execute<{ exists: string | null }>(sql`select to_regclass('public.household_saved_recipes') as exists`)
  const [mealTypeCheckMarker] = await db.execute<{ exists: string | null }>(sql`
    select constraint_name as exists from information_schema.table_constraints
    where table_name = 'household_prep_batch_assignments'
      and constraint_name = 'household_prep_batch_assignments_meal_type_check'
  `)

  const [prepBatchesRlsHardeningMarker] = await db.execute<{ exists: string | null }>(sql`
    select policyname as exists from pg_policies
    where tablename = 'household_prep_batches'
      and policyname = 'members can read their household prep batches'
      and qual like '%caller_is_active_member%'
  `)
  const [userProfilesMarker] = await db.execute<{ exists: string | null }>(sql`select to_regclass('public.user_profiles') as exists`)
  const [peerVisibilityMarker] = await db.execute<{ exists: string | null }>(sql`select to_regprocedure('caller_is_active_member(uuid)') as exists`)
  const [prepBatchesMarker] = await db.execute<{ exists: string | null }>(sql`select to_regclass('public.household_prep_batches') as exists`)
  const [baseMarker] = await db.execute<{ exists: string | null }>(sql`select to_regclass('public.week_plan_projections') as exists`)
  const [profileMarker] = await db.execute<{ exists: string | null }>(sql`select to_regclass('public.household_profiles') as exists`)
  const [activeWeekMarker] = await db.execute<{ exists: string | null }>(sql`select to_regclass('public.household_active_weeks') as exists`)
  const [savedRecipesMarker] = await db.execute<{ exists: string | null }>(sql`select to_regclass('public.user_saved_recipes') as exists`)
  const [weekPlansMarker] = await db.execute<{ exists: string | null }>(sql`select to_regclass('public.household_week_plans') as exists`)
  const [mealFeedbackMarker] = await db.execute<{ exists: string | null }>(sql`select to_regclass('public.meal_feedback') as exists`)
  const [savedPlansMarker] = await db.execute<{ exists: string | null }>(sql`select to_regclass('public.saved_plans') as exists`)
  const alreadyHasRateLimitHitsMigration = Boolean(rateLimitHitsMarker?.exists)
  const alreadyHasHouseholdEntitlementsMigration = Boolean(householdEntitlementsMarker?.exists)
  const alreadyHasHouseholdAiUsageMigration = Boolean(householdAiUsageMarker?.exists)
  const alreadyHasPremiumGateObservationsMigration = Boolean(premiumGateObservationsMarker?.exists)
  const alreadyHasGateHardeningMigration = Boolean(gateHardeningMarker?.exists)
  const alreadyHasSubscriptionSponsorshipMigration = Boolean(subscriptionSponsorshipMarker?.exists)
  const alreadyHasHouseholdRecipeRecommendationsMigration = Boolean(householdRecipeRecommendationsMarker?.exists)
  const alreadyHasHouseholdsDeleteRlsMigration = Boolean(householdsDeleteRlsMarker?.exists)
  const alreadyHasMealTypeCheckMigration = Boolean(mealTypeCheckMarker?.exists)
  const alreadyHasProductEventsMigration = Boolean(productEventsMarker?.exists)
  const alreadyHasHouseholdMealSignalsMigration = Boolean(householdMealSignalsMarker?.exists)
  const alreadyHasHouseholdSavedRecipesMigration = Boolean(householdSavedRecipesMarker?.exists)
  const alreadyHasPrepBatchesRlsHardeningMigration = Boolean(prepBatchesRlsHardeningMarker?.exists)
  const alreadyHasUserProfilesMigration = Boolean(userProfilesMarker?.exists)
  const alreadyHasPeerVisibilityMigration = Boolean(peerVisibilityMarker?.exists)
  const alreadyHasPrepBatchesMigration = Boolean(prepBatchesMarker?.exists)
  const alreadyHasBaseMigrations = Boolean(baseMarker?.exists)
  const alreadyHasProfilesMigration = Boolean(profileMarker?.exists)
  const alreadyHasActiveWeekMigration = Boolean(activeWeekMarker?.exists)
  const alreadyHasSavedRecipesMigration = Boolean(savedRecipesMarker?.exists)
  const alreadyHasWeekPlansMigration = Boolean(weekPlansMarker?.exists)
  const alreadyHasMealFeedbackMigration = Boolean(mealFeedbackMarker?.exists)
  const alreadyHasSavedPlansMigration = Boolean(savedPlansMarker?.exists)

  for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    if (alreadyHasSubscriptionSponsorshipMigration && file < '0040_') continue
    if (alreadyHasGateHardeningMigration && file < '0039_') continue
    if (alreadyHasPremiumGateObservationsMigration && file < '0038_') continue
    if (alreadyHasHouseholdAiUsageMigration && file < '0037_') continue
    if (alreadyHasHouseholdEntitlementsMigration && file < '0036_') continue
    if (alreadyHasRateLimitHitsMigration && file < '0035_') continue
    if (alreadyHasHouseholdRecipeRecommendationsMigration && file < '0034_') continue
    if (alreadyHasHouseholdsDeleteRlsMigration && file < '0033_') continue
    if (alreadyHasProductEventsMigration && file < '0032_') continue
    if (alreadyHasHouseholdMealSignalsMigration && file < '0031_') continue
    if (alreadyHasHouseholdSavedRecipesMigration && file < '0030_') continue
    if (alreadyHasMealTypeCheckMigration && file < '0029_') continue
    if (alreadyHasPrepBatchesRlsHardeningMigration && file < '0027_') continue
    if (alreadyHasUserProfilesMigration && file < '0026_') continue
    if (alreadyHasPeerVisibilityMigration && file < '0025_') continue
    if (alreadyHasPrepBatchesMigration && file < '0024_') continue
    if (alreadyHasSavedPlansMigration && file < '0022_') continue
    if (alreadyHasMealFeedbackMigration && file < '0021_') continue
    if (alreadyHasWeekPlansMigration && file < '0020_') continue
    if (alreadyHasSavedRecipesMigration && file < '0019_') continue
    if (alreadyHasActiveWeekMigration && file < '0016_') continue
    if (alreadyHasProfilesMigration && file < '0015_') continue
    if (alreadyHasBaseMigrations && file < '0014_') continue
    const contents = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
    const statements = contents.split('--> statement-breakpoint')
    for (const statement of statements) {
      const trimmed = statement.replace(/^-- .*$/gm, '').trim()
      if (trimmed.length > 0) await db.execute(sql.raw(trimmed))
    }
  }
}

// RLS policies are necessary but not sufficient — the `authenticated` role
// also needs the underlying SQL privilege via GRANT, or every write fails
// before the policy is even consulted. Idempotent via `do $$ ... if not
// exists`, and GRANT itself is naturally idempotent.
export async function ensureAuthenticatedRoleGranted(db: Db) {
  await db.execute(sql.raw(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then
        create role authenticated nologin;
      end if;
    end $$;
    grant usage on schema public to authenticated;
    grant select, insert, update, delete on "households" to authenticated;
    grant select, insert, update on "household_memberships" to authenticated;
    grant select, insert, update on "household_invites" to authenticated;
    grant select, insert on "week_plan_events" to authenticated;
    grant select, insert, update on "week_plan_projections" to authenticated;
    grant select, insert, update on "household_week_plans" to authenticated;
    grant select, insert on "shopping_list_events" to authenticated;
    grant select, insert, update on "shopping_list_projections" to authenticated;
    grant select, insert, update on "recipes" to authenticated;
    grant select, insert, delete on "user_saved_recipes" to authenticated;
    grant select, insert, delete on "household_saved_recipes" to authenticated;
    grant select, insert, update, delete on "household_meal_signals" to authenticated;
    grant select, insert on "product_events" to authenticated;
    grant select, insert, update, delete on "meal_feedback" to authenticated;
    grant select, insert, update, delete on "saved_plans" to authenticated;
    grant select, insert, update on "household_profiles" to authenticated;
    grant select, insert, update, delete on "household_active_weeks" to authenticated;
    grant select, insert, delete on "household_prep_batches" to authenticated;
    grant select, insert, delete on "household_prep_batch_assignments" to authenticated;
    grant select, insert, update on "user_profiles" to authenticated;
    grant select, insert, update on "household_recipe_recommendations" to authenticated;
  `))
}
