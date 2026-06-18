import { Hono } from 'hono'
import { createClient } from '@supabase/supabase-js'

type AuthedSession = {
  accessToken: string
  refreshToken: string | null
  userId: string
}

type ConfiguredDevUser = {
  userId: string | null
  email: string
  password: string
}

type SessionCreator = (user: ConfiguredDevUser) => Promise<AuthedSession>

let sessionCreator: SessionCreator = createSessionForConfiguredUser

export function setDevAuthDependenciesForTests(deps: { sessionCreator?: SessionCreator } | null) {
  sessionCreator = deps?.sessionCreator ?? createSessionForConfiguredUser
}

export function isDevAuthEnabled() {
  if (isProductionDeployment()) return false
  return process.env.ENABLE_DEV_AUTH === 'true'
}

function isProductionDeployment() {
  return process.env.APP_ENV === 'production' || process.env.VERCEL_ENV === 'production'
}

function parseConfiguredDevUsers(): ConfiguredDevUser[] {
  const json = process.env.DEV_AUTH_USERS_JSON?.trim()
  if (json) {
    const parsed = JSON.parse(json) as unknown
    const entries = Array.isArray(parsed) ? parsed : Object.values(parsed as Record<string, unknown>)
    return entries.map(parseConfiguredDevUser)
  }

  const users: ConfiguredDevUser[] = []

  if (process.env.DEV_AUTH_DEFAULT_EMAIL && process.env.DEV_AUTH_DEFAULT_PASSWORD) {
    users.push({
      userId: process.env.DEV_AUTH_DEFAULT_USER_ID ?? null,
      email: process.env.DEV_AUTH_DEFAULT_EMAIL,
      password: process.env.DEV_AUTH_DEFAULT_PASSWORD,
    })
  }

  if (process.env.DEV_AUTH_SECONDARY_EMAIL && process.env.DEV_AUTH_SECONDARY_PASSWORD) {
    users.push({
      userId: process.env.DEV_AUTH_SECONDARY_USER_ID ?? null,
      email: process.env.DEV_AUTH_SECONDARY_EMAIL,
      password: process.env.DEV_AUTH_SECONDARY_PASSWORD,
    })
  }

  return users
}

function parseConfiguredDevUser(value: unknown): ConfiguredDevUser {
  if (!value || typeof value !== 'object') throw new Error('DEV_AUTH_USERS_JSON entries must be objects')
  const record = value as Record<string, unknown>
  if (typeof record.email !== 'string' || typeof record.password !== 'string') {
    throw new Error('DEV_AUTH_USERS_JSON entries must include string email and password')
  }

  return {
    userId: typeof record.userId === 'string' && record.userId.length > 0 ? record.userId : null,
    email: record.email,
    password: record.password,
  }
}

function resolveConfiguredUser(requestedUserId: string | null) {
  const users = parseConfiguredDevUsers()
  if (users.length === 0) return { error: 'DEV_AUTH_NOT_CONFIGURED' as const }

  const defaultUser = users[0]
  if (!defaultUser) return { error: 'DEV_AUTH_NOT_CONFIGURED' as const }
  if (!requestedUserId) return { user: defaultUser }

  const matched = users.find((user) => user.userId === requestedUserId)
  if (!matched) return { error: 'UNKNOWN_DEV_USER' as const }
  return { user: matched }
}

async function createSessionForConfiguredUser(user: ConfiguredDevUser): Promise<AuthedSession> {
  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseAnonKey) throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required')

  const supabase = createClient(supabaseUrl, supabaseAnonKey)
  const { data, error } = await supabase.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  })

  if (error || !data.session || !data.user) {
    throw new Error(error?.message ?? 'DEV_AUTH_SIGN_IN_FAILED')
  }

  return {
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token ?? null,
    userId: data.user.id,
  }
}

export function buildDevAuthRoutes() {
  const app = new Hono()

  app.post('/auth/dev-token', async (c) => {
    if (!isDevAuthEnabled()) return c.json({ error: 'Not found' }, 404)

    const body = await c.req.json().catch(() => ({})) as { userId?: unknown }
    const requestedUserId = typeof body.userId === 'string' && body.userId.length > 0 ? body.userId : null
    const resolved = resolveConfiguredUser(requestedUserId)

    if ('error' in resolved) {
      if (resolved.error === 'DEV_AUTH_NOT_CONFIGURED') {
        return c.json({ error: resolved.error }, 503)
      }
      return c.json({ error: resolved.error }, 404)
    }

    const user = resolved.user

    try {
      const session = await sessionCreator(user)
      return c.json(session, 200)
    } catch {
      return c.json({ error: 'DEV_AUTH_SIGN_IN_FAILED' }, 500)
    }
  })

  return app
}
