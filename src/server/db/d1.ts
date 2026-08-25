/**
 * SqlDatabase over Cloudflare D1 — production.
 *
 * The typings are declared locally rather than pulled from
 * @cloudflare/workers-types so this file, and the tests that import the module
 * graph around it, need no Workers toolchain installed. The shape is small and
 * stable; swap in the real types when wrangler arrives at deploy time.
 */

import { chunkStatements, type SqlDatabase, type SqlStatement, type SqlValue } from './adapter'

export interface D1PreparedStatement {
  bind(...values: SqlValue[]): D1PreparedStatement
  all<T = unknown>(): Promise<{ results: T[] }>
  first<T = unknown>(): Promise<T | null>
  run(): Promise<{ meta: { changes: number } }>
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement
  /** Sent as one request, and applied as one implicit transaction. */
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>
}

export function openD1(d1: D1Database): SqlDatabase {
  const bind = (sql: string, params: SqlValue[]) => {
    const stmt = d1.prepare(sql)
    return params.length > 0 ? stmt.bind(...params) : stmt
  }

  return {
    async all<T>(sql: string, params: SqlValue[] = []) {
      const { results } = await bind(sql, params).all<T>()
      return results
    },
    async get<T>(sql: string, params: SqlValue[] = []) {
      return await bind(sql, params).first<T>()
    },
    async run(sql: string, params: SqlValue[] = []) {
      const { meta } = await bind(sql, params).run()
      return { changes: meta.changes }
    },
    async batch(statements: readonly SqlStatement[]) {
      // D1's own batch: one round trip per chunk, and each chunk is an
      // implicit transaction, so a statement that fails takes its chunk with
      // it rather than leaving a partial write on the books.
      for (const chunk of chunkStatements(statements)) {
        await d1.batch(chunk.map((s) => bind(s.sql, s.params ?? [])))
      }
    },
    async exec() {
      // D1's own exec() requires one statement per line, which mangles the
      // multi-line CREATE TRIGGER bodies in 0001_core.sql. Migrations against
      // a real D1 database go through wrangler, which parses the file properly.
      throw new Error(
        'Multi-statement exec is not supported on D1. Apply migrations with ' +
          '`wrangler d1 migrations apply bedrock` instead.',
      )
    },
  }
}
