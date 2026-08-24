/**
 * Migration runner for the node:sqlite path — the dev server and the tests.
 *
 * NODE ONLY. The Worker never imports this module: against a real D1 database
 * migrations are applied by `wrangler d1 migrations apply bedrock`, reading the
 * same directory in the same filename order. This runner exists so the dev
 * server and the test suite can build an identical schema without wrangler.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SqlDatabase } from './adapter'

export interface Migration {
  /** Filename without the extension, e.g. "0001_core". */
  readonly name: string
  readonly sql: string
}

const MIGRATIONS_DIR = join(process.cwd(), 'src', 'server', 'db', 'migrations')

/**
 * Every .sql file in the migrations directory, in filename order.
 *
 * The NNNN_name.sql convention is wrangler's, so the ordering here and the
 * ordering wrangler applies in production are the same by construction.
 */
export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  if (!existsSync(dir)) {
    throw new Error(
      `No migrations directory at ${dir}. This runner resolves it relative to ` +
        `the working directory, so run vite and vitest from the project root.`,
    )
  }
  return readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => ({
      name: file.replace(/\.sql$/, ''),
      sql: readFileSync(join(dir, file), 'utf8'),
    }))
}

/** Applies any migration not already recorded. Returns the names it ran. */
export async function migrate(db: SqlDatabase, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `)

  const applied = new Set(
    (await db.all<{ name: string }>('SELECT name FROM schema_migrations')).map(
      (row) => row.name,
    ),
  )

  const ran: string[] = []
  for (const migration of loadMigrations(dir)) {
    if (applied.has(migration.name)) continue
    await db.exec(migration.sql)
    await db.run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', [
      migration.name,
      new Date().toISOString(),
    ])
    ran.push(migration.name)
  }
  return ran
}
