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
