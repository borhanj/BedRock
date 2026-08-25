/**
 * SqlDatabase over node:sqlite — the dev server and the test suite.
 *
 * Node 24 ships SQLite in core, so this needs no native module and no build
 * step. The SQL it runs is byte-for-byte the SQL the Worker sends to D1.
 */

import { DatabaseSync } from 'node:sqlite'
import { chunkStatements, type SqlDatabase, type SqlStatement, type SqlValue } from './adapter'

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
    async batch(statements: readonly SqlStatement[]) {
      // Chunked exactly as D1 chunks it, and wrapped the same way. A batch
      // that fails has to leave the same state behind in both, or a test
      // asserting that a bad restore wrote nothing would pass here and be
      // untrue in production.
      for (const chunk of chunkStatements(statements)) {
        raw.exec('BEGIN')
        try {
          for (const statement of chunk) {
            raw.prepare(statement.sql).run(...(statement.params ?? []))
          }
          raw.exec('COMMIT')
        } catch (error) {
          raw.exec('ROLLBACK')
          throw error
        }
      }
    },
    async exec(sql: string) {
      raw.exec(sql)
    },
    close() {
      raw.close()
    },
  }
}
