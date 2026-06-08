import { pgTable, uuid, text, timestamp, pgEnum, uniqueIndex, integer, date, jsonb } from 'drizzle-orm/pg-core'

export const householdMembershipRole = pgEnum('household_membership_role', ['owner', 'member'])
export const householdMembershipStatus = pgEnum('household_membership_status', ['active', 'removed'])

export const households = pgTable('households', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const householdMemberships = pgTable('household_memberships', {
  id: uuid('id').primaryKey().defaultRandom(),
  householdId: uuid('household_id').notNull().references(() => households.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull(),
  role: householdMembershipRole('role').notNull(),
  status: householdMembershipStatus('status').notNull().default('active'),
  joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('household_memberships_household_id_user_id_idx').on(table.householdId, table.userId),
])

export const weekPlanEventType = pgEnum('week_plan_event_type', ['week_started', 'meal_assigned'])

export const weekPlanEvents = pgTable('week_plan_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  householdId: uuid('household_id').notNull().references(() => households.id, { onDelete: 'cascade' }),
  weekStartDate: date('week_start_date', { mode: 'string' }).notNull(),
  sequenceNumber: integer('sequence_number').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  causedBy: jsonb('caused_by').notNull(),
  eventType: weekPlanEventType('event_type').notNull(),
  payload: jsonb('payload').notNull(),
}, (table) => [
  uniqueIndex('week_plan_events_household_week_sequence_idx').on(table.householdId, table.weekStartDate, table.sequenceNumber),
])

export const weekPlanProjections = pgTable('week_plan_projections', {
  householdId: uuid('household_id').notNull().references(() => households.id, { onDelete: 'cascade' }),
  weekStartDate: date('week_start_date', { mode: 'string' }).notNull(),
  state: jsonb('state').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('week_plan_projections_household_week_idx').on(table.householdId, table.weekStartDate),
])
