import { OpenAPIHono } from '@hono/zod-openapi'
import { secureHeaders } from 'hono/secure-headers'
import { buildActiveWeekRoutes } from './active-week.js'
import { buildHouseholdsRoutes, buildInternalHouseholdsRoutes } from './households.js'
import { buildHouseholdProfileRoutes, buildInternalHouseholdProfileRoutes } from './household-profile.js'
import { buildInvitesRoutes, buildInternalInvitesRoutes } from './invites.js'
import { buildWeekPlanRoutes } from './week-plan.js'
import { buildShoppingListRoutes } from './shopping-list.js'
import { buildInternalRecipesRoutes, buildRecipesRoutes } from './recipes.js'
import { buildInternalRecipeFillInRoutes, buildRecipeFillInRoutes } from './recipe-fill-in.js'
import { buildInternalRecipeImportRoutes, buildRecipeImportRoutes } from './recipe-import.js'
import { buildInternalRecipeRecommendationRoutes, buildRecipeRecommendationRoutes } from './recipe-recommendations.js'
import { buildInternalMealFeedbackRoutes, buildMealFeedbackRoutes } from './meal-feedback.js'
import { buildInternalSavedPlansRoutes, buildSavedPlansRoutes } from './saved-plans.js'
import { buildInternalPrepBatchesRoutes, buildPrepBatchesRoutes } from './prep-batches.js'
import type { Db } from './db.js'

export function buildApp(db: Db) {
  const app = new OpenAPIHono()

  app.use(secureHeaders())

  // Internal server-to-server routes (MealPlanner strangle path)
  app.route('/', buildInternalHouseholdsRoutes(db))
  app.route('/', buildInternalHouseholdProfileRoutes(db))
  app.route('/', buildInternalInvitesRoutes(db))
  app.route('/', buildInternalMealFeedbackRoutes(db))
  app.route('/', buildInternalRecipesRoutes(db))
  app.route('/', buildInternalRecipeFillInRoutes())
  app.route('/', buildInternalRecipeImportRoutes())
  app.route('/', buildInternalRecipeRecommendationRoutes())
  app.route('/', buildInternalSavedPlansRoutes(db))
  app.route('/', buildInternalPrepBatchesRoutes(db))

  // Public client-facing routes
  app.route('/', buildActiveWeekRoutes(db))
  app.route('/', buildHouseholdsRoutes(db))
  app.route('/', buildHouseholdProfileRoutes(db))
  app.route('/', buildInvitesRoutes(db))
  app.route('/', buildWeekPlanRoutes(db))
  app.route('/', buildShoppingListRoutes(db))
  app.route('/', buildRecipesRoutes(db))
  app.route('/', buildRecipeFillInRoutes())
  app.route('/', buildRecipeImportRoutes())
  app.route('/', buildRecipeRecommendationRoutes())
  app.route('/', buildMealFeedbackRoutes(db))
  app.route('/', buildSavedPlansRoutes(db))
  app.route('/', buildPrepBatchesRoutes(db))

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
    console.error('Unhandled error', err)
    return c.json({ error: 'Internal server error' }, 500)
  })

  return app
}
