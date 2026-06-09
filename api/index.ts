import { handle } from '@hono/node-server/vercel'
import { buildApp } from '../src/app.js'
import { db } from '../src/db.js'

export const config = { api: { bodyParser: false } }

const app = buildApp(db)

export default handle(app)
