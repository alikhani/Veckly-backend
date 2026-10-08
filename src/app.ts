import { OpenAPIHono } from '@hono/zod-openapi'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { secureHeaders } from 'hono/secure-headers'
import { buildActiveWeekRoutes } from './active-week.js'
import { buildFamilyMemoryRoutes } from './family-memory.js'
import { buildHouseholdMealSignalsRoutes } from './household-meal-signals.js'
import { buildMealOutcomesRoutes } from './meal-outcomes.js'
import { buildHouseholdSavedRecipesRoutes } from './household-saved-recipes.js'
import { buildHouseholdsRoutes, buildInternalHouseholdsRoutes } from './households.js'
import { buildHouseholdProfileRoutes, buildInternalHouseholdProfileRoutes } from './household-profile.js'
import { buildInvitesRoutes, buildInternalInvitesRoutes } from './invites.js'
import { buildWeekPlanRoutes } from './modules/week-plan/index.js'
import { buildShoppingListRoutes } from './modules/shopping-list/index.js'
import { buildShoppingPreferencesRoutes } from './shopping-preferences.js'
import { buildPortionMemoryRoutes } from './portion-memory.js'
import { buildInternalRecipesRoutes, buildRecipesRoutes } from './recipes.js'
import { buildInternalRecipeFillInRoutes, buildRecipeFillInRoutes } from './recipe-fill-in.js'
import { buildInternalRecipeImportRoutes, buildRecipeImportRoutes } from './recipe-import.js'
import { buildInternalRecipeRecommendationRoutes, buildRecipeRecommendationRoutes } from './recipe-recommendations.js'
import { buildInternalMealFeedbackRoutes, buildMealFeedbackRoutes } from './meal-feedback.js'
import { buildInternalSavedPlansRoutes, buildSavedPlansRoutes } from './saved-plans.js'
import { buildInternalPrepBatchesRoutes, buildPrepBatchesRoutes } from './prep-batches.js'
import { buildInternalUserProfileRoutes, buildUserProfileRoutes } from './user-profile.js'
import { buildProductEventsRoutes } from './product-events.js'
import { buildEntitlementRoutes } from './entitlement-routes.js'
import { buildAppStoreBillingRoutes } from './app-store-billing-routes.js'
import { buildWeekPulseRoutes } from './week-pulse.js'
import type { Db } from './db.js'
import { ApiError, ErrorResponseSchema, type ErrorCode } from './platform/http-errors.js'

export function buildApp(db: Db) {
  const app = new OpenAPIHono()

  app.use(cors({
    origin: process.env.ALLOWED_ORIGIN ?? 'http://localhost:3000',
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'Accept-Language', 'X-Veckly-Today'],
  }))
  app.use(secureHeaders())
  app.use('*', async (c, next) => {
    await next()
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store')
  })

  // Registered before any route so the shared error schemas keep one stable
  // position in openapi.json however many routes reference them.
  app.openAPIRegistry.register('ErrorResponse', ErrorResponseSchema)

  // Internal server-to-server routes (MealPlanner strangle path)
  app.route('/', buildInternalHouseholdsRoutes(db))
  app.route('/', buildInternalHouseholdProfileRoutes(db))
  app.route('/', buildInternalInvitesRoutes(db))
  app.route('/', buildInternalMealFeedbackRoutes(db))
  app.route('/', buildInternalRecipesRoutes(db))
  app.route('/', buildInternalRecipeFillInRoutes(db))
  app.route('/', buildInternalRecipeImportRoutes(db))
  app.route('/', buildInternalRecipeRecommendationRoutes(db))
  app.route('/', buildInternalSavedPlansRoutes(db))
  app.route('/', buildInternalPrepBatchesRoutes(db))
  app.route('/', buildInternalUserProfileRoutes(db))

  // Public client-facing routes
  app.route('/', buildActiveWeekRoutes(db))
  app.route('/', buildFamilyMemoryRoutes(db))
  app.route('/', buildHouseholdMealSignalsRoutes(db))
  app.route('/', buildMealOutcomesRoutes(db))
  app.route('/', buildHouseholdSavedRecipesRoutes(db))
  app.route('/', buildHouseholdsRoutes(db))
  app.route('/', buildHouseholdProfileRoutes(db))
  app.route('/', buildInvitesRoutes(db))
  app.route('/', buildWeekPlanRoutes(db))
  app.route('/', buildShoppingListRoutes(db))
  app.route('/', buildShoppingPreferencesRoutes(db))
  app.route('/', buildPortionMemoryRoutes(db))
  app.route('/', buildRecipesRoutes(db))
  app.route('/', buildRecipeFillInRoutes(db))
  app.route('/', buildRecipeImportRoutes(db))
  app.route('/', buildRecipeRecommendationRoutes(db))
  app.route('/', buildMealFeedbackRoutes(db))
  app.route('/', buildSavedPlansRoutes(db))
  app.route('/', buildPrepBatchesRoutes(db))
  app.route('/', buildUserProfileRoutes(db))
  app.route('/', buildProductEventsRoutes(db))
  app.route('/', buildEntitlementRoutes(db))
  app.route('/', buildAppStoreBillingRoutes(db))
  app.route('/', buildWeekPulseRoutes(db))

  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'Supabase access token',
  })

  app.doc('/openapi.json', {
    openapi: '3.1.0',
    info: { title: 'Veckly API', version: '0.0.1' },
  })

  app.get('/health', (c) => c.json({ status: 'ok' }))

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json(err.body, err.status)
    // Hono's request validator throws a 400 HTTPException when a JSON body
    // cannot be parsed. It is the only HTTPException source in the app (no
    // route validates form bodies); anything else still falls through to 500.
    if (err instanceof HTTPException && err.status === 400) return c.json({ error: 'INVALID_JSON' satisfies ErrorCode }, 400)
    console.error('Unhandled error', err)
    return c.json({ error: 'Internal server error' }, 500)
  })

  return app
}
