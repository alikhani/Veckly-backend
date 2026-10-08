import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { Db } from '../src/db.js'
import { ApiError, ErrorResponseSchema, errorResponses, requireMonday } from '../src/platform/http-errors.js'

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

describe('forward-compatible error contract', () => {
  const app = buildApp({} as Db)

  it('publishes ErrorResponse.error as an open enum so shipped clients decode codes added later', async () => {
    const spec = await (await app.request('/openapi.json')).json() as {
      components: { schemas: Record<string, { properties: Record<string, unknown> }> }
    }
    expect(spec.components.schemas.ErrorResponse!.properties.error).toEqual({
      anyOf: [{ $ref: '#/components/schemas/ErrorCode' }, { type: 'string' }],
    })
  })

  it('answers an unknown route with a JSON 404 body', async () => {
    const response = await app.request('/no-such-route')
    expect(response.status).toBe(404)
    expect(response.headers.get('Content-Type')).toContain('application/json')
    expect(await response.json()).toEqual({ error: 'ROUTE_NOT_FOUND' })
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
      throw new ApiError(404, 'NOT_MEMBER')
    })
    sub.get('/__test/stale', () => {
      throw new ApiError(409, 'STALE_WEEK_PLAN_STATE', { updatedAt: null })
    })
    sub.openapi(createRoute({
      method: 'post',
      path: '/__test/json',
      request: { body: { content: { 'application/json': { schema: z.object({ name: z.string() }) } } } },
      responses: { 200: { description: 'ok' } },
    }), (c) => c.json(c.req.valid('json'), 200))
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

  it('answers a malformed JSON body with 400 INVALID_JSON', async () => {
    const app = buildAppWithDummyRoutes()

    const response = await app.request('/__test/json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"name": ',
    })
    expect({ status: response.status, body: await response.json() }).toEqual({ status: 400, body: { error: 'INVALID_JSON' } })
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('still answers any other error with a generic 500', async () => {
    const app = buildAppWithDummyRoutes()

    const response = await app.request('/__test/crash')
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Internal server error' })
  })
})

describe('error contract', () => {
  it('builds { error } bodies from a code, with optional details', () => {
    expect(new ApiError(404, 'NOT_MEMBER').body).toEqual({ error: 'NOT_MEMBER' })
    expect(new ApiError(409, 'STALE_SHOPPING_STATE', { updatedAt: null }).body).toEqual({ error: 'STALE_SHOPPING_STATE', updatedAt: null })
    // @ts-expect-error an unknown code does not compile
    expect(new ApiError(404, 'SOMETHING_ELSE').body).toEqual({ error: 'SOMETHING_ELSE' })
  })

  it('passes a premium gate body through unchanged', () => {
    const gate = { error: 'PREMIUM_REQUIRED', reason: 'week_history' } as const
    expect(new ApiError(403, gate)).toMatchObject({ status: 403, body: gate })
  })

  it('builds ErrorResponse entries for createRoute', () => {
    expect(errorResponses({ 400: 'Invalid week', 404: 'Not a member' })).toEqual({
      400: { description: 'Invalid week', content: { 'application/json': { schema: ErrorResponseSchema } } },
      404: { description: 'Not a member', content: { 'application/json': { schema: ErrorResponseSchema } } },
    })
  })
})
