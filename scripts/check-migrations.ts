// Read-only drift check: every object a committed migration creates must exist
// in the target database. Vercel deploys never run migrations (see
// docs/runbooks/migration-and-rollback-runbook.md), and twice code has shipped
// ahead of its migrations — this is the pre-deploy gate that catches it.
//
//   DATABASE_URL=<target> npm run db:check
//
// Objects dropped or renamed by a later migration are skipped. Exits 1 and
// lists the missing objects (with the migration that creates them) on drift.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

type Expectation = { migration: string; kind: string; name: string; query: string; params: string[] }

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const ident = String.raw`"?([\w]+)"?`
const qualified = String.raw`(?:"?public"?\.)?${ident}`

function collect(): Expectation[] {
  const files = fs.readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort()
  const expectations: Expectation[] = []
  const dropped = new Set<string>()
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8').replace(/--(?!>).*$/gm, '')
    const migration = file.replace(/\.sql$/, '')
    const add = (kind: string, name: string, query: string, params: string[]) => {
      dropped.delete(`${kind}:${name}`)
      expectations.push({ migration, kind, name, query, params })
    }
    for (const statement of sql.split(/;|-->\s*statement-breakpoint/i)) {
      let m: RegExpMatchArray | null
      if ((m = statement.match(new RegExp(String.raw`CREATE TABLE (?:IF NOT EXISTS )?${qualified}`, 'i')))) {
        add('table', m[1]!, `select to_regclass('public.' || quote_ident($1)) is not null as ok`, [m[1]!])
      }
      if ((m = statement.match(new RegExp(String.raw`CREATE TYPE ${qualified}`, 'i')))) {
        add('type', m[1]!, `select exists(select 1 from pg_type where typname = $1) as ok`, [m[1]!])
      }
      if ((m = statement.match(new RegExp(String.raw`ALTER TYPE ${qualified} ADD VALUE (?:IF NOT EXISTS )?'([^']+)'`, 'i')))) {
        add('enum value', `${m[1]}.${m[2]}`, `select exists(select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = $1 and e.enumlabel = $2) as ok`, [m[1]!, m[2]!])
      }
      if ((m = statement.match(new RegExp(String.raw`CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?${ident}`, 'i')))) {
        add('index', m[1]!, `select exists(select 1 from pg_indexes where schemaname = 'public' and indexname = $1) as ok`, [m[1]!])
      }
      if ((m = statement.match(new RegExp(String.raw`CREATE POLICY "([^"]+)"\s+ON ${qualified}`, 'i')))) {
        add('policy', `${m[2]}.${m[1]}`, `select exists(select 1 from pg_policies where tablename = $1 and policyname = $2) as ok`, [m[2]!, m[1]!])
      }
      const table = statement.match(new RegExp(String.raw`ALTER TABLE (?:ONLY )?${qualified}`, 'i'))?.[1]
      if (table) {
        for (const c of statement.matchAll(new RegExp(String.raw`ADD COLUMN (?:IF NOT EXISTS )?${ident}`, 'gi'))) {
          add('column', `${table}.${c[1]}`, `select exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name = $2) as ok`, [table, c[1]!])
        }
        for (const c of statement.matchAll(new RegExp(String.raw`ADD CONSTRAINT ${ident}`, 'gi'))) {
          add('constraint', c[1]!, `select exists(select 1 from pg_constraint where conname = $1) as ok`, [c[1]!])
        }
        for (const c of statement.matchAll(new RegExp(String.raw`DROP COLUMN (?:IF EXISTS )?${ident}`, 'gi'))) dropped.add(`column:${table}.${c[1]}`)
        for (const c of statement.matchAll(new RegExp(String.raw`DROP CONSTRAINT (?:IF EXISTS )?${ident}`, 'gi'))) dropped.add(`constraint:${c[1]}`)
        for (const c of statement.matchAll(new RegExp(String.raw`RENAME COLUMN ${ident}`, 'gi'))) dropped.add(`column:${table}.${c[1]}`)
        for (const c of statement.matchAll(new RegExp(String.raw`RENAME TO ${ident}`, 'gi'))) { dropped.add(`table:${table}`); void c }
      }
      if ((m = statement.match(new RegExp(String.raw`DROP TABLE (?:IF EXISTS )?${qualified}`, 'i')))) dropped.add(`table:${m[1]}`)
      if ((m = statement.match(new RegExp(String.raw`DROP INDEX (?:IF EXISTS )?${qualified}`, 'i')))) dropped.add(`index:${m[1]}`)
      if ((m = statement.match(new RegExp(String.raw`DROP POLICY (?:IF EXISTS )?"([^"]+)"\s+ON ${qualified}`, 'i')))) dropped.add(`policy:${m[2]}.${m[1]}`)
      if ((m = statement.match(new RegExp(String.raw`DROP TYPE (?:IF EXISTS )?${qualified}`, 'i')))) dropped.add(`type:${m[1]}`)
    }
  }
  return expectations.filter((e) => !dropped.has(`${e.kind}:${e.name}`))
}

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required')
const sql = postgres(databaseUrl, { prepare: false, max: 1 })
try {
  const expectations = collect()
  const missing: Expectation[] = []
  for (const expectation of expectations) {
    const [row] = await sql.unsafe<{ ok: boolean }[]>(expectation.query, expectation.params)
    if (!row?.ok) missing.push(expectation)
  }
  const host = new URL(databaseUrl).host
  if (missing.length === 0) {
    console.log(`OK: all ${expectations.length} migration objects exist on ${host}`)
  } else {
    console.error(`DRIFT on ${host}: ${missing.length} of ${expectations.length} migration objects missing`)
    for (const m of missing) console.error(`  ${m.migration}  ${m.kind}  ${m.name}`)
    process.exitCode = 1
  }
} finally {
  await sql.end()
}
