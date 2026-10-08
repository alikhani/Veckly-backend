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
  platform/              request plumbing shared by modules (http-errors: ErrorCode, ApiError, RequestContext, require*)
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
- A repository may **read** another module's tables (from `schema.ts`) when the data must come from
  the same `withRls` transaction. For example, shopping-list's summary reads `week_plan_projections`, and
  week-plan reads `shopping_list_projections`. Declare a narrow local type for the columns you read and
  leave a comment naming the owning module. **Writes** to another module's tables always go through
  that module's `index.ts`.
- Transaction boundaries live in the repository. If two writes must land together, they are one
  repository function with one `withRls`.
- Split a service file per use case (`service-generate.ts`) once it passes ~600 lines.

## Request pipeline (household routes)

```ts
const app = new OpenAPIHono<TEnv>({ defaultHook: invalidRequestHook })   // 400 INVALID_REQUEST

app.openapi(route, async (c) => {
  const { householdId, weekStartDate } = c.req.valid('param')
  requireMonday(weekStartDate, { status: 400, code: 'INVALID_WEEK_START_DATE' })
  const ctx = await requireHouseholdMember(db, authOf(c), householdId)   // 404 NOT_MEMBER
  const result = await someUseCase(ctx, weekStartDate)
  return c.json(result, 200)
})
```

1. **Authenticate:** `requireAuth` middleware (Supabase access token) sets `user` + `accessToken`.
2. **Validate:** Zod via `c.req.valid(...)`, then the Monday week (and any date that must fall inside it).
   Always in this order: validation → Monday → membership, so invalid input is 400 for members and
   non-members alike. Membership is checked after validation on purpose: zod-openapi middleware runs
   *before* param validation, so membership is a helper and not middleware.
3. **Authorize:** `requireHouseholdMember` → `RequestContext`. RLS enforces the same boundary in
   the database, and both layers are required.
4. **Gate:** premium/entitlement checks live in the service and return `{ gate }`. The route maps that to 403.
5. **Repository:** queries via `withRls(db, accessToken, …)`, so `auth.uid()` is the caller.

## Error contract

Every expected failure from a module answers `{ error: ErrorCode }` (`ErrorResponse` in OpenAPI).
`ErrorCode` is one enum in `platform/http-errors.ts`; add a code there before using it.
In OpenAPI, `ErrorResponse.error` is an **open enum** (`anyOf: [ErrorCode, string]`), so app builds
already in users' hands still decode a code added later. Adding a code to `ErrorCode` is therefore
safe. Changing an operation's status code, or adding a value to one of the subset enums (below), is
not: subset enums are closed in the generated Swift, so shipped builds fail to decode the new value.

- Throw `new ApiError(status, 'CODE')` for expected failures; it is mapped in `app.onError`. The code is
  typed, so an unknown code does not compile. Extra fields go in the third argument
  (`{ updatedAt }` for the stale-state 409s, declared by their own response schemas).
- Premium gates throw `new ApiError(403, gate)` with the `PremiumRequiredResponse` body unchanged.
- Failed Zod validation in a module: 400 `INVALID_REQUEST` with `issues: [{ code, path, message }]`
  (debugging aid; clients branch on `error`). Pass `defaultHook: invalidRequestHook` to the module's
  `OpenAPIHono`. Not-yet-migrated files still answer Zod's `{ success: false, error }`.
- A JSON body that cannot be parsed: 400 `INVALID_JSON`, app-wide (`HTTPException` in `app.onError`).
- Anything else becomes a 500. Do not use `c.json(… as never)`.
- Use-case results with their own narrower error enums (`WeekRescueError`, `PreviousWeekProposalError`,
  `GenerateWeekPlanError`) list a subset of `ErrorCode`, checked with `satisfies readonly ErrorCode[]`.

Declare every status a route can return under `responses` in `createRoute`, because that is what iOS
sees. Use `...errorResponses({ 400: '…', 404: '…' })` for `ErrorResponse` bodies.
`test/openapi-error-responses.test.ts` fails when a week-plan or shopping-list handler can answer a
status that is not declared.

## Checklist: new route / new module

- [ ] Schema in `schemas.ts` with `.openapi('Name')`; all error statuses declared in `responses`
      (`errorResponses(...)`), and the module added to `test/openapi-error-responses.test.ts`
- [ ] `OpenAPIHono({ defaultHook: invalidRequestHook })`; errors are `ApiError(status, ErrorCode)`
- [ ] Monday validation for any `weekStartDate` before membership; membership check → 404 `NOT_MEMBER` (not 200)
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
- Only `week-plan` and `shopping-list` use the error contract. Pre-pilot features keep their own error
  bodies (free text, Zod's validation format) until they are migrated.
- 401 from `requireAuth` is still free text (`{ error: 'Missing bearer token' }`) and declared without a body.
- `buildInternal*Routes` (MealPlanner strangle path) is spread across feature files and is removed when the
  web app calls the backend directly.
