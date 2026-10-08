import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { Db } from '../src/db.js'
import { ApiError, requireMonday } from '../src/platform/http-errors.js'

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

  it('publishes read, upsert, and clear contracts for week-specific context', async () => {
    const response = await app.request('/openapi.json')
    const spec = await response.json() as {
      paths: Record<string, Record<string, { operationId?: string }>>
    }
    const collection = spec.paths['/households/{householdId}/week-plans/{weekStartDate}/context-overrides']
    const item = spec.paths['/households/{householdId}/week-plans/{weekStartDate}/context-overrides/{date}']

    expect(collection?.get?.operationId).toBe('getWeekContextOverrides')
    expect(item?.put?.operationId).toBe('upsertWeekContextOverride')
    expect(item?.delete?.operationId).toBe('clearWeekContextOverride')
  })
})

describe('ApiError mapping', () => {
  // Mirrors how feature modules mount: an OpenAPIHono sub-app with its own
  // middleware, no `onError` of its own, mounted with `app.route('/', ...)`.
  function buildAppWithDummyRoutes() {
    const app = buildApp({} as Db)
    const sub = new OpenAPIHono()
    sub.use('/__test/*', async (_c, next) => { await next() })
    sub.openapi(createRoute({
      method: 'get',
      path: '/__test/api-error/{week}',
      request: { params: z.object({ week: z.string() }) },
      responses: { 200: { description: 'ok' } },
    }), (c) => {
      const { week } = c.req.valid('param')
      requireMonday(week, { status: 422, code: 'NO_COMPLETED_WEEK' })
      throw new ApiError(404, { error: 'NOT_MEMBER' })
    })
    sub.get('/__test/stale', () => {
      throw new ApiError(409, { error: 'STALE_WEEK_PLAN_STATE', updatedAt: null })
    })
    sub.get('/__test/crash', () => {
      throw new Error('boom')
    })
    app.route('/', sub)
    return app
  }

  it('maps an ApiError thrown in a mounted sub-app route to its status and body', async () => {
    const app = buildAppWithDummyRoutes()

    const notMember = await app.request('/__test/api-error/2026-06-08')
    expect(notMember.status).toBe(404)
    expect(await notMember.json()).toEqual({ error: 'NOT_MEMBER' })
    expect(notMember.headers.get('Cache-Control')).toBe('no-store')

    const notMonday = await app.request('/__test/api-error/2026-06-09')
    expect(notMonday.status).toBe(422)
    expect(await notMonday.json()).toEqual({ error: 'NO_COMPLETED_WEEK' })

    const stale = await app.request('/__test/stale')
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({ error: 'STALE_WEEK_PLAN_STATE', updatedAt: null })
  })

  it('still answers any other error with a generic 500', async () => {
    const app = buildAppWithDummyRoutes()

    const response = await app.request('/__test/crash')
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Internal server error' })
  })
})
