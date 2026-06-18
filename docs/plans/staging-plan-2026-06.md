# Staging Plan - 2026-06

Status: paused
Updated: 2026-06-18

## Goal

Make `Veckly-ios` simulator/debug builds use a non-production environment with a
real auth flow, while keeping `Release`/`TestFlight` pointed at production.

Target split:

- `Debug` / simulator -> staging
- `Release` / TestFlight -> production

## What is already implemented

### Backend

- Added staging-only `POST /auth/dev-token`
- Route is guarded by:
  - `ENABLE_DEV_AUTH=true`
  - non-production environment checks
- Route returns a real Supabase session:
  - `accessToken`
  - `refreshToken`
  - `userId`
- Added backend tests for:
  - default dev user
  - selected dev user via `userId`
  - unknown user handling
  - route disabled in production / disabled mode
- Added `devAuthEnabled` to `/health`

### iOS

- Added build-config driven environment model
- Added `Debug -> staging`, `Release -> production`
- Added `Sign in as dev` in debug-enabled builds
- Added session persistence for dev login
- Added UI test hooks:
  - `-UIReset`
  - `-UITestUserId=<uuid>`
- Added local-only override support via:
  - `Config/DeveloperOverrides.xcconfig`

## What we verified

- `Veckly-backend` build passed
- `Veckly-backend` targeted tests passed
- `Veckly-ios` build passed

## What we learned

The idea of using the `MealPlanner` Supabase setup directly as Veckly staging was
partly right, but incomplete.

What we confirmed:

- `MealPlanner` preview has a Supabase-backed Postgres database
- `MealPlanner` does not expose a ready-to-use Supabase Auth config for Veckly iOS
- `MealPlanner` auth is Better Auth, not the Supabase bearer-token flow used by
  `Veckly-ios` + `Veckly-backend`
- current `Veckly-backend` preview env does not yet have staging Supabase Auth
  values or `ENABLE_DEV_AUTH=true`

Conclusion:

- `MealPlanner` database can potentially be reused as transitional staging data
- but it is not, by itself, enough to power Veckly iOS auth
- the clean path forward is a real Supabase Auth-backed staging setup for
  `Veckly-backend`

## Minimum setup still needed

### Vercel preview envs for `Veckly-backend`

```env
APP_ENV=staging
SUPABASE_URL=https://<staging-project-ref>.supabase.co
SUPABASE_ANON_KEY=<staging-anon-key>
ENABLE_DEV_AUTH=true
```

Then configure test users with either:

```env
DEV_AUTH_USERS_JSON=[
  {
    "userId":"11111111-1111-1111-1111-111111111111",
    "email":"dev-primary@yourdomain.com",
    "password":"<password>"
  },
  {
    "userId":"22222222-2222-2222-2222-222222222222",
    "email":"dev-secondary@yourdomain.com",
    "password":"<password>"
  }
]
```

or:

```env
DEV_AUTH_DEFAULT_USER_ID=11111111-1111-1111-1111-111111111111
DEV_AUTH_DEFAULT_EMAIL=dev-primary@yourdomain.com
DEV_AUTH_DEFAULT_PASSWORD=<password>
DEV_AUTH_SECONDARY_USER_ID=22222222-2222-2222-2222-222222222222
DEV_AUTH_SECONDARY_EMAIL=dev-secondary@yourdomain.com
DEV_AUTH_SECONDARY_PASSWORD=<password>
```

### Supabase staging requirements

- real Supabase Auth project
- at least one stable test user
- ideally one second user for collaboration testing
- seeded household/profile/week/shopping/recipe data

## Recommended next steps

1. Provision a real Supabase Auth-backed staging project for Veckly.
2. Add the preview env vars above to `Veckly-backend`.
3. Create the stable dev users in Supabase Auth.
4. Seed one canonical staging household.
5. Verify:
   - `GET /health` returns `devAuthEnabled: true`
   - `POST /auth/dev-token` returns a real session
   - `Veckly-ios` debug build can sign in as dev

## Notes

- During transition, `MealPlanner` data/storage may still inform staging decisions,
  but auth should follow the Veckly/Supabase bearer-token model.
- This plan intentionally avoids introducing a fake JWT bypass in the app or backend.
