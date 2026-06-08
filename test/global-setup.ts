import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDb } from '../src/db.js'
import { ensureMigrationsApplied, ensureAuthenticatedRoleGranted } from './migrations.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const migrationsDir = path.join(dirname, '..', 'migrations')

// Vitest runs test files in parallel worker processes — if each DB-touching
// suite applied migrations from its own beforeAll, they'd race on the same
// TEST_DATABASE_URL ("type already exists"). A global setup runs once, in the
// main process, before any worker starts, which is the only place "apply
// migrations exactly once" can be guaranteed without a database-level lock.
export default async function setup() {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL
  if (!testDatabaseUrl) return

  const db = createDb(testDatabaseUrl)
  await ensureMigrationsApplied(db, migrationsDir)
  await ensureAuthenticatedRoleGranted(db)
  await db.$client.end()
}
