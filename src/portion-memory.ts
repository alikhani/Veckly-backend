import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { requireAuth, type AuthedUser } from './auth.js'
import type { Db } from './db.js'
import { assertMembership } from './membership.js'
import { withRls } from './rls.js'
import { householdPortionMemories } from './schema.js'

export const PortionSuggestionSchema = z.object({
  direction: z.enum(['more', 'less']),
  suggestedServings: z.number().int().min(1),
  evidenceCount: z.number().int().min(3),
  matchingCount: z.number().int().min(2),
}).openapi('PortionSuggestion')

export type PortionEvidence = {
  status: 'cooked' | 'changed_plan' | 'skipped'
  portionOutcome: 'too_little' | 'right_amount' | 'too_much' | null
  intentionalLeftovers: boolean
  updatedAt: Date
}

export function derivePortionSuggestion(
  outcomes: PortionEvidence[],
  currentServings: number,
  ignoredThrough?: Date | null,
) {
  const eligible = outcomes
    .filter((outcome) =>
      outcome.status === 'cooked'
      && outcome.portionOutcome !== null
      && !(outcome.portionOutcome === 'too_much' && outcome.intentionalLeftovers)
      && (!ignoredThrough || outcome.updatedAt > ignoredThrough),
    )
    .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())
    .slice(0, 6)
  if (eligible.length < 3) return null

  const tooLittle = eligible.filter((outcome) => outcome.portionOutcome === 'too_little').length
  const tooMuch = eligible.filter((outcome) => outcome.portionOutcome === 'too_much').length
  const minimumAgreement = Math.ceil(eligible.length * 2 / 3)

  if (tooLittle >= minimumAgreement && tooLittle > tooMuch) {
    return { direction: 'more' as const, suggestedServings: currentServings + 1, evidenceCount: eligible.length, matchingCount: tooLittle }
  }
  if (tooMuch >= minimumAgreement && tooMuch > tooLittle && currentServings > 1) {
    return { direction: 'less' as const, suggestedServings: currentServings - 1, evidenceCount: eligible.length, matchingCount: tooMuch }
  }
  return null
}

const ParamsSchema = z.object({ householdId: z.string().uuid(), recipeId: z.string().uuid() })
const UpdateSchema = z.object({ action: z.enum(['ignore', 'reset']) }).openapi('UpdatePortionMemory')
const ResponseSchema = z.object({ ignoredThrough: z.string(), action: z.enum(['ignore', 'reset']) }).openapi('PortionMemoryUpdate')

const updateRoute = createRoute({
  method: 'put', path: '/households/{householdId}/portion-memory/{recipeId}', operationId: 'updatePortionMemory',
  summary: 'Ignore the current portion suggestion or reset learned portion history', security: [{ bearerAuth: [] }],
  request: { params: ParamsSchema, body: { required: true, content: { 'application/json': { schema: UpdateSchema } } } },
  responses: {
    200: { description: 'Portion memory updated', content: { 'application/json': { schema: ResponseSchema } } },
    401: { description: 'Missing or invalid session' },
    404: { description: 'Household not found or caller is not a member' },
  },
})

export async function ignorePortionHistory(db: Db, accessToken: string, userId: string, householdId: string, recipeId: string) {
  const now = new Date()
  const [row] = await withRls(db, accessToken, (tx) => tx
    .insert(householdPortionMemories)
    .values({ householdId, recipeId, ignoredThrough: now, updatedBy: userId, updatedAt: now })
    .onConflictDoUpdate({
      target: [householdPortionMemories.householdId, householdPortionMemories.recipeId],
      set: { ignoredThrough: now, updatedBy: userId, updatedAt: now },
    })
    .returning({ ignoredThrough: householdPortionMemories.ignoredThrough }))
  if (!row) throw new Error('Portion memory upsert did not return a row')
  return row.ignoredThrough
}

export function buildPortionMemoryRoutes(db: Db) {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()
  app.use('/households/*', requireAuth)
  app.openapi(updateRoute, async (c) => {
    const { householdId, recipeId } = c.req.valid('param')
    const { action } = c.req.valid('json')
    const user = c.get('user')
    const accessToken = c.get('accessToken')
    if (!await assertMembership(db, accessToken, householdId, user.id)) return c.json({ error: 'NOT_MEMBER' } as never, 404)
    const ignoredThrough = await ignorePortionHistory(db, accessToken, user.id, householdId, recipeId)
    return c.json({ action, ignoredThrough: ignoredThrough.toISOString() }, 200)
  })
  return app
}
