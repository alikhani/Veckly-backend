import { OpenAPIHono } from '@hono/zod-openapi'
import { buildActiveWeekRoutes } from './active-week.js'
import { buildHouseholdsRoutes, buildInternalHouseholdsRoutes } from './households.js'
import { buildHouseholdProfileRoutes } from './household-profile.js'
import { buildInvitesRoutes, buildInternalInvitesRoutes } from './invites.js'
import { buildWeekPlanRoutes } from './week-plan.js'
import { buildShoppingListRoutes } from './shopping-list.js'
import { buildRecipesRoutes } from './recipes.js'
import { buildMealFeedbackRoutes } from './meal-feedback.js'
import type { Db } from './db.js'

export function buildApp(db: Db) {
  const app = new OpenAPIHono()

  app.route('/', buildActiveWeekRoutes(db))
  app.route('/', buildHouseholdsRoutes(db))
  app.route('/', buildHouseholdProfileRoutes(db))
  app.route('/', buildInternalHouseholdsRoutes(db))
  app.route('/', buildInternalInvitesRoutes(db))
  app.route('/', buildInvitesRoutes(db))
  app.route('/', buildWeekPlanRoutes(db))
  app.route('/', buildShoppingListRoutes(db))
  app.route('/', buildRecipesRoutes(db))
  app.route('/', buildMealFeedbackRoutes(db))

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

  return app
}
