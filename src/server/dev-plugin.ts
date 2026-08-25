/**
 * Mounts the API into the Vite dev server.
 *
 * The database is a node:sqlite instance, migrated and seeded on first
 * request. Same schema, same SQL, same handler as production — only the
 * driver differs.
 *
 * It is in-memory by default, so a restart gives a clean known state. Set
 * BEDROCK_DEV_DB to a file path to keep data across restarts, which is worth
 * doing while working on the import flow.
 *
 * Set BEDROCK_DEV_EMPTY=1 to skip the seed and get what a treasurer installing
 * this actually gets: the schema and nothing in it. It is the only way to
 * reach the setup screen, since a seeded database is by definition already set
 * up. `npm run dev:empty` does it.
 */

import type { Connect, Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleApi } from './api'
import { migrate } from './db/migrate'
import { openNodeDatabase, type NodeSqlDatabase } from './db/node-sqlite'
import { ASSEMBLY_ID, SEED_TODAY, seed } from './seed'

async function build(): Promise<NodeSqlDatabase> {
  const location = process.env.BEDROCK_DEV_DB || ':memory:'
  const db = openNodeDatabase(location)
  const ran = await migrate(db)
  // Only seed a database that has just been created, or a file-backed one
  // would gain a second copy of the worked year on every restart.
  const empty = process.env.BEDROCK_DEV_EMPTY === '1'
  const seeded = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM assemblies')
  if (empty) {
    if ((seeded?.n ?? 0) === 0) {
      console.log('[bedrock] no worked year — open the books at /setup')
    }
  } else if ((seeded?.n ?? 0) === 0) {
    await seed(db)
  }
  if (ran.length > 0 && location !== ':memory:') {
    console.log(`[bedrock] applied ${ran.join(', ')} to ${location}`)
  }
  return db
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function bedrockDevApi(): Plugin {
  let ready: Promise<NodeSqlDatabase> | null = null

  return {
    name: 'bedrock-dev-api',
    apply: 'serve',
    configureServer(server) {
      const middleware: Connect.NextHandleFunction = (req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next()

        ready ??= build()
        ready
          .then(async (db) => {
            const method = (req.method ?? 'GET').toUpperCase()
            const body =
              method === 'GET' || method === 'HEAD' ? undefined : await readBody(req)

            const request = new Request(`http://localhost${req.url}`, {
              method,
              headers: { 'content-type': 'application/json' },
              body,
            })

            // Pinned to the seeded timeline, keeping the wall-clock time of
            // day so writes still order correctly. Otherwise the demo records
            // a report as presented days before the date it thinks it is.
            const now = `${SEED_TODAY}T${new Date().toISOString().slice(11)}`
            const response = await handleApi(request, {
              db,
              assemblyId: ASSEMBLY_ID,
              actor: 'dev@localhost',
              // Pinned so the seeded year lines up with the worked example.
              today: SEED_TODAY,
              now,
            })
            if (!response) return next()
            await write(res, response)
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.stack : String(error)
            res.statusCode = 500
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ error: message }))
          })
      }

      server.middlewares.use(middleware)
    },
  }
}

async function write(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status
  response.headers.forEach((value, key) => res.setHeader(key, value))
  res.end(await response.text())
}
