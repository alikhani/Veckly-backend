# Veckly-backend architecture

Hono + `@hono/zod-openapi` on Node, deployed to Vercel (`api/index.ts`), Postgres on Supabase with
RLS. The OpenAPI document generated from the Zod schemas is the iOS contract
(`npm run openapi:write` → `Veckly-ios/OpenAPI/`).

## Layout

```
src/
  app.ts                 mounts every route builder; maps ApiError → JSON in onError
  modules/<feature>/     one folder per feature, flat inside (reference: modules/week-plan/)
  shared/                pure cross-module domain helpers (week-dates, recipe-matching)
  platform/              request plumbing shared by modules (http-errors: ApiError, RequestContext, require*)
  auth.ts rls.ts db.ts schema.ts …   infrastructure (moves to platform/ over time)
  <feature>.ts           not-yet-migrated features — still one file per feature
migrations/              SQL, incl. RLS policies (one file per change, never edited after deploy)
test/                    vitest; DB suites need local Postgres (npm run test:local)
```

New features go in `src/modules/<feature>/`. An existing `<feature>.ts` is migrated into a module
when you are already doing real work in it, never as a drive-by.

## A feature module

| File | Responsibility | May import | Must not import |
|---|---|---|---|
| `index.ts` | public surface: the route builder, plus anything other modules genuinely need | — | — |
| `routes.ts` | `createRoute` definitions + thin handlers: validate → check → call service → status code | service, schemas, platform, shared | `drizzle-orm`, `schema.js`, repository |
| `schemas.ts` | Zod/OpenAPI schemas and the `T*` types inferred from them | zod | db, hono runtime |
| `service*.ts` | use cases: business rules, premium gates, orchestration. Signature `(ctx: RequestContext, …)` | repository, pure files, other modules' `index.ts`, platform | hono `Context` |
| `repository.ts` | every Drizzle query, always inside `withRls`; returns rows, not HTTP shapes | drizzle, `schema.js`, `rls.js` | hono, service |
| pure files (`projection.ts`, `rescue.ts`, …) | deterministic domain logic, unit-testable without a DB | other pure files, `shared/`, `import type` from schemas | db, drizzle, hono, network |

Rules of thumb:
- A handler longer than ~15 lines is doing service work.
- Other modules import from `modules/<x>/index.ts` or `shared/`, never from a module's internal files.
- Transaction boundaries live in the repository. If two writes must land together, they are one
  repository function with one `withRls`.
- Split a service file per use case (`service-generate.ts`) once it passes ~600 lines.

## Request pipeline (household routes)

```ts
app.openapi(route, async (c) => {
  const { householdId, weekStartDate } = c.req.valid('param')
  requireMonday(weekStartDate, { status: 400, code: 'INVALID_WEEK_START_DATE' })
  const ctx = await requireHouseholdMember(db, authOf(c), householdId)   // 404 NOT_MEMBER
  const result = await someUseCase(ctx, weekStartDate)
  return c.json(result, 200)
})
```

1. **Authenticate:** `requireAuth` middleware (Supabase access token) sets `user` + `accessToken`.
2. **Validate:** Zod via `c.req.valid(...)`. Membership is checked after validation on purpose:
   zod-openapi middleware runs *before* param validation, so membership is a helper and not middleware.
3. **Authorize:** `requireHouseholdMember` → `RequestContext`. RLS enforces the same boundary in
   the database, and both layers are required.
4. **Gate:** premium/entitlement checks live in the service and return `{ gate }`. The route maps that to 403.
5. **Repository:** queries via `withRls(db, accessToken, …)`, so `auth.uid()` is the caller.

Errors: throw `ApiError(status, body)` (from `platform/http-errors.ts`) for expected failures. It is
mapped in `app.onError`. Anything else becomes a 500. Do not use `c.json(… as never)`.
Declare every status a route can return under `responses` in `createRoute`, because that is what iOS sees.

## Checklist: new route / new module

- [ ] Schema in `schemas.ts` with `.openapi('Name')`; all error statuses declared in `responses`
- [ ] Monday validation for any `weekStartDate`; membership check → 404 `NOT_MEMBER` (not 200)
- [ ] RLS policy in a migration for any new table, plus a cross-household negative test
- [ ] Service function takes `RequestContext`; repository owns the SQL
- [ ] Tests: pure logic as unit tests, the route via `buildApp` (status + body, incl. non-member)
- [ ] `npm run openapi:write` and regenerate the iOS client if the contract changed

## Gates before commit

```
npx tsc --noEmit
npm run test:local            # local Postgres on :54333 (docker start veckly-pg-strangle)
npm run openapi:write:backend && git diff openapi.json   # empty unless you meant to change the contract
```

## Known debt

- Pre-pilot features are still single files (`recipes.ts`, `recipe-import.ts`, …). Migrated so far:
  `week-plan`, `shopping-list`.
- Error bodies are not yet a typed code enum in OpenAPI, and some week-plan errors are free text or use
  non-standard statuses. They are listed in `PLAN-arkitektur-pilot-week-2026-10.md` ("Kända inkonsekvenser").
- `buildInternal*Routes` (MealPlanner strangle path) is spread across feature files and is removed when the
  web app calls the backend directly.
