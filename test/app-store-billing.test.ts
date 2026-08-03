import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { Environment, Status, Type, type JWSTransactionDecodedPayload, type ResponseBodyV2DecodedPayload } from '@apple/app-store-server-library'
import {
  AppStoreBillingError,
  normalizeAppStoreTransaction,
  processAppStoreNotification,
  reconcileAppStoreSubscription,
  submitAppStoreTransaction,
  type AppStoreServerClient,
  type AppStoreVerifier,
} from '../src/app-store-billing.js'
import { createDb } from '../src/db.js'
import { billingProviderEvents, billingSubscriptions, householdEntitlements, householdMemberships, households } from '../src/schema.js'

const userA = '11111111-1111-4111-8111-111111111111'
const userB = '22222222-2222-4222-8222-222222222222'

function transaction(overrides: Partial<JWSTransactionDecodedPayload> = {}): JWSTransactionDecodedPayload {
  return {
    originalTransactionId: 'original-1',
    transactionId: 'transaction-1',
    bundleId: 'com.nimaalikhani.Veckly',
    productId: 'com.nimaalikhani.Veckly.premium.yearly',
    purchaseDate: Date.parse('2026-08-01T10:00:00Z'),
    expiresDate: Date.parse('2027-08-01T10:00:00Z'),
    type: Type.AUTO_RENEWABLE_SUBSCRIPTION,
    appAccountToken: userA,
    signedDate: Date.parse('2026-08-01T10:00:01Z'),
    environment: Environment.SANDBOX,
    ...overrides,
  }
}

function verifier(input: {
  transactions?: Record<string, JWSTransactionDecodedPayload>
  notifications?: Record<string, ResponseBodyV2DecodedPayload>
  renewals?: Record<string, object>
} = {}): AppStoreVerifier {
  return {
    verifyAndDecodeTransaction: vi.fn(async (signed) => {
      const decoded = input.transactions?.[signed]
      if (!decoded) throw new Error('bad transaction signature')
      return decoded
    }),
    verifyAndDecodeNotification: vi.fn(async (signed) => {
      const decoded = input.notifications?.[signed]
      if (!decoded) throw new Error('bad notification signature')
      return decoded
    }),
    verifyAndDecodeRenewalInfo: vi.fn(async (signed) => {
      const decoded = input.renewals?.[signed]
      if (!decoded) throw new Error('bad renewal signature')
      return decoded
    }),
  } as AppStoreVerifier
}

describe('App Store transaction validation', () => {
  it('accepts only the locked sandbox product and matching app account token', () => {
    const normalized = normalizeAppStoreTransaction(transaction(), userA, undefined, undefined, new Date('2026-08-02'))
    expect(normalized).toMatchObject({
      originalTransactionId: 'original-1',
      productId: 'com.nimaalikhani.Veckly.premium.yearly',
      ownerUserId: userA,
      environment: 'sandbox',
      status: 'active',
    })
  })

  it.each([
    ['production environment', { environment: Environment.PRODUCTION }],
    ['foreign product', { productId: 'com.example.premium' }],
    ['foreign user', { appAccountToken: userB }],
    ['malformed app account token', { appAccountToken: 'not-a-uuid' }],
  ])('rejects %s', (_, overrides) => {
    expect(() => normalizeAppStoreTransaction(transaction(overrides), userA)).toThrow(AppStoreBillingError)
  })
})

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const describeWithDb = testDatabaseUrl ? describe : describe.skip

describeWithDb('App Store sandbox persistence', () => {
  const db = createDb(testDatabaseUrl!)
  let householdAId: string
  let householdBId: string

  beforeEach(async () => {
    await db.execute(sql`delete from "billing_provider_events"`)
    await db.execute(sql`delete from "household_entitlements"`)
    await db.execute(sql`delete from "billing_subscriptions"`)
    await db.execute(sql`delete from "household_memberships"`)
    await db.execute(sql`delete from "households"`)
    const [householdA] = await db.insert(households).values({ name: 'Household A' }).returning()
    const [householdB] = await db.insert(households).values({ name: 'Household B' }).returning()
    householdAId = householdA!.id
    householdBId = householdB!.id
    await db.insert(householdMemberships).values([
      { householdId: householdAId, userId: userA, role: 'owner', status: 'active' },
      { householdId: householdBId, userId: userA, role: 'owner', status: 'active' },
    ])
  })

  afterAll(async () => {
    await db.execute(sql`delete from "billing_provider_events"`)
    await db.execute(sql`delete from "household_entitlements"`)
    await db.execute(sql`delete from "billing_subscriptions"`)
    await db.execute(sql`delete from "household_memberships"`)
    await db.execute(sql`delete from "households"`)
  })

  it('attaches a verified transaction idempotently to one household', async () => {
    const signedDataVerifier = verifier({ transactions: { valid: transaction() } })
    const first = await submitAppStoreTransaction(db, signedDataVerifier, {
      signedTransaction: 'valid', userId: userA, householdId: householdAId,
    })
    const second = await submitAppStoreTransaction(db, signedDataVerifier, {
      signedTransaction: 'valid', userId: userA, householdId: householdAId,
    })

    expect(first.duplicate).toBe(false)
    expect(second.duplicate).toBe(true)
    expect(await db.select().from(billingSubscriptions)).toHaveLength(1)
    expect(await db.select().from(householdEntitlements)).toHaveLength(1)
    expect(await db.select().from(billingProviderEvents)).toHaveLength(1)
  })

  it('never silently moves an existing subscription to another household', async () => {
    const signedDataVerifier = verifier({ transactions: { valid: transaction() } })
    await submitAppStoreTransaction(db, signedDataVerifier, {
      signedTransaction: 'valid', userId: userA, householdId: householdAId,
    })

    await expect(submitAppStoreTransaction(db, signedDataVerifier, {
      signedTransaction: 'valid', userId: userA, householdId: householdBId,
    })).rejects.toMatchObject({ code: 'HOUSEHOLD_CONFLICT' })
  })

  it('updates a known entitlement from an idempotent grace-period notification', async () => {
    const initialVerifier = verifier({ transactions: { valid: transaction() } })
    await submitAppStoreTransaction(db, initialVerifier, {
      signedTransaction: 'valid', userId: userA, householdId: householdAId,
    })

    const renewalTransaction = transaction({
      transactionId: 'transaction-2',
      signedDate: Date.parse('2027-08-01T10:00:01Z'),
      expiresDate: Date.parse('2027-08-01T10:00:00Z'),
    })
    const notification: ResponseBodyV2DecodedPayload = {
      notificationUUID: 'notification-1',
      notificationType: 'DID_FAIL_TO_RENEW',
      subtype: 'GRACE_PERIOD',
      signedDate: Date.parse('2027-08-01T10:00:02Z'),
      data: {
        environment: Environment.SANDBOX,
        bundleId: 'com.nimaalikhani.Veckly',
        status: Status.BILLING_GRACE_PERIOD,
        signedTransactionInfo: 'renewal-transaction',
        signedRenewalInfo: 'renewal-info',
      },
    }
    const notificationVerifier = verifier({
      transactions: { 'renewal-transaction': renewalTransaction },
      notifications: { notification },
      renewals: { 'renewal-info': { gracePeriodExpiresDate: Date.parse('2027-08-17T10:00:00Z'), autoRenewStatus: 1 } },
    })

    const first = await processAppStoreNotification(db, notificationVerifier, 'notification')
    const second = await processAppStoreNotification(db, notificationVerifier, 'notification')
    const [subscription] = await db.select().from(billingSubscriptions)
    const [entitlement] = await db.select().from(householdEntitlements)

    expect(first.duplicate).toBe(false)
    expect(second.duplicate).toBe(true)
    expect(subscription?.status).toBe('grace_period')
    expect(subscription?.currentPeriodEndsAt?.toISOString()).toBe('2027-08-17T10:00:00.000Z')
    expect(entitlement?.endsAt?.toISOString()).toBe('2027-08-17T10:00:00.000Z')
    expect(await db.select().from(billingProviderEvents)).toHaveLength(2)
  })

  it('reconciles existing state through the sandbox server API response', async () => {
    const initialVerifier = verifier({ transactions: { valid: transaction() } })
    await submitAppStoreTransaction(db, initialVerifier, {
      signedTransaction: 'valid', userId: userA, householdId: householdAId,
    })
    const expired = transaction({
      transactionId: 'transaction-expired',
      expiresDate: Date.parse('2026-08-02T10:00:00Z'),
      signedDate: Date.parse('2026-08-03T10:00:00Z'),
    })
    const reconciliationVerifier = verifier({ transactions: { expired } })
    const client: AppStoreServerClient = {
      getAllSubscriptionStatuses: vi.fn(async () => ({
        environment: Environment.SANDBOX,
        data: [{ lastTransactions: [{
          originalTransactionId: 'original-1',
          status: Status.EXPIRED,
          signedTransactionInfo: 'expired',
        }] }],
      })),
    }

    await reconcileAppStoreSubscription(db, client, reconciliationVerifier, 'original-1')
    const [subscription] = await db.select().from(billingSubscriptions).where(eq(billingSubscriptions.externalId, 'original-1'))
    expect(subscription?.status).toBe('expired')
  })
})
