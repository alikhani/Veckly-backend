import { describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import type { Db } from '../src/db.js'
import { fakeAccessToken } from './fake-access-token.js'

// A summary is null only when the household row is not visible after the
// membership check passed (a race with deletion). That cannot be set up through
// the database, so this file stubs membership and the summary reads.
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: {
      getUser: async (token: string) => {
        const payload = token.split('.')[1]
        const sub = payload ? (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: string }).sub : undefined
        return { data: { user: { id: sub } }, error: null }
      },
    },
  }),
}))
vi.mock('../src/membership.js', () => ({ assertMembership: async () => ({ id: 'membership' }) }))
vi.mock('../src/modules/week-plan/service.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/modules/week-plan/service.js')>(),
  getWeekPlanSummary: async () => null,
}))
vi.mock('../src/modules/shopping-list/service.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/modules/shopping-list/service.js')>(),
  getShoppingListSummary: async () => null,
}))

const householdId = '11111111-1111-4111-8111-111111111111'
const userId = '22222222-2222-4222-8222-222222222222'

function get(path: string) {
  return buildApp({} as Db).request(path, { headers: { Authorization: `Bearer ${fakeAccessToken(userId)}` } })
}

describe('summary reads when the household is not found', () => {
  it('answers the week-plan summary with 404 HOUSEHOLD_NOT_FOUND', async () => {
    const response = await get(`/households/${householdId}/week-plans/2026-06-08/summary`)
    expect({ status: response.status, body: await response.json() }).toEqual({ status: 404, body: { error: 'HOUSEHOLD_NOT_FOUND' } })
  })

  it('answers the shopping-list summary with 404 HOUSEHOLD_NOT_FOUND', async () => {
    const response = await get(`/households/${householdId}/shopping-lists/2026-06-08/summary`)
    expect({ status: response.status, body: await response.json() }).toEqual({ status: 404, body: { error: 'HOUSEHOLD_NOT_FOUND' } })
  })
})
