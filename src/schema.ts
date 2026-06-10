import { pgTable, uuid, text, timestamp, pgEnum, uniqueIndex, index, integer, date, jsonb, boolean } from 'drizzle-orm/pg-core'

export const householdMembershipRole = pgEnum('household_membership_role', ['owner', 'member'])
export const householdMembershipStatus = pgEnum('household_membership_status', ['active', 'removed'])
export const householdInviteStatus = pgEnum('household_invite_status', ['pending', 'accepted', 'revoked', 'expired'])

export const households = pgTable('households', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const householdProfiles = pgTable('household_profiles', {
  householdId: uuid('household_id').primaryKey().references(() => households.id, { onDelete: 'cascade' }),
  adults: integer('adults').notNull(),
  children: integer('children').notNull(),
  priorities: jsonb('priorities').notNull(),
  avoidIngredients: jsonb('avoid_ingredients').notNull(),
  selectedDays: jsonb('selected_days').notNull(),
  updatedBy: uuid('updated_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const householdActiveWeeks = pgTable('household_active_weeks', {
  householdId: uuid('household_id').primaryKey().references(() => households.id, { onDelete: 'cascade' }),
  weekStartDate: date('week_start_date', { mode: 'string' }).notNull(),
  timezone: text('timezone').notNull(),
  updatedBy: uuid('updated_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
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

export const householdInvites = pgTable('household_invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  householdId: uuid('household_id').notNull().references(() => households.id, { onDelete: 'cascade' }),
  token: text('token').notNull(),
  email: text('email'),
  status: householdInviteStatus('status').notNull().default('pending'),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedBy: uuid('accepted_by'),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
}, (table) => [
  uniqueIndex('household_invites_token_idx').on(table.token),
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

export const shoppingListEventType = pgEnum('shopping_list_event_type', ['list_started', 'item_checked'])

export const shoppingListEvents = pgTable('shopping_list_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  householdId: uuid('household_id').notNull().references(() => households.id, { onDelete: 'cascade' }),
  weekStartDate: date('week_start_date', { mode: 'string' }).notNull(),
  sequenceNumber: integer('sequence_number').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  causedBy: jsonb('caused_by').notNull(),
  eventType: shoppingListEventType('event_type').notNull(),
  payload: jsonb('payload').notNull(),
}, (table) => [
  uniqueIndex('shopping_list_events_household_week_sequence_idx').on(table.householdId, table.weekStartDate, table.sequenceNumber),
])

export const shoppingListProjections = pgTable('shopping_list_projections', {
  householdId: uuid('household_id').notNull().references(() => households.id, { onDelete: 'cascade' }),
  weekStartDate: date('week_start_date', { mode: 'string' }).notNull(),
  state: jsonb('state').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('shopping_list_projections_household_week_idx').on(table.householdId, table.weekStartDate),
])

export const recipeSource = pgEnum('recipe_source', ['user_created', 'url_import', 'ai_generated'])

// ingredients: TRecipeIngredient[] — { item: string, amount?: string, unit?: string, category?: string }
// steps:       TRecipeStep[]       — { text: string }
// tags:        string[]
// All stored as JSONB rather than normalized child tables — same shape
// MealPlanner already serialises to/from JSON in its own repository layer,
// and JSONB lets a single query return a fully hydrated recipe without joins.
export const recipes = pgTable('recipes', {
  id: uuid('id').primaryKey().defaultRandom(),
  householdId: uuid('household_id').notNull().references(() => households.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  servings: integer('servings').notNull().default(4),
  ingredients: jsonb('ingredients').notNull(),
  steps: jsonb('steps').notNull(),
  tags: jsonb('tags').notNull(),
  prepTimeMinutes: integer('prep_time_minutes'),
  cookTimeMinutes: integer('cook_time_minutes'),
  cuisine: text('cuisine'),
  proteinSource: text('protein_source'),
  mealWeight: text('meal_weight'),
  sourceUrl: text('source_url'),
  source: recipeSource('source').notNull().default('user_created'),
  isPublic: boolean('is_public').notNull().default(false),
  isArchived: boolean('is_archived').notNull().default(false),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('recipes_household_updated_idx').on(table.householdId, table.updatedAt),
])
