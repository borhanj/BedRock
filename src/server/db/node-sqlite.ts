/**
 * SqlDatabase over node:sqlite — the dev server and the test suite.
 *
 * Node 24 ships SQLite in core, so this needs no native module and no build
 * step. The SQL it runs is byte-for-byte the SQL the Worker sends to D1.
 */

import { DatabaseSync } from 'node:sqlite'
import type { SqlDatabase, SqlValue } from './adapter'

export interface NodeSqlDatabase extends SqlDatabase {
  close(): void
  readonly raw: DatabaseSync
}

export function openNodeDatabase(location = ':memory:'): NodeSqlDatabase {
  const raw = new DatabaseSync(location)
  // Off by default in SQLite. Bedrock's schema leans on the references it
  // declares, so a dangling fund_id should fail loudly rather than persist.
  raw.exec('PRAGMA foreign_keys = ON')

  return {
    raw,
    async all<T>(sql: string, params: SqlValue[] = []) {
      return raw.prepare(sql).all(...params) as T[]
    },
    async get<T>(sql: string, params: SqlValue[] = []) {
      const row = raw.prepare(sql).get(...params)
      return (row ?? null) as T | null
    },
    async run(sql: string, params: SqlValue[] = []) {
      const result = raw.prepare(sql).run(...params)
      return { changes: Number(result.changes) }
    },
    async exec(sql: string) {
      raw.exec(sql)
    },
    close() {
      raw.close()
    },
  }
}
