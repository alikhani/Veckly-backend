import { randomUUID } from 'node:crypto'
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, eq } from 'drizzle-orm'
import { requireAuth, type AuthedUser } from './auth.js'
import { withRls } from './rls.js'
import { households, householdMemberships } from './schema.js'
import type { Db } from './db.js'

const HouseholdSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  role: z.enum(['owner', 'member']),
}).openapi('Household')

const MyHouseholdsResponseSchema = z.object({
  households: z.array(HouseholdSchema),
}).openapi('MyHouseholdsResponse')

const getMyHouseholds = createRoute({
  method: 'get',
  path: '/households/me',
  summary: "List the households the authenticated user belongs to",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Households the authenticated user has an active membership in',
      content: { 'application/json': { schema: MyHouseholdsResponseSchema } },
    },
    401: { description: 'Missing or invalid session' },
  },
})

const bootstrapMyHousehold = createRoute({
  method: 'post',
  path: '/households/me/bootstrap',
  summary: 'Ensure the authenticated user has a household, creating "My household" if they have none',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Returned the household the user already belonged to — nothing created',
      content: { 'application/json': { schema: HouseholdSchema } },
    },
    201: {
      description: 'Created "My household" with the caller as owner',
      content: { 'application/json': { schema: HouseholdSchema } },
    },
    401: { description: 'Missing or invalid session' },
  },
})

// Supabase Auth has no equivalent of Better Auth's `databaseHooks.user.create.after`
// (the hook MealPlanner uses to give every new user a household for free) — so
// the client calls this once, right after signup, to restore that invariant.
// `userId` is taken explicitly rather than derived from `auth.uid()` inside the
// query, because an INSERT's `values()` needs the literal value — but a forged
// `userId` is still independently re-checked by the `user_id = auth.uid()`
// clause in `memberships_insert_self_as_owner_for_new_household` (0004), so the
// database remains the actual boundary, not this function's argument list.
export async function bootstrapHousehold(db: Db, accessToken: string, userId: string) {
  return withRls(db, accessToken, async (tx) => {
    const [existing] = await tx
      .select({ id: households.id, name: households.name, role: householdMemberships.role })
      .from(householdMemberships)
      .innerJoin(households, eq(households.id, householdMemberships.householdId))
      .where(and(eq(householdMemberships.userId, userId), eq(householdMemberships.status, 'active')))
      .limit(1)

    if (existing) return { household: existing, created: false }

    // The household id is generated here, in code, rather than read back via
    // `.returning()` — Postgres checks RETURNING rows against the table's
    // SELECT policies, and `households_select_via_active_membership` (0001)
    // requires an active membership that doesn't exist yet at this exact
    // instant. `.returning()` here would fail with "new row violates
    // row-level security policy", the chicken-and-egg problem surfacing one
    // layer below the policy that was written to solve it. The membership
    // insert's `.returning()` is fine: `memberships_select_own` checks
    // `user_id = auth.uid()`, which the caller's own new row satisfies
    // immediately.
    const householdName = 'My household'
    const householdId = randomUUID()
    await tx.insert(households).values({ id: householdId, name: householdName })

    const [membership] = await tx
      .insert(householdMemberships)
      .values({ householdId, userId, role: 'owner', status: 'active' })
      .returning()
    if (!membership) throw new Error('Insert did not return the persisted membership')

    return { household: { id: householdId, name: householdName, role: membership.role }, created: true }
  })
}

export function buildHouseholdsRoutes(db: Db) {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()

  app.use('/households/*', requireAuth)

  app.openapi(getMyHouseholds, async (c) => {
    const accessToken = c.get('accessToken')

    // Plain selects scoped only by `auth.uid()` via RLS — no `where userId = ...`
    // here. That's the point: even if this query were written wrong (or a future
    // route forgot to scope it), the database would still only return rows this
    // user is allowed to see.
    const rows = await withRls(db, accessToken, (tx) =>
      tx
        .select({ id: households.id, name: households.name, role: householdMemberships.role })
        .from(householdMemberships)
        .innerJoin(households, eq(households.id, householdMemberships.householdId))
        .where(eq(householdMemberships.status, 'active')),
    )

    return c.json({ households: rows.map((row) => ({ id: row.id, name: row.name, role: row.role })) }, 200)
  })

  app.openapi(bootstrapMyHousehold, async (c) => {
    const accessToken = c.get('accessToken')
    const user = c.get('user')

    const { household, created } = await bootstrapHousehold(db, accessToken, user.id)

    return c.json({ id: household.id, name: household.name, role: household.role }, created ? 201 : 200)
  })

  return app
}
