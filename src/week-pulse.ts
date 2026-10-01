import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, eq } from 'drizzle-orm'
import { requireAuth, type AuthedUser } from './auth.js'
import type { Db } from './db.js'
import { assertMembership } from './membership.js'
import { withRls } from './rls.js'
import { householdMemberships, householdWeekPulses, userProfiles } from './schema.js'

const datePattern = /^\d{4}-\d{2}-\d{2}$/

function addDays(isoDate: string, amount: number) {
  const [year, month, day] = isoDate.split('-').map(Number)
  const value = new Date(Date.UTC(year!, month! - 1, day! + amount))
  return value.toISOString().slice(0, 10)
}

function isMonday(value: string) {
  return datePattern.test(value) && new Date(`${value}T00:00:00Z`).getUTCDay() === 1
}

export function isDateInWeek(weekStartDate: string, value: string) {
  return datePattern.test(value) && value >= weekStartDate && value <= addDays(weekStartDate, 6)
}

const WeekPulseInputSchema = z.object({
  awayDates: z.array(z.string().regex(datePattern)).max(7).default([]),
  wishedMeal: z.string().trim().min(1).max(80).nullable().default(null),
  simpleDate: z.string().regex(datePattern).nullable().default(null),
}).openapi('WeekPulseInput')

const WeekPulseMemberSchema = z.object({
  userId: z.string().uuid(),
  givenName: z.string().nullable(),
  familyName: z.string().nullable(),
  responded: z.boolean(),
  isCurrentUser: z.boolean(),
  awayDates: z.array(z.string()),
  wishedMeal: z.string().nullable(),
  simpleDate: z.string().nullable(),
  updatedAt: z.string().nullable(),
}).openapi('WeekPulseMember')

const WeekPulseSchema = z.object({
  householdId: z.string().uuid(),
  weekStartDate: z.string(),
  responseCount: z.number().int().min(0),
  memberCount: z.number().int().min(1),
  members: z.array(WeekPulseMemberSchema),
}).openapi('WeekPulse')

const pulseParams = z.object({ householdId: z.string().uuid(), weekStartDate: z.string() })

const getWeekPulseRoute = createRoute({
  method: 'get', path: '/households/{householdId}/week-pulses/{weekStartDate}', operationId: 'getWeekPulse',
  summary: 'Get the combined household pulse for a week', security: [{ bearerAuth: [] }],
  request: { params: pulseParams },
  responses: {
    200: { description: 'Household pulse', content: { 'application/json': { schema: WeekPulseSchema } } },
    400: { description: 'Invalid week start date' }, 401: { description: 'Missing or invalid session' },
    404: { description: 'Household not found or caller is not a member' },
  },
})

const putWeekPulseRoute = createRoute({
  method: 'put', path: '/households/{householdId}/week-pulses/{weekStartDate}/me', operationId: 'putMyWeekPulse',
  summary: 'Create or replace the current member week pulse', security: [{ bearerAuth: [] }],
  request: { params: pulseParams, body: { required: true, content: { 'application/json': { schema: WeekPulseInputSchema } } } },
  responses: {
    200: { description: 'Updated household pulse', content: { 'application/json': { schema: WeekPulseSchema } } },
    400: { description: 'Dates must belong to the requested week' }, 401: { description: 'Missing or invalid session' },
    404: { description: 'Household not found or caller is not a member' },
  },
})

export type TWeekPulseRow = {
  userId: string
  awayDates: string[]
  wishedMeal: string | null
  simpleDate: string | null
}

export async function listWeekPulseRows(db: Db, accessToken: string, householdId: string, weekStartDate: string) {
  return withRls(db, accessToken, (tx) => tx
    .select({
      userId: householdMemberships.userId,
      givenName: userProfiles.givenName,
      familyName: userProfiles.familyName,
      awayDates: householdWeekPulses.awayDates,
      wishedMeal: householdWeekPulses.wishedMeal,
      simpleDate: householdWeekPulses.simpleDate,
      updatedAt: householdWeekPulses.updatedAt,
    })
    .from(householdMemberships)
    .leftJoin(userProfiles, eq(userProfiles.userId, householdMemberships.userId))
    .leftJoin(householdWeekPulses, and(
      eq(householdWeekPulses.householdId, householdMemberships.householdId),
      eq(householdWeekPulses.weekStartDate, weekStartDate),
      eq(householdWeekPulses.userId, householdMemberships.userId),
    ))
    .where(and(eq(householdMemberships.householdId, householdId), eq(householdMemberships.status, 'active')))
    .orderBy(householdMemberships.joinedAt))
}

function responseFromRows(householdId: string, weekStartDate: string, currentUserId: string, rows: Awaited<ReturnType<typeof listWeekPulseRows>>) {
  const members = rows.map((row) => ({
    userId: row.userId,
    givenName: row.givenName,
    familyName: row.familyName,
    responded: row.updatedAt !== null,
    isCurrentUser: row.userId === currentUserId,
    awayDates: Array.isArray(row.awayDates) ? row.awayDates.filter((value): value is string => typeof value === 'string') : [],
    wishedMeal: row.wishedMeal,
    simpleDate: row.simpleDate,
    updatedAt: row.updatedAt?.toISOString() ?? null,
  }))
  return { householdId, weekStartDate, responseCount: members.filter((member) => member.responded).length, memberCount: members.length, members }
}

export async function buildWeekPulseResponse(db: Db, accessToken: string, householdId: string, weekStartDate: string, currentUserId: string) {
  return responseFromRows(householdId, weekStartDate, currentUserId, await listWeekPulseRows(db, accessToken, householdId, weekStartDate))
}

export async function upsertWeekPulse(
  db: Db,
  accessToken: string,
  userId: string,
  householdId: string,
  weekStartDate: string,
  input: { awayDates: string[]; wishedMeal: string | null; simpleDate: string | null },
) {
  await withRls(db, accessToken, (tx) => tx.insert(householdWeekPulses).values({
    householdId, weekStartDate, userId,
    awayDates: [...new Set(input.awayDates)].sort(), wishedMeal: input.wishedMeal, simpleDate: input.simpleDate, updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: [householdWeekPulses.householdId, householdWeekPulses.weekStartDate, householdWeekPulses.userId],
    set: { awayDates: [...new Set(input.awayDates)].sort(), wishedMeal: input.wishedMeal, simpleDate: input.simpleDate, updatedAt: new Date() },
  }))
  return buildWeekPulseResponse(db, accessToken, householdId, weekStartDate, userId)
}

export function buildWeekPulseRoutes(db: Db) {
  const app = new OpenAPIHono<{ Variables: { user: AuthedUser; accessToken: string } }>()
  app.use('/households/*', requireAuth)

  app.openapi(getWeekPulseRoute, async (c) => {
    const { householdId, weekStartDate } = c.req.valid('param')
    const user = c.get('user')
    const accessToken = c.get('accessToken')
    if (!isMonday(weekStartDate)) return c.json({ error: 'INVALID_WEEK_START_DATE' } as never, 400)
    if (!await assertMembership(db, accessToken, householdId, user.id)) return c.json({ error: 'NOT_MEMBER' } as never, 404)
    return c.json(await buildWeekPulseResponse(db, accessToken, householdId, weekStartDate, user.id), 200)
  })

  app.openapi(putWeekPulseRoute, async (c) => {
    const { householdId, weekStartDate } = c.req.valid('param')
    const input = c.req.valid('json')
    const user = c.get('user')
    const accessToken = c.get('accessToken')
    if (!isMonday(weekStartDate)) return c.json({ error: 'INVALID_WEEK_START_DATE' } as never, 400)
    if (!input.awayDates.every((date) => isDateInWeek(weekStartDate, date)) || (input.simpleDate && !isDateInWeek(weekStartDate, input.simpleDate))) {
      return c.json({ error: 'DATE_OUTSIDE_WEEK' } as never, 400)
    }
    if (!await assertMembership(db, accessToken, householdId, user.id)) return c.json({ error: 'NOT_MEMBER' } as never, 404)
    return c.json(await upsertWeekPulse(db, accessToken, user.id, householdId, weekStartDate, input), 200)
  })
  return app
}
