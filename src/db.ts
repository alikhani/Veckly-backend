import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.js'

export function createDb(connectionString: string) {
  const client = postgres(connectionString, { prepare: false, max: 1 })
  return drizzle(client, { schema })
}

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required')

export const db = createDb(databaseUrl)
export type Db = ReturnType<typeof createDb>
