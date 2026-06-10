import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.SUPABASE_URL ??= 'http://localhost'
process.env.SUPABASE_ANON_KEY ??= 'openapi-generation-only'

const { buildApp } = await import('../src/app.js')

const outputPath = process.argv[2] ?? 'openapi.json'
const app = buildApp({} as never)
const response = await app.request('/openapi.json')

if (!response.ok) {
  throw new Error(`Failed to generate OpenAPI spec: ${response.status}`)
}

const spec = normalizeOpenApi31(await response.json())
const formattedSpec = `${JSON.stringify(spec, null, 2)}\n`
const resolvedOutputPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', outputPath)

await mkdir(path.dirname(resolvedOutputPath), { recursive: true })
await writeFile(resolvedOutputPath, formattedSpec)

console.log(`Wrote ${resolvedOutputPath}`)

function normalizeOpenApi31(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeOpenApi31(item))
  if (!value || typeof value !== 'object') return value

  const record = value as Record<string, unknown>
  if (key === 'additionalProperties' && Object.keys(record).length === 1 && record.nullable === true) {
    return true
  }

  const normalized: Record<string, unknown> = {}
  for (const [entryKey, entryValue] of Object.entries(record)) {
    if (entryKey === 'nullable') continue
    normalized[entryKey] = normalizeOpenApi31(entryValue, entryKey)
  }

  if (record.nullable === true) {
    const type = normalized.type
    if (typeof type === 'string') {
      normalized.type = type === 'null' ? type : [type, 'null']
    } else if (Array.isArray(type)) {
      normalized.type = Array.from(new Set([...type, 'null']))
    } else if (Array.isArray(normalized.oneOf)) {
      normalized.oneOf = [...normalized.oneOf, { type: 'null' }]
    } else if (Array.isArray(normalized.anyOf)) {
      normalized.anyOf = [...normalized.anyOf, { type: 'null' }]
    }
  }

  return normalized
}
