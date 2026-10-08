import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { Db } from '../src/db.js'

// Every status a week-plan or shopping-list route can answer must be declared
// under `responses`, because that is what the generated iOS client sees.
//
// 400 comes from request validation (INVALID_REQUEST, plus INVALID_JSON on
// routes with a body) and from the Monday/date checks; 401 from requireAuth;
// 404 from requireHouseholdMember and not-found reads; 403 from premium gates;
// 409/422 from use-case results.
const expectedErrorStatuses: Record<string, number[]> = {
  // week-plan
  appendWeekPlanEvent: [400, 401, 404],
  getWeekPlan: [400, 401, 404],
  getWeekPlanSummary: [400, 401, 404],
  previewWeekRescue: [400, 401, 404, 409, 422],
  applyWeekRescue: [400, 401, 404, 409, 422],
  previewPreviousWeekProposal: [400, 401, 404, 409, 422],
  applyPreviousWeekProposal: [400, 401, 404, 409, 422],
  getWeekContextOverrides: [400, 401, 404],
  upsertWeekContextOverride: [400, 401, 404],
  clearWeekContextOverride: [400, 401, 404],
  listWeekHistoryPlans: [400, 401, 403, 404],
  getWeekHistoryPlan: [400, 401, 404],
  upsertWeekHistoryPlan: [400, 401, 404, 409],
  generateWeekPlan: [400, 401, 403, 404, 422],
  finalizeWeekHistoryPlan: [400, 401, 404],
  // shopping-list
  appendShoppingListEvent: [400, 401, 404],
  getShoppingList: [400, 401, 404],
  getShoppingListSummary: [400, 401, 404],
  getShoppingListState: [400, 401, 404],
  updateShoppingListState: [400, 401, 404, 409],
}

const modules = ['week-plan', 'shopping-list']
const moduleDir = (name: string) => path.resolve(import.meta.dirname, '../src/modules', name)

type TOperation = { operationId?: string; responses: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }> }

async function moduleOperations() {
  const spec = await (await buildApp({} as Db).request('/openapi.json')).json() as { paths: Record<string, Record<string, TOperation>> }
  const operations = new Map<string, TOperation>()
  for (const [route, methods] of Object.entries(spec.paths)) {
    if (!/\/(week-plans|shopping-lists)(\/|$)/.test(route)) continue
    for (const operation of Object.values(methods)) operations.set(operation.operationId!, operation)
  }
  return operations
}

// Statuses each handler can throw, read from the source: literal
// `ApiError(<status>` / `status: <status>`, plus the helpers that throw.
const helperStatuses: Record<string, number[]> = {
  requireHouseholdMember: [404],
  staleOrUnprocessable: [409, 422],
}

function thrownStatusesByOperation() {
  const byOperation = new Map<string, Set<number>>()
  for (const name of modules) {
    const source = readFileSync(path.join(moduleDir(name), 'routes.ts'), 'utf8')
    const operationIdByRoute = new Map<string, string>()
    for (const match of source.matchAll(/const (\w+) = createRoute\(\{[\s\S]*?operationId: '(\w+)'/g)) operationIdByRoute.set(match[1]!, match[2]!)
    const handlers = source.split(/\n  app\.openapi\(/).slice(1)
    expect(handlers.length).toBe(operationIdByRoute.size)
    for (const handler of handlers) {
      const operationId = operationIdByRoute.get(handler.slice(0, handler.indexOf(',')))!
      const statuses = new Set<number>()
      for (const match of handler.matchAll(/(?:new ApiError\(|status: )(\d{3})/g)) statuses.add(Number(match[1]))
      for (const [helper, helperCodes] of Object.entries(helperStatuses)) {
        if (handler.includes(`${helper}(`)) helperCodes.forEach((status) => statuses.add(status))
      }
      byOperation.set(operationId, statuses)
    }
  }
  return byOperation
}

describe('declared error responses for week-plan and shopping-list', () => {
  it('lists every operation of both modules in the table', async () => {
    expect([...(await moduleOperations()).keys()].sort()).toEqual(Object.keys(expectedErrorStatuses).sort())
  })

  it('declares exactly the error statuses each route can answer', async () => {
    const declared = Object.fromEntries([...(await moduleOperations())].map(([operationId, operation]) => [
      operationId,
      Object.keys(operation.responses).map(Number).filter((status) => status >= 400).sort(),
    ]))
    expect(declared).toEqual(expectedErrorStatuses)
  })

  it('gives every declared 4xx except 401 a JSON body schema', async () => {
    const missing: string[] = []
    for (const [operationId, operation] of await moduleOperations()) {
      for (const [status, response] of Object.entries(operation.responses)) {
        if (Number(status) >= 400 && status !== '401' && !response.content?.['application/json']?.schema) missing.push(`${operationId} ${status}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('has a table entry for every status a handler throws', () => {
    const thrown = thrownStatusesByOperation()
    // Guards the scan itself against silently matching nothing.
    expect(thrown.get('generateWeekPlan')).toEqual(new Set([400, 403, 404, 422]))
    const undeclared: string[] = []
    for (const [operationId, statuses] of thrown) {
      for (const status of statuses) {
        if (!expectedErrorStatuses[operationId]?.includes(status)) undeclared.push(`${operationId} ${status}`)
      }
    }
    expect(undeclared).toEqual([])
  })

  it('throws ApiError only from routes.ts, so the source scan above sees every throw', () => {
    for (const name of modules) {
      for (const file of readdirSync(moduleDir(name)).filter((entry) => entry !== 'routes.ts')) {
        expect({ file, throwsApiError: readFileSync(path.join(moduleDir(name), file), 'utf8').includes('new ApiError') }).toEqual({ file, throwsApiError: false })
      }
    }
  })
})
