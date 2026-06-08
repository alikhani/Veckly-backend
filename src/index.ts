import { serve } from '@hono/node-server'
import { buildApp } from './app.js'
import { db } from './db.js'

const app = buildApp(db)
const port = Number(process.env.PORT ?? 3001)

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Veckly backend listening on http://localhost:${info.port}`)
})
