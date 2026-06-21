# Runbook: Database Migrations & Rollback — Veckly-backend

**Status:** Active process documentation (written 2026-06-21, Phase 6 TestFlight-readiness item)
**Supabase project:** `ydzykuwqfslzewxisliv` (eu-north-1) — single project, no separate staging instance yet (see "Known gap" below)

---

## Why this exists

On 2026-06-16, migrations 0014–0019 were discovered missing from production — six migrations had been generated and committed but never applied to the Veckly Supabase project. The failure mode was silent until requests started hitting `relation does not exist` on `household_profiles`, `household_active_weeks`, `user_saved_recipes`, and `household_week_plans`. There was no checklist that would have caught this before users did. This runbook is that checklist.

---

## How migrations are generated

Schema changes are made in `src/schema.ts` (Drizzle ORM). To generate a new migration:

```bash
DATABASE_URL=<local-or-target-db-url> npm run db:generate
```

This runs `drizzle-kit generate`, diffs `src/schema.ts` against the migration history in `migrations/`, and writes a new numbered `.sql` file (`NNNN_description.sql`) plus a `meta/` snapshot. **Always commit the generated `.sql` file and its `meta/` entry together** — `drizzle-kit` uses the `meta/` snapshots to compute future diffs; a missing snapshot causes the next `generate` to produce a wrong or duplicate migration.

Review the generated SQL before committing. Drizzle's diffing is usually correct but does not always pick the safest path (e.g. it may emit a column drop + recreate where an `ALTER COLUMN` would do, or miss that a new `NOT NULL` column needs a default for existing rows).

## How migrations are applied

There are two ways migrations reach the production Supabase project — **neither runs automatically on deploy**. Vercel deploys the application code only; it does not run migrations as part of the build or release.

### Option A — `drizzle-kit migrate` (preferred, ordered, idempotent)

```bash
DATABASE_URL=<production-db-url> npm run db:migrate
```

This applies all migrations in `migrations/` that are not yet recorded in Drizzle's internal migration-tracking table, in order. Safe to run repeatedly — already-applied migrations are skipped.

### Option B — `mcp__supabase__apply_migration` (manual, used historically)

Used when working through the Supabase MCP tool directly against the project (this is how 0014–0019 were applied after being discovered missing). Apply migrations **in numeric order, one at a time**, verifying after each one rather than batching all of them in a single call — a failure partway through a batch is harder to diagnose than a failure on a single named migration.

### Required checklist before applying to production

1. Confirm the migration has been tested against a local Postgres instance first (`npm run test:local`, which spins up against `localhost:54333`).
2. Read the generated SQL — confirm it does not drop or rename a column/table still read by code currently deployed to production (a migration ships *before* the code that depends on it removing the old shape, never after).
3. Run `npm run db:migrate` (Option A) against production, or apply via MCP (Option B) in order.
4. **Verify immediately after applying:**
   ```sql
   select count(*) from information_schema.tables where table_schema = 'public';
   ```
   Compare against the expected table count (currently 16 as of migration 0023 — update this number when you add a migration that creates a new table).
5. Verify RLS policies exist on any new table:
   ```sql
   select tablename, policyname from pg_policies where schemaname = 'public' order by tablename;
   ```
6. Smoke-test the route(s) that depend on the new schema against production before considering the migration done — a missing migration fails at request time, not at deploy time, so deploy-success is not evidence the migration applied.

---

## Rollback plan

Drizzle does not generate down-migrations automatically. Rolling back is manual and depends on what the migration did:

| Migration type | Rollback approach |
|---|---|
| Added a new table | Write and run a `DROP TABLE IF EXISTS <name> CASCADE;` — safe only if no production data has been written to it yet. If data exists, do not drop; fix forward instead. |
| Added a nullable column | `ALTER TABLE <table> DROP COLUMN IF EXISTS <column>;` — safe if no code path depends on the column existing (check before dropping; code that already shipped a column-aware deploy will error on the next request). |
| Added a RLS policy | `DROP POLICY IF EXISTS <name> ON <table>;` — only do this if you are also reverting the deploy that depends on the policy; dropping a policy without reverting the deploy can open a household-isolation gap. |
| Changed/dropped an existing column | No safe automatic rollback — restore from a Supabase point-in-time backup (Supabase dashboard → Database → Backups) for the affected table's data if this was applied in error. |

**Rule:** if the migration already has production data written against the new shape, prefer a forward-fixing migration over a destructive rollback. Rollback is for "this should never have been applied," not "this needs adjusting."

### Rolling back a bad deploy (application code, not schema)

Vercel keeps prior deployments. To roll back:

```bash
vercel rollback <deployment-url-or-id> --token=<token>
```

or via the Vercel dashboard: Deployments → select the last known-good deployment → "Promote to Production." This reverts the running code instantly; it does **not** revert any database migration that shipped with the bad deploy — schema changes need the rollback steps above run separately, and only if the schema change itself (not just the application code) was the problem.

---

## Known gap — no staging environment

There is currently one Supabase project for Veckly-backend; there is no separate staging database to test a migration against production-shaped data before it lands on production. The `test:local` script covers schema-correctness against a fresh local Postgres, but not against production data shapes or volume. Until a staging project exists, treat every production migration as the first real test — follow the checklist above strictly, and prefer reversible (additive, nullable) migrations over destructive ones whenever the product requirement allows it.
