# Veckly-backend

The API behind Veckly, a weekly family dinner planner. It serves the iOS app (and, during the strangle
migration, the MealPlanner web app). Built with Hono + `@hono/zod-openapi` on Node, Postgres on Supabase
with row-level security, and deployed to Vercel.

- **How the code is organised:** [ARCHITECTURE.md](ARCHITECTURE.md). Read this before adding a route.
- **Current status and history:** [docs/current-status.md](docs/current-status.md)
- **Runbooks:** [migrations & rollback](docs/runbooks/migration-and-rollback-runbook.md), [App Store sandbox](docs/runbooks/app-store-sandbox.md)
- **Product and domain background:** `../MealPlanner/docs/` (vision, user journeys, domain model)

## Setup

Requirements: Node 22+, Docker (for the local test database).

```bash
npm install
cp .env.example .env        # fill in Supabase URL/anon key; ANTHROPIC_API_KEY only for AI routes
```

### Local test database

The test suite runs against a plain Postgres 16 instance. A small shim provides Supabase's `auth.uid()`
and `authenticated` role, so RLS policies are exercised without a Supabase project. Migrations are
applied automatically on the first run.

```bash
# first time
docker run -d --name veckly-pg-strangle -e POSTGRES_PASSWORD=postgres -p 54333:5432 postgres:16
docker exec veckly-pg-strangle createdb -U postgres postgres_test
# afterwards
docker start veckly-pg-strangle
```

## Everyday commands

| Command | What it does |
|---|---|
| `npm run dev` | API on http://localhost:3001 with reload (uses `.env`) |
| `npm run test:local` | full test suite against the local database on :54333 |
| `npx tsc --noEmit` | typecheck (must be clean) |
| `npm run openapi:write:backend` | regenerate `openapi.json` from the Zod schemas |
| `npm run openapi:write` | write the spec into `../Veckly-ios/OpenAPI/`, then run `Veckly-ios/scripts/generate-openapi-client.sh` |
| `npm run db:generate` | generate a migration from `src/schema.ts` (see the migrations runbook) |
| `npm run db:check` | read-only: does every object a committed migration creates exist in `DATABASE_URL`? |

## Before you commit

CI (`.github/workflows/ci.yml`) runs the same three checks. It is **manual for now** to save CI minutes
(`gh workflow run CI --ref <branch>`), so run the checks locally:

1. `npx tsc --noEmit`
2. `npm run openapi:write:backend` produces no diff. If it does, you changed the API contract: commit
   `openapi.json`, update the iOS spec and client, and treat it as a contract change.
3. The full test suite, including RLS and HTTP-level tests

Commit messages are a single imperative title line.

## Deploying

Deploys are **manual**: pushing to `master` does not deploy.

```bash
DATABASE_URL=<production-url> npm run db:check   # read-only: are all migrations applied?
vercel --prod
```

Migrations are never applied by a deploy. Follow the [migrations runbook](docs/runbooks/migration-and-rollback-runbook.md)
and apply them **before** deploying code that depends on them. The iOS simulator and TestFlight builds
talk to production (`veckly-backend.vercel.app`), so a new required response field breaks the app until
both code and migrations are live.
