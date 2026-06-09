import { createMiddleware } from 'hono/factory'
import { createClient } from '@supabase/supabase-js'

export type AuthedUser = { id: string }

const supabaseUrl = process.env.SUPABASE_URL
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY
if (!supabaseUrl || !supabaseAnonKey) throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required')

const supabase = createClient(supabaseUrl, supabaseAnonKey)

export const requireAuth = createMiddleware<{ Variables: { user: AuthedUser; accessToken: string } }>(
  async (c, next) => {
    const header = c.req.header('Authorization')
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined
    if (!token) return c.json({ error: 'Missing bearer token' }, 401)

    const { data, error } = await supabase.auth.getUser(token)
    if (error || !data.user) return c.json({ error: 'Invalid or expired session' }, 401)

    c.set('user', { id: data.user.id })
    c.set('accessToken', token)
    await next()
  },
)

// Server-to-server auth for the MealPlanner→Veckly-backend strangle path.
// MealPlanner validates its own Better Auth session, extracts the userId, then
// calls the new backend with this key + X-User-Id rather than forwarding the
// session token (which the backend can't validate directly). The backend trusts
// the userId claim exactly as far as the key can be kept secret — rotate the
// key if it ever leaks. This middleware is transitional: it gets removed once
// the web frontend migrates to calling the backend directly with its own tokens.
export const requireInternalAuth = createMiddleware<{ Variables: { user: AuthedUser; accessToken: string } }>(
  async (c, next) => {
    const internalKey = process.env.VECKLY_INTERNAL_API_KEY
    if (!internalKey) return c.json({ error: 'Internal auth not configured' }, 503)

    const header = c.req.header('Authorization')
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined
    if (!token || token !== internalKey) return c.json({ error: 'Unauthorized' }, 401)

    const userId = c.req.header('X-User-Id')
    if (!userId) return c.json({ error: 'Missing X-User-Id header' }, 401)

    // Synthesise a JWT-shaped access token so withRls can decode the sub claim
    // without changing its interface — the same trick fakeAccessToken() uses in
    // tests. The signature segment is meaningless; withRls only reads the payload.
    const payload = Buffer.from(JSON.stringify({ sub: userId }), 'utf8').toString('base64url')
    c.set('user', { id: userId })
    c.set('accessToken', `internal.${payload}.unsigned`)
    await next()
  },
)
