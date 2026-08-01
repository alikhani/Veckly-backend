import { pgTable, uuid, text, timestamp, pgEnum, uniqueIndex, index, integer, date, jsonb, boolean, primaryKey } from 'drizzle-orm/pg-core'

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

export const userProfiles = pgTable('user_profiles', {
  userId: uuid('user_id').primaryKey(),
  givenName: text('given_name').notNull(),
  familyName: text('family_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

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

export const weekPlanEventType = pgEnum('week_plan_event_type', [
  'week_started',
  'planning_request_updated',
  'meal_assigned',
  'meal_unassigned',
  'meal_locked',
  'meal_unlocked',
  'meal_moved',
  'day_skipped',
  'day_unskipped',
  'servings_changed',
  'week_plan_cleared',
])

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

export const householdWeekPlanStatus = pgEnum('household_week_plan_status', ['draft', 'finalized', 'archived'])
export const householdWeekPlanSource = pgEnum('household_week_plan_source', ['generated', 'copied_from_previous', 'template_applied', 'manual'])

export const householdWeekPlans = pgTable('household_week_plans', {
  householdId: uuid('household_id').notNull().references(() => households.id, { onDelete: 'cascade' }),
  weekStartDate: date('week_start_date', { mode: 'string' }).notNull(),
  weekNumber: integer('week_number').notNull(),
  weekYear: integer('week_year').notNull(),
  timezone: text('timezone').notNull(),
  state: jsonb('state').notNull(),
  status: householdWeekPlanStatus('status').notNull(),
  source: householdWeekPlanSource('source').notNull(),
  updatedBy: uuid('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('household_week_plans_household_week_idx').on(table.householdId, table.weekStartDate),
  index('household_week_plans_household_week_number_idx').on(table.householdId, table.weekYear, table.weekNumber),
  index('household_week_plans_updated_idx').on(table.updatedAt),
])

export const shoppingListEventType = pgEnum('shopping_list_event_type', [
  'list_started',
  'item_checked',
  'shopping_state_replaced',
  'shopping_list_cleared',
])

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

export const recipeSource = pgEnum('recipe_source', ['user_created', 'url_import', 'ai_generated', 'builtin'])

// ingredients: TRecipeIngredient[] — { item: string, amount?: string, unit?: string, category?: string }
// steps:       TRecipeStep[]       — { text: string }
// tags:        string[]
// All stored as JSONB rather than normalized child tables — same shape
// MealPlanner already serialises to/from JSON in its own repository layer,
// and JSONB lets a single query return a fully hydrated recipe without joins.
export const recipes = pgTable('recipes', {
  id: uuid('id').primaryKey().defaultRandom(),
  householdId: uuid('household_id').references(() => households.id, { onDelete: 'cascade' }),
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

export const userSavedRecipes = pgTable('user_saved_recipes', {
  userId: uuid('user_id').notNull(),
  recipeId: uuid('recipe_id').notNull().references(() => recipes.id, { onDelete: 'cascade' }),
  savedAt: timestamp('saved_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.recipeId], name: 'user_saved_recipes_pk' }),
  index('user_saved_recipes_user_saved_at_idx').on(table.userId, table.savedAt),
])

// Distinct from `userSavedRecipes`: this is the household's shared bookmark
// list (what week generation reads as a candidate source), not a personal
// one. Any active member may add or remove a row — removing here never
// touches a member's own `userSavedRecipes` entry, so a vetoed household
// bookmark stays cookable by whoever personally saved it.
export const householdSavedRecipes = pgTable('household_saved_recipes', {
  householdId: uuid('household_id').notNull().references(() => households.id, { onDelete: 'cascade' }),
  recipeId: uuid('recipe_id').notNull().references(() => recipes.id, { onDelete: 'cascade' }),
  addedBy: uuid('added_by').notNull(),
  addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.householdId, table.recipeId], name: 'household_saved_recipes_pk' }),
  index('household_saved_recipes_household_added_idx').on(table.householdId, table.addedAt),
])

export const householdMealSignal = pgEnum('household_meal_signal', ['works_for_family', 'not_for_us'])

// Shared household memory, distinct from private per-user `mealFeedback`.
// Any active member may update this single household-level signal for a meal;
// partner-private thumbs up/down stay in `mealFeedback`.
export const householdMealSignals = pgTable('household_meal_signals', {
  householdId: uuid('household_id').notNull().references(() => households.id, { onDelete: 'cascade' }),
  mealId: text('meal_id').notNull(),
  signal: householdMealSignal('signal').notNull(),
  updatedBy: uuid('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.householdId, table.mealId], name: 'household_meal_signals_pk' }),
  index('household_meal_signals_household_updated_idx').on(table.householdId, table.updatedAt),
])

// Server-side cache for `/recipes/recommend` (see recipe-recommendations.ts)
// — a household's taste profile and feedback history don't meaningfully
// shift week to week, so recomputing this AI call on every app launch
// doesn't buy anything beyond cost and latency. Keyed by `language` too
// (not just `householdId`) since a cached English response wouldn't satisfy
// a Swedish-language caller.
export const householdRecipeRecommendations = pgTable('household_recipe_recommendations', {
  householdId: uuid('household_id').notNull().references(() => households.id, { onDelete: 'cascade' }),
  language: text('language').notNull(),
  recommendations: jsonb('recommendations').notNull(),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.householdId, table.language], name: 'household_recipe_recommendations_pk' }),
])

export const mealFeedbackVote = pgEnum('meal_feedback_vote', ['up', 'down'])
export const mealFeedbackSignal = pgEnum('meal_feedback_signal', [
  'easy-weeknight',
  'family-approved',
  'good-leftovers',
  'too-much-effort',
  'family-pushback',
  'poor-leftovers',
])

export const mealFeedback = pgTable('meal_feedback', {
  householdId: uuid('household_id').notNull().references(() => households.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull(),
  mealId: text('meal_id').notNull(),
  vote: mealFeedbackVote('vote').notNull(),
  signal: mealFeedbackSignal('signal'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.householdId, table.userId, table.mealId], name: 'meal_feedback_pk' }),
  index('meal_feedback_household_updated_idx').on(table.householdId, table.updatedAt),
  index('meal_feedback_user_updated_idx').on(table.userId, table.updatedAt),
])

export const productEventName = pgEnum('product_event_name', [
  'onboarding_completed',
  'first_week_generated',
  'week_completed',
  'shopping_opened_after_week_completed',
  'shopping_shared',
  'partner_invite_clicked',
  'shopping_main_list_completed',
  'retro_completed',
])

export const productEvents = pgTable('product_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  householdId: uuid('household_id').notNull().references(() => households.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull(),
  eventName: productEventName('event_name').notNull(),
  weekStartDate: date('week_start_date', { mode: 'string' }),
  properties: jsonb('properties').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('product_events_household_occurred_idx').on(table.householdId, table.occurredAt),
  index('product_events_name_occurred_idx').on(table.eventName, table.occurredAt),
  index('product_events_user_occurred_idx').on(table.userId, table.occurredAt),
])

export const savedPlans = pgTable('saved_plans', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  label: text('label').notNull(),
  stateJson: text('state_json').notNull(),
}, (table) => [
  index('saved_plans_user_created_idx').on(table.userId, table.createdAt),
])

export const householdPrepBatches = pgTable('household_prep_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  householdId: uuid('household_id').notNull().references(() => households.id, { onDelete: 'cascade' }),
  recipeId: uuid('recipe_id').references(() => recipes.id, { onDelete: 'set null' }),
  customRecipeId: uuid('custom_recipe_id'),
  cookDate: date('cook_date', { mode: 'string' }).notNull(),
  totalPortions: integer('total_portions').notNull(),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('household_prep_batches_household_cook_date_idx').on(table.householdId, table.cookDate),
])

export const householdPrepBatchAssignments = pgTable('household_prep_batch_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  batchId: uuid('batch_id').notNull().references(() => householdPrepBatches.id, { onDelete: 'cascade' }),
  date: date('date', { mode: 'string' }).notNull(),
  mealType: text('meal_type').notNull(),
})

// Billing providers normalize their state into these values. Provider receipt,
// JWS, and token formats deliberately stay outside this domain model.
export const billingProvider = pgEnum('billing_provider', ['app_store', 'google_play', 'stripe', 'manual'])
export const billingSubscriptionStatus = pgEnum('billing_subscription_status', [
  'active',
  'grace_period',
  'expired',
  'cancelled',
  'revoked',
])
export const householdEntitlementSource = pgEnum('household_entitlement_source', ['subscription', 'manual', 'beta'])
export const householdAiUsageKind = pgEnum('household_ai_usage_kind', ['week_generation', 'week_regeneration'])

export const billingSubscriptions = pgTable('billing_subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: billingProvider('provider').notNull(),
  ownerUserId: uuid('owner_user_id').notNull(),
  externalId: text('external_id').notNull(),
  productId: text('product_id').notNull(),
  status: billingSubscriptionStatus('status').notNull(),
  currentPeriodEndsAt: timestamp('current_period_ends_at', { withTimezone: true }),
  environment: text('environment').notNull(),
  providerMetadata: jsonb('provider_metadata').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('billing_subscriptions_provider_external_id_idx').on(table.provider, table.externalId),
  index('billing_subscriptions_owner_status_idx').on(table.ownerUserId, table.status),
])

// Kept independently from subscription state so future App Store, Play, and
// Stripe adapters can deduplicate deliveries and retain an audit trail.
export const billingProviderEvents = pgTable('billing_provider_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: billingProvider('provider').notNull(),
  providerEventId: text('provider_event_id').notNull(),
  subscriptionId: uuid('subscription_id').references(() => billingSubscriptions.id, { onDelete: 'set null' }),
  payload: jsonb('payload').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('billing_provider_events_provider_event_id_idx').on(table.provider, table.providerEventId),
  index('billing_provider_events_subscription_received_idx').on(table.subscriptionId, table.receivedAt),
])

// A subscription is owned by a person but explicitly sponsors one household.
// Manual and beta grants use the same resolver path without inventing a fake
// payment provider or a global beta bypass.
export const householdEntitlements = pgTable('household_entitlements', {
  id: uuid('id').primaryKey().defaultRandom(),
  householdId: uuid('household_id').notNull().references(() => households.id, { onDelete: 'cascade' }),
  subscriptionId: uuid('subscription_id').references(() => billingSubscriptions.id, { onDelete: 'cascade' }),
  source: householdEntitlementSource('source').notNull(),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull().defaultNow(),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  grantedBy: uuid('granted_by'),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('household_entitlements_household_validity_idx').on(table.householdId, table.endsAt),
  index('household_entitlements_subscription_idx').on(table.subscriptionId),
])

export const householdAiWeeklyUsage = pgTable('household_ai_weekly_usage', {
  householdId: uuid('household_id').notNull().references(() => households.id, { onDelete: 'cascade' }),
  weekStartDate: date('week_start_date', { mode: 'string' }).notNull(),
  usageKind: householdAiUsageKind('usage_kind').notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.householdId, table.weekStartDate, table.usageKind], name: 'household_ai_weekly_usage_pk' }),
])
