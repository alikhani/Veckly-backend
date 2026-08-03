import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import {
  AppStoreBillingError,
  createSandboxAppStoreVerifierFromEnv,
  processAppStoreNotification,
  submitAppStoreTransaction,
  type AppStoreVerifier,
} from './app-store-billing.js'
import { requireAuth, type AuthedUser } from './auth.js'
import type { Db } from './db.js'
import { resolveEntitlementForHousehold } from './entitlements.js'
import { assertMembership } from './membership.js'

const HouseholdParamsSchema = z.object({ householdId: z.string().uuid() })
const ErrorSchema = z.object({ error: z.string(), code: z.string().optional() })
const TransactionSubmitSchema = z.object({
  signedTransaction: z.string().min(1).max(100_000),
}).openapi('AppStoreTransactionSubmit')
const NotificationSchema = z.object({
  signedPayload: z.string().min(1).max(500_000),
}).openapi('AppStoreServerNotification')
const SubmitResponseSchema = z.object({
  accepted: z.literal(true),
  duplicate: z.boolean(),
  environment: z.literal('sandbox'),
  entitlement: z.object({
    tier: z.enum(['free', 'premium']),
    householdId: z.string().uuid().nullable(),
    source: z.enum(['subscription', 'manual', 'beta']).nullable(),
    gatesEnabled: z.boolean(),
  }),
}).openapi('AppStoreTransactionSubmitResponse')

const submitTransactionRoute = createRoute({
  method: 'post',
  path: '/households/{householdId}/billing/app-store/transactions',
  operationId: 'submitAppStoreTransaction',
  summary: 'Verify and attach an App Store sandbox transaction to a household',
  security: [{ bearerAuth: [] }],
  request: {
    params: HouseholdParamsSchema,
    body: { required: true, content: { 'application/json': { schema: TransactionSubmitSchema } } },
  },
  responses: {
    200: { description: 'Verified sandbox transaction accepted idempotently', content: { 'application/json': { schema: SubmitResponseSchema } } },
    400: { description: 'Malformed or unverified App Store transaction', content: { 'application/json': { schema: ErrorSchema } } },
    401: { description: 'Missing or invalid session' },
    404: { description: 'Household not found or caller is not a member' },
    409: { description: 'Transaction ownership or household sponsorship conflict', content: { 'application/json': { schema: ErrorSchema } } },
    503: { description: 'App Store sandbox verification is not configured', content: { 'application/json': { schema: ErrorSchema } } },
  },
})

const notificationRoute = createRoute({
  method: 'post',
  path: '/billing/app-store/notifications',
  operationId: 'receiveAppStoreServerNotification',
  summary: 'Receive a signed App Store Server Notification V2 in sandbox mode',
  request: {
    body: { required: true, content: { 'application/json': { schema: NotificationSchema } } },
  },
  responses: {
    200: { description: 'Verified notification accepted idempotently' },
    400: { description: 'Malformed or unverified App Store notification', content: { 'application/json': { schema: ErrorSchema } } },
    503: { description: 'App Store sandbox verification is not configured', content: { 'application/json': { schema: ErrorSchema } } },
  },
})

function billingErrorResponse(error: unknown) {
  if (!(error instanceof AppStoreBillingError)) return null
  switch (error.code) {
  case 'NOT_CONFIGURED': return { status: 503 as const, body: { error: 'App Store sandbox billing is not configured', code: error.code } }
  case 'OWNER_MISMATCH':
  case 'HOUSEHOLD_CONFLICT': return { status: 409 as const, body: { error: error.message, code: error.code } }
  default: return { status: 400 as const, body: { error: error.message, code: error.code } }
  }
}

export function buildAppStoreBillingRoutes(
  db: Db,
  getVerifier: () => AppStoreVerifier = createSandboxAppStoreVerifierFromEnv,
) {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()

  app.use('/households/*', requireAuth)
  app.openapi(submitTransactionRoute, async (c) => {
    const { householdId } = c.req.valid('param')
    const { signedTransaction } = c.req.valid('json')
    const user = c.get('user')
    const membership = await assertMembership(db, c.get('accessToken'), householdId, user.id)
    if (!membership) return c.json({ error: 'Household not found' }, 404)

    try {
      const result = await submitAppStoreTransaction(db, getVerifier(), { signedTransaction, userId: user.id, householdId })
      const entitlement = await resolveEntitlementForHousehold(db, user.id, householdId)
      return c.json({ accepted: true as const, duplicate: result.duplicate, environment: 'sandbox' as const, entitlement }, 200)
    } catch (error) {
      const response = billingErrorResponse(error)
      if (response) return c.json(response.body, response.status)
      throw error
    }
  })

  app.openapi(notificationRoute, async (c) => {
    try {
      await processAppStoreNotification(db, getVerifier(), c.req.valid('json').signedPayload)
      return c.body(null, 200)
    } catch (error) {
      const response = billingErrorResponse(error)
      if (response) return c.json(response.body, response.status)
      throw error
    }
  })

  return app
}
