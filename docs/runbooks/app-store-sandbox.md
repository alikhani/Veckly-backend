# App Store sandbox preparation runbook

This runbook prepares Veckly's App Store subscription chain without launching payments. The implementation is intentionally sandbox-only. It does not create a visible paywall, publish products, enable production transaction verification, or change `PREMIUM_GATES_ENABLED=false`.

## What is already implemented

- `POST /households/{householdId}/billing/app-store/transactions` authenticates the Veckly user, verifies active household membership, verifies Apple's JWS, requires the Veckly bundle/product identifiers, and requires `appAccountToken` to match the Supabase user.
- `POST /billing/app-store/notifications` accepts only verified App Store Server Notifications V2 from the sandbox environment and deduplicates by `notificationUUID`.
- Transaction, notification, and reconciliation paths normalize into the same provider-neutral subscription and household-entitlement records.
- A subscription may sponsor only one household. Changing sponsorship later requires an explicit product flow; replaying a transaction against another household returns a conflict.
- iOS sends `VerificationResult<Transaction>.jwsRepresentation` before finishing a verified transaction. Failed delivery remains unfinished so StoreKit can retry.

## App Store Connect preparation — do not publish

1. Create one auto-renewable subscription group named `Veckly Premium`.
2. Create the products without submitting them for review:
   - `com.nimaalikhani.Veckly.premium.monthly` — monthly, target price 69 SEK.
   - `com.nimaalikhani.Veckly.premium.yearly` — yearly, target price 549 SEK.
3. Add Swedish and English product localization and required review metadata.
4. Under App Store Server Notifications, choose V2 and configure the **sandbox URL only**:
   - `https://veckly-backend.vercel.app/billing/app-store/notifications`
5. Create an In-App Purchase key under Users and Access > Integrations. Do not commit the `.p8` file.

Creating these records does not make the paywall visible in Veckly. A commercial release still requires a separately approved app version and explicit rollout decision.

## Server configuration — sandbox only

The following Vercel values are required before an end-to-end TestFlight sandbox test:

- `APP_STORE_ROOT_CA_CERTIFICATES_BASE64`: comma-separated, base64-encoded DER root certificates downloaded from Apple's PKI page.
- `APP_STORE_ENABLE_ONLINE_CHECKS=true`: enables certificate expiration and revocation checks.
- `APP_STORE_KEY_ID`: In-App Purchase key identifier.
- `APP_STORE_ISSUER_ID`: issuer identifier from App Store Connect.
- `APP_STORE_PRIVATE_KEY_BASE64`: base64 of the `.p8` private-key contents.

The root certificates are enough for transaction and notification verification. The In-App Purchase key is additionally required for reconciliation calls to the App Store Server API.

Keep these rollout invariants:

- `PREMIUM_GATES_ENABLED=false`.
- No production App Store verifier or production notification URL.
- No paywall or purchase entry point visible to beta users.
- No migration or deployment is applied merely by following this preparation document; use the normal migration/deployment runbook in a separate release step.

## Sandbox verification checklist

1. Apply migration `0039_subscription_sponsorship_unique.sql` to the target non-production/staging database.
2. Deploy the backend with the sandbox variables above.
3. Send Apple's V2 test notification and confirm HTTP 200 plus one idempotent `billing_provider_events` row.
4. Buy monthly in a sandbox/TestFlight account and confirm:
   - transaction submit returns 200;
   - one `billing_subscriptions` row exists with provider `app_store` and environment `sandbox`;
   - exactly one household entitlement references it;
   - repeating the submit creates no duplicate rows.
5. Exercise restore, renewal, billing retry/grace, expiry, and revoke/refund in sandbox.
6. Run reconciliation and compare Apple status, normalized subscription status, and resolved household entitlement.
7. Confirm the app remains fully usable with gates off throughout the test.

Do not proceed to production credentials, a visible paywall, App Review submission, or gate activation without a new explicit go-live decision.
