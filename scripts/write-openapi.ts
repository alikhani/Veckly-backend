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

const spec = await response.json()
const formattedSpec = `${JSON.stringify(spec, null, 2)}\n`
const resolvedOutputPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', outputPath)

await mkdir(path.dirname(resolvedOutputPath), { recursive: true })
await writeFile(resolvedOutputPath, formattedSpec)

console.log(`Wrote ${resolvedOutputPath}`)
