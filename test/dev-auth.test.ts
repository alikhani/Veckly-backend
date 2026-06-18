import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { createDb } from '../src/db.js'
import { setDevAuthDependenciesForTests } from '../src/dev-auth.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const describeWithDb = testDatabaseUrl ? describe : describe.skip

describeWithDb('Dev auth route', () => {
  const db = createDb(testDatabaseUrl!)
  const previousEnv = {
    ENABLE_DEV_AUTH: process.env.ENABLE_DEV_AUTH,
    APP_ENV: process.env.APP_ENV,
    VERCEL_ENV: process.env.VERCEL_ENV,
    DEV_AUTH_USERS_JSON: process.env.DEV_AUTH_USERS_JSON,
  }

  beforeEach(() => {
    process.env.ENABLE_DEV_AUTH = 'true'
    delete process.env.APP_ENV
    delete process.env.VERCEL_ENV
    process.env.DEV_AUTH_USERS_JSON = JSON.stringify([
      {
        userId: '11111111-1111-1111-1111-111111111111',
        email: 'dev-one@example.com',
        password: 'pw-one',
      },
      {
        userId: '22222222-2222-2222-2222-222222222222',
        email: 'dev-two@example.com',
        password: 'pw-two',
      },
    ])
  })

  afterEach(() => {
    setDevAuthDependenciesForTests(null)
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('returns a valid session for the default configured user', async () => {
    setDevAuthDependenciesForTests({
      sessionCreator: async (user) => ({
        accessToken: `access-for:${user.email}`,
        refreshToken: 'refresh-token',
        userId: user.userId ?? 'missing-user-id',
      }),
    })

    const response = await buildApp(db).request('/auth/dev-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      accessToken: 'access-for:dev-one@example.com',
      refreshToken: 'refresh-token',
      userId: '11111111-1111-1111-1111-111111111111',
    })
  })

  it('selects the requested configured user by userId', async () => {
    setDevAuthDependenciesForTests({
      sessionCreator: async (user) => ({
        accessToken: `access-for:${user.email}`,
        refreshToken: 'refresh-token',
        userId: user.userId ?? 'missing-user-id',
      }),
    })

    const response = await buildApp(db).request('/auth/dev-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: '22222222-2222-2222-2222-222222222222' }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      accessToken: 'access-for:dev-two@example.com',
      refreshToken: 'refresh-token',
      userId: '22222222-2222-2222-2222-222222222222',
    })
  })

  it('returns not found for an unknown configured user id', async () => {
    setDevAuthDependenciesForTests({
      sessionCreator: async () => {
        throw new Error('should not be called')
      },
    })

    const response = await buildApp(db).request('/auth/dev-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: '33333333-3333-3333-3333-333333333333' }),
    })

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'UNKNOWN_DEV_USER' })
  })

  it('is unavailable when dev auth is disabled', async () => {
    process.env.ENABLE_DEV_AUTH = 'false'

    const response = await buildApp(db).request('/auth/dev-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(response.status).toBe(404)
  })

  it('is unavailable in production mode even if the flag is enabled', async () => {
    process.env.ENABLE_DEV_AUTH = 'true'
    process.env.APP_ENV = 'production'

    const response = await buildApp(db).request('/auth/dev-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(response.status).toBe(404)
  })
})
