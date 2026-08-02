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
  })
})
