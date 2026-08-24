/**
 * The one SQL surface the whole server speaks.
 *
 * Bedrock talks to SQLite directly rather than through an ORM. D1 *is* SQLite,
 * and almost every query in this app is an aggregate — SUM over a date range,
 * GROUP BY fund, running balances. Those are the queries a query-builder makes
 * longer rather than shorter, and hand-written SQL means the exact same
 * statements run in the tests (node:sqlite) and in production (D1). Nothing is
 * translated between the two, so nothing can differ between them.
 *
 * Two implementations: ./node-sqlite.ts for dev and tests, ./d1.ts for the
 * Worker. Both are about thirty lines.
 */

export type SqlValue = string | number | null

export interface SqlDatabase {
  /** Every matching row. */
  all<T = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): Promise<T[]>
  /** The first row, or null. */
  get<T = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): Promise<T | null>
  /** A write. Returns rows affected where the driver reports it. */
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number }>
  /** Statements applied in order. Used by the migration runner and seeds. */
  exec(sql: string): Promise<void>
}

/**
 * Sets the actor recorded by the audit triggers for subsequent writes on this
 * connection. Call once per request, before any mutation.
 *
 * The triggers in 0001_core.sql read this table, which is why a mutation
 * cannot quietly land without an attributable actor: the trigger fires
 * regardless of which code path did the writing.
 */
export async function setAuditActor(db: SqlDatabase, actor: string): Promise<void> {
  await db.run(
    `INSERT INTO audit_actor (id, actor) VALUES (1, ?)
     ON CONFLICT (id) DO UPDATE SET actor = excluded.actor`,
    [actor],
  )
}
