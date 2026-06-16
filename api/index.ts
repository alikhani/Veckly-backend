import type { IncomingMessage, ServerResponse } from 'node:http'
import { buildApp } from '../src/app.js'
import { db } from '../src/db.js'

export const config = { api: { bodyParser: false } }

const app = buildApp(db)

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  const rawBody = hasBody ? await readBody(req) : undefined

  const host = req.headers.host ?? 'localhost'
  const url = new URL(req.url ?? '/', `https://${host}`)

  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    const values = Array.isArray(value) ? value : [value]
    for (const v of values) headers.append(key, v)
  }

  const webReq = new Request(url.toString(), {
    method: req.method ?? 'GET',
    headers,
    body: rawBody && rawBody.length > 0 ? rawBody : undefined,
  })

  const webRes = await app.fetch(webReq)

  res.statusCode = webRes.status
  webRes.headers.forEach((value, key) => res.setHeader(key, value))

  const buffer = Buffer.from(await webRes.arrayBuffer())
  res.end(buffer)
}
