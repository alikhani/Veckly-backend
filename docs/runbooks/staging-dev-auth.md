# Staging Dev Auth Runbook

Status: active
Updated: 2026-06-18

## Purpose

This runbook wires the iOS simulator/debug build to a staging Veckly backend and a
staging Supabase Auth project, with a backend-assisted dev login flow.

The intended split is:

- `Debug` / simulator -> `staging`
- `Release` / TestFlight -> `production`

## Backend contract

`POST /auth/dev-token` is available only when all of the following are true:

- `ENABLE_DEV_AUTH=true`
- `APP_ENV != production`
- `VERCEL_ENV != production`

Response shape:

```json
{
  "accessToken": "supabase-access-token",
  "refreshToken": "supabase-refresh-token",
  "userId": "uuid"
}
```

The route signs into Supabase as a configured staging test user and returns a real
session. It does not mint fake JWTs.

## Required staging environment variables

Add these to the staging backend deployment:

```env
APP_ENV=staging
ENABLE_DEV_AUTH=true
SUPABASE_URL=https://<staging-project-ref>.supabase.co
SUPABASE_ANON_KEY=<staging-anon-key>
SUPABASE_SERVICE_ROLE_KEY=<staging-service-role-key-if-needed-else-existing-value>
```

Choose one configuration style for the test users.

### Preferred: JSON user map

```env
DEV_AUTH_USERS_JSON=[
  {
    "userId":"11111111-1111-1111-1111-111111111111",
    "email":"dev-primary@example.com",
    "password":"<password>"
  },
  {
    "userId":"22222222-2222-2222-2222-222222222222",
    "email":"dev-secondary@example.com",
    "password":"<password>"
  }
]
```

### Fallback: explicit env vars

```env
DEV_AUTH_DEFAULT_USER_ID=11111111-1111-1111-1111-111111111111
DEV_AUTH_DEFAULT_EMAIL=dev-primary@example.com
DEV_AUTH_DEFAULT_PASSWORD=<password>
DEV_AUTH_SECONDARY_USER_ID=22222222-2222-2222-2222-222222222222
DEV_AUTH_SECONDARY_EMAIL=dev-secondary@example.com
DEV_AUTH_SECONDARY_PASSWORD=<password>
```

## Supabase staging checklist

1. Create a dedicated staging Supabase project, or temporarily use the shared
   MealPlanner Supabase project as Veckly staging during the transition.
2. Apply the Veckly migrations.
3. Create at least one stable test user for the simulator path.
4. Optionally create a second member user for collaboration testing.
5. Seed a household with:
   - active membership
   - profile
   - current week data
   - shopping list data
   - at least one recipe
   - at least one member/invite scenario

## iOS values to fill in

Update these values in a local override file:

`/Users/nima/Documents/dev/Veckly/Veckly-ios/Config/DeveloperOverrides.xcconfig`

using:

- `VECKLY_STAGING_API_BASE_URL`
- `VECKLY_STAGING_SUPABASE_URL`
- `VECKLY_STAGING_SUPABASE_ANON_KEY`

Current placeholders are intentionally invalid so the simulator does not silently
talk to production. See:

`/Users/nima/Documents/dev/Veckly/Veckly-ios/Config/DeveloperOverrides.example.xcconfig`

## Verification

1. Deploy staging backend with `ENABLE_DEV_AUTH=true`.
2. Confirm `GET /health` returns `"devAuthEnabled": true` on staging.
3. In simulator/debug build, verify `Sign in as dev` is visible.
4. Tap `Sign in as dev` and confirm the app reaches the signed-in root.
5. Relaunch the app and verify the session restores.
6. Verify `Release` build hides the dev-login button.

## Failure modes

- `404 /auth/dev-token`: dev auth is disabled or mounted in a production-shaped env
- `500 DEV_AUTH_SIGN_IN_FAILED`: configured test-user credentials are wrong
- `500 DEV_AUTH_NOT_CONFIGURED`: no staging test users are configured
- iOS network failure immediately on debug build: staging URLs in `Base.xcconfig`
  still use placeholders
