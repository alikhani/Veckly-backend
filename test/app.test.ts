import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { Db } from '../src/db.js'

describe('app-level HTTP contracts', () => {
  const app = buildApp({} as Db)

  it('defaults API responses to no-store', async () => {
    const response = await app.request('/health')

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('serves the current entitlement contract without CDN caching', async () => {
    const response = await app.request('/openapi.json')
    const spec = await response.json() as { paths: Record<string, unknown> }

    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(spec.paths).toHaveProperty('/users/me/entitlement')
    expect(spec.paths).toHaveProperty('/households/{householdId}/entitlement')
    expect(spec.paths).toHaveProperty('/households/{householdId}/billing/app-store/transactions')
    expect(spec.paths).toHaveProperty('/billing/app-store/notifications')
  })

  it('keeps transaction submission authenticated and sandbox verification fail-closed', async () => {
    const transactionResponse = await app.request('/households/11111111-1111-4111-8111-111111111111/billing/app-store/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signedTransaction: 'unverified' }),
    })
    const notificationResponse = await app.request('/billing/app-store/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signedPayload: 'unverified' }),
    })

    expect(transactionResponse.status).toBe(401)
    expect(notificationResponse.status).toBe(503)
  })
})
