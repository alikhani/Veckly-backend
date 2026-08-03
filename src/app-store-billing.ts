import {
  AppStoreServerAPIClient,
  Environment,
  SignedDataVerifier,
  Status,
  Type,
  type JWSTransactionDecodedPayload,
  type JWSRenewalInfoDecodedPayload,
  type ResponseBodyV2DecodedPayload,
} from '@apple/app-store-server-library'
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from './db.js'
import { billingProviderEvents, billingSubscriptions, householdEntitlements } from './schema.js'

export const APP_STORE_BUNDLE_ID = 'com.nimaalikhani.Veckly'
export const APP_STORE_PREMIUM_PRODUCT_IDS = new Set([
  'com.nimaalikhani.Veckly.premium.monthly',
  'com.nimaalikhani.Veckly.premium.yearly',
])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type BillingSubscriptionStatus = 'active' | 'grace_period' | 'expired' | 'cancelled' | 'revoked'

export type AppStoreVerifier = Pick<SignedDataVerifier,
  'verifyAndDecodeTransaction' | 'verifyAndDecodeRenewalInfo' | 'verifyAndDecodeNotification'>

export type AppStoreServerClient = Pick<AppStoreServerAPIClient, 'getAllSubscriptionStatuses'>

export class AppStoreBillingError extends Error {
  constructor(
    readonly code:
      | 'NOT_CONFIGURED'
      | 'INVALID_TRANSACTION'
      | 'INVALID_NOTIFICATION'
      | 'OWNER_MISMATCH'
      | 'HOUSEHOLD_CONFLICT'
      | 'SUBSCRIPTION_NOT_FOUND',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

type NormalizedTransaction = {
  originalTransactionId: string
  transactionId: string
  productId: string
  ownerUserId: string
  environment: 'sandbox'
  startsAt: Date
  periodEndsAt: Date
  signedDate: number
  status: BillingSubscriptionStatus
  providerMetadata: Record<string, unknown>
}

type PersistInput = {
  transaction: NormalizedTransaction
  eventId: string
  eventPayload: Record<string, unknown>
  householdId?: string
}

function requiredString(value: string | undefined, field: string) {
  if (!value) throw new AppStoreBillingError('INVALID_TRANSACTION', `Verified App Store transaction is missing ${field}`)
  return value
}

function requiredTimestamp(value: number | undefined, field: string) {
  if (!Number.isFinite(value)) throw new AppStoreBillingError('INVALID_TRANSACTION', `Verified App Store transaction is missing ${field}`)
  return value!
}

function statusFromTransaction(transaction: JWSTransactionDecodedPayload, now: Date): BillingSubscriptionStatus {
  if (transaction.revocationDate !== undefined) return 'revoked'
  const expiresAt = new Date(requiredTimestamp(transaction.expiresDate, 'expiresDate'))
  return expiresAt > now ? 'active' : 'expired'
}

function statusFromAppleStatus(status: Status | number | undefined, fallback: BillingSubscriptionStatus): BillingSubscriptionStatus {
  switch (status) {
  case Status.ACTIVE: return 'active'
  case Status.EXPIRED: return 'expired'
  case Status.BILLING_RETRY: return 'expired'
  case Status.BILLING_GRACE_PERIOD: return 'grace_period'
  case Status.REVOKED: return 'revoked'
  default: return fallback
  }
}

export function normalizeAppStoreTransaction(
  transaction: JWSTransactionDecodedPayload,
  expectedOwnerUserId?: string,
  appleStatus?: Status | number,
  renewalInfo?: JWSRenewalInfoDecodedPayload,
  now = new Date(),
): NormalizedTransaction {
  if (transaction.bundleId !== APP_STORE_BUNDLE_ID) {
    throw new AppStoreBillingError('INVALID_TRANSACTION', 'App Store transaction has the wrong bundle identifier')
  }
  if (transaction.environment !== Environment.SANDBOX) {
    throw new AppStoreBillingError('INVALID_TRANSACTION', 'Only App Store sandbox transactions are enabled')
  }
  if (transaction.type !== Type.AUTO_RENEWABLE_SUBSCRIPTION) {
    throw new AppStoreBillingError('INVALID_TRANSACTION', 'App Store transaction is not an auto-renewable subscription')
  }

  const productId = requiredString(transaction.productId, 'productId')
  if (!APP_STORE_PREMIUM_PRODUCT_IDS.has(productId)) {
    throw new AppStoreBillingError('INVALID_TRANSACTION', 'App Store transaction has an unknown product identifier')
  }

  const ownerUserId = requiredString(transaction.appAccountToken, 'appAccountToken').toLowerCase()
  if (!UUID_PATTERN.test(ownerUserId)) {
    throw new AppStoreBillingError('INVALID_TRANSACTION', 'App Store transaction has an invalid appAccountToken')
  }
  if (expectedOwnerUserId && ownerUserId !== expectedOwnerUserId.toLowerCase()) {
    throw new AppStoreBillingError('OWNER_MISMATCH', 'App Store transaction belongs to another Veckly user')
  }

  const originalTransactionId = requiredString(transaction.originalTransactionId, 'originalTransactionId')
  const transactionId = requiredString(transaction.transactionId, 'transactionId')
  const purchaseDate = requiredTimestamp(transaction.purchaseDate, 'purchaseDate')
  const expiresDate = requiredTimestamp(transaction.expiresDate, 'expiresDate')
  const signedDate = requiredTimestamp(transaction.signedDate, 'signedDate')
  const fallbackStatus = statusFromTransaction(transaction, now)
  const status = statusFromAppleStatus(appleStatus, fallbackStatus)
  const gracePeriodEndsAt = renewalInfo?.gracePeriodExpiresDate
  const periodEndsAt = status === 'grace_period' && gracePeriodEndsAt
    ? new Date(gracePeriodEndsAt)
    : new Date(expiresDate)

  return {
    originalTransactionId,
    transactionId,
    productId,
    ownerUserId,
    environment: 'sandbox',
    startsAt: new Date(purchaseDate),
    periodEndsAt,
    signedDate,
    status,
    providerMetadata: {
      latestTransactionId: transactionId,
      signedDate,
      autoRenewStatus: renewalInfo?.autoRenewStatus ?? null,
      isInBillingRetryPeriod: renewalInfo?.isInBillingRetryPeriod ?? false,
      storefront: transaction.storefront ?? null,
      transactionReason: transaction.transactionReason ?? null,
      revocationDate: transaction.revocationDate ?? null,
    },
  }
}

function metadataSignedDate(value: unknown) {
  if (!value || typeof value !== 'object' || !('signedDate' in value)) return 0
  const signedDate = (value as { signedDate?: unknown }).signedDate
  return typeof signedDate === 'number' ? signedDate : 0
}

export async function persistAppStoreTransaction(db: Db, input: PersistInput) {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db
    const normalized = input.transaction
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${normalized.originalTransactionId}, 0))`)

    const [duplicateEvent] = await tx.select({ id: billingProviderEvents.id })
      .from(billingProviderEvents)
      .where(and(
        eq(billingProviderEvents.provider, 'app_store'),
        eq(billingProviderEvents.providerEventId, input.eventId),
      ))
      .limit(1)

    const [existing] = await tx.select().from(billingSubscriptions).where(and(
      eq(billingSubscriptions.provider, 'app_store'),
      eq(billingSubscriptions.externalId, normalized.originalTransactionId),
    )).limit(1)

    if (existing && existing.ownerUserId.toLowerCase() !== normalized.ownerUserId) {
      throw new AppStoreBillingError('OWNER_MISMATCH', 'Subscription is already linked to another Veckly user')
    }

    let subscription = existing
    if (!subscription) {
      const [created] = await tx.insert(billingSubscriptions).values({
        provider: 'app_store',
        ownerUserId: normalized.ownerUserId,
        externalId: normalized.originalTransactionId,
        productId: normalized.productId,
        status: normalized.status,
        currentPeriodEndsAt: normalized.periodEndsAt,
        environment: normalized.environment,
        providerMetadata: normalized.providerMetadata,
      }).returning()
      if (!created) throw new Error('App Store subscription insert did not return a row')
      subscription = created
    } else if (normalized.signedDate >= metadataSignedDate(subscription.providerMetadata)) {
      const [updated] = await tx.update(billingSubscriptions).set({
        productId: normalized.productId,
        status: normalized.status,
        currentPeriodEndsAt: normalized.periodEndsAt,
        environment: normalized.environment,
        providerMetadata: normalized.providerMetadata,
        updatedAt: new Date(),
      }).where(eq(billingSubscriptions.id, subscription.id)).returning()
      subscription = updated ?? subscription
    }
    if (!subscription) throw new Error('App Store subscription persistence did not produce a row')

    const [existingEntitlement] = await tx.select().from(householdEntitlements)
      .where(eq(householdEntitlements.subscriptionId, subscription.id))
      .limit(1)

    if (input.householdId && existingEntitlement && existingEntitlement.householdId !== input.householdId) {
      throw new AppStoreBillingError('HOUSEHOLD_CONFLICT', 'Subscription already sponsors another household')
    }

    const entitlementEndsAt = subscription.currentPeriodEndsAt ?? normalized.periodEndsAt
    const entitlementRevokedAt = subscription.status === 'revoked' ? new Date() : null

    if (existingEntitlement) {
      await tx.update(householdEntitlements).set({
        endsAt: entitlementEndsAt,
        revokedAt: entitlementRevokedAt,
        metadata: { provider: 'app_store', environment: normalized.environment },
        updatedAt: new Date(),
      }).where(eq(householdEntitlements.id, existingEntitlement.id))
    } else if (input.householdId) {
      await tx.insert(householdEntitlements).values({
        householdId: input.householdId,
        subscriptionId: subscription.id,
        source: 'subscription',
        startsAt: normalized.startsAt,
        endsAt: entitlementEndsAt,
        revokedAt: entitlementRevokedAt,
        metadata: { provider: 'app_store', environment: normalized.environment },
      })
    }

    if (!duplicateEvent) {
      await tx.insert(billingProviderEvents).values({
        provider: 'app_store',
        providerEventId: input.eventId,
        subscriptionId: subscription.id,
        payload: input.eventPayload,
      })
    }

    return { subscriptionId: subscription.id, duplicate: Boolean(duplicateEvent) }
  })
}

export function createSandboxAppStoreVerifierFromEnv(): AppStoreVerifier {
  const encodedRoots = process.env.APP_STORE_ROOT_CA_CERTIFICATES_BASE64
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean) ?? []
  if (encodedRoots.length === 0) {
    throw new AppStoreBillingError('NOT_CONFIGURED', 'App Store root certificates are not configured')
  }

  return new SignedDataVerifier(
    encodedRoots.map((value) => Buffer.from(value, 'base64')),
    process.env.APP_STORE_ENABLE_ONLINE_CHECKS !== 'false',
    Environment.SANDBOX,
    APP_STORE_BUNDLE_ID,
  )
}

export function createSandboxAppStoreServerClientFromEnv(): AppStoreServerClient {
  const keyId = process.env.APP_STORE_KEY_ID
  const issuerId = process.env.APP_STORE_ISSUER_ID
  const privateKeyBase64 = process.env.APP_STORE_PRIVATE_KEY_BASE64
  if (!keyId || !issuerId || !privateKeyBase64) {
    throw new AppStoreBillingError('NOT_CONFIGURED', 'App Store Server API credentials are not configured')
  }
  return new AppStoreServerAPIClient(
    Buffer.from(privateKeyBase64, 'base64').toString('utf8'),
    keyId,
    issuerId,
    APP_STORE_BUNDLE_ID,
    Environment.SANDBOX,
  )
}

export async function submitAppStoreTransaction(
  db: Db,
  verifier: AppStoreVerifier,
  input: { signedTransaction: string; userId: string; householdId: string },
) {
  let decoded: JWSTransactionDecodedPayload
  try {
    decoded = await verifier.verifyAndDecodeTransaction(input.signedTransaction)
  } catch (error) {
    throw new AppStoreBillingError('INVALID_TRANSACTION', 'App Store transaction signature could not be verified', { cause: error })
  }
  const normalized = normalizeAppStoreTransaction(decoded, input.userId)
  return persistAppStoreTransaction(db, {
    transaction: normalized,
    householdId: input.householdId,
    eventId: `transaction:${normalized.transactionId}`,
    eventPayload: {
      kind: 'transaction_submit',
      transactionId: normalized.transactionId,
      originalTransactionId: normalized.originalTransactionId,
      productId: normalized.productId,
      signedDate: normalized.signedDate,
      environment: normalized.environment,
    },
  })
}

async function recordNotificationWithoutTransaction(db: Db, notification: ResponseBodyV2DecodedPayload) {
  const eventId = requiredString(notification.notificationUUID, 'notificationUUID')
  await db.insert(billingProviderEvents).values({
    provider: 'app_store',
    providerEventId: eventId,
    payload: {
      kind: 'server_notification',
      notificationType: notification.notificationType ?? null,
      subtype: notification.subtype ?? null,
      signedDate: notification.signedDate ?? null,
      environment: notification.data?.environment ?? null,
    },
  }).onConflictDoNothing()
}

export async function processAppStoreNotification(db: Db, verifier: AppStoreVerifier, signedPayload: string) {
  let notification: ResponseBodyV2DecodedPayload
  try {
    notification = await verifier.verifyAndDecodeNotification(signedPayload)
  } catch (error) {
    throw new AppStoreBillingError('INVALID_NOTIFICATION', 'App Store notification signature could not be verified', { cause: error })
  }

  if (notification.data?.environment !== Environment.SANDBOX) {
    throw new AppStoreBillingError('INVALID_NOTIFICATION', 'Only App Store sandbox notifications are enabled')
  }
  const notificationId = requiredString(notification.notificationUUID, 'notificationUUID')
  const signedTransaction = notification.data.signedTransactionInfo
  if (!signedTransaction) {
    await recordNotificationWithoutTransaction(db, notification)
    return { duplicate: false, notificationType: notification.notificationType ?? null }
  }

  let decodedTransaction: JWSTransactionDecodedPayload
  let renewalInfo: JWSRenewalInfoDecodedPayload | undefined
  try {
    decodedTransaction = await verifier.verifyAndDecodeTransaction(signedTransaction)
    if (notification.data.signedRenewalInfo) {
      renewalInfo = await verifier.verifyAndDecodeRenewalInfo(notification.data.signedRenewalInfo)
    }
  } catch (error) {
    throw new AppStoreBillingError('INVALID_NOTIFICATION', 'Nested App Store notification data could not be verified', { cause: error })
  }

  const normalized = normalizeAppStoreTransaction(decodedTransaction, undefined, notification.data.status, renewalInfo)
  const result = await persistAppStoreTransaction(db, {
    transaction: normalized,
    eventId: notificationId,
    eventPayload: {
      kind: 'server_notification',
      notificationType: notification.notificationType ?? null,
      subtype: notification.subtype ?? null,
      transactionId: normalized.transactionId,
      originalTransactionId: normalized.originalTransactionId,
      signedDate: notification.signedDate ?? normalized.signedDate,
      environment: normalized.environment,
    },
  })
  return { ...result, notificationType: notification.notificationType ?? null }
}

export async function reconcileAppStoreSubscription(
  db: Db,
  client: AppStoreServerClient,
  verifier: AppStoreVerifier,
  originalTransactionId: string,
) {
  const [subscription] = await db.select().from(billingSubscriptions).where(and(
    eq(billingSubscriptions.provider, 'app_store'),
    eq(billingSubscriptions.externalId, originalTransactionId),
  )).limit(1)
  if (!subscription) throw new AppStoreBillingError('SUBSCRIPTION_NOT_FOUND', 'App Store subscription was not found')

  const response = await client.getAllSubscriptionStatuses(originalTransactionId)
  if (response.environment !== Environment.SANDBOX) {
    throw new AppStoreBillingError('INVALID_TRANSACTION', 'Only App Store sandbox reconciliation is enabled')
  }
  const candidates = response.data?.flatMap((group) => group.lastTransactions ?? []) ?? []
  const candidate = candidates.find((item) => item.originalTransactionId === originalTransactionId)
  if (!candidate?.signedTransactionInfo) {
    throw new AppStoreBillingError('INVALID_TRANSACTION', 'App Store reconciliation returned no signed transaction')
  }

  const decoded = await verifier.verifyAndDecodeTransaction(candidate.signedTransactionInfo)
  const renewalInfo = candidate.signedRenewalInfo
    ? await verifier.verifyAndDecodeRenewalInfo(candidate.signedRenewalInfo)
    : undefined
  const normalized = normalizeAppStoreTransaction(decoded, subscription.ownerUserId, candidate.status, renewalInfo)
  return persistAppStoreTransaction(db, {
    transaction: normalized,
    eventId: `reconciliation:${normalized.transactionId}:${normalized.signedDate}`,
    eventPayload: {
      kind: 'reconciliation',
      transactionId: normalized.transactionId,
      originalTransactionId: normalized.originalTransactionId,
      signedDate: normalized.signedDate,
      environment: normalized.environment,
    },
  })
}
