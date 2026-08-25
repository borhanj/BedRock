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

export interface SqlStatement {
  readonly sql: string
  readonly params?: SqlValue[]
}

export interface SqlDatabase {
  /** Every matching row. */
  all<T = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): Promise<T[]>
  /** The first row, or null. */
  get<T = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): Promise<T | null>
  /** A write. Returns rows affected where the driver reports it. */
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number }>
  /**
   * Many writes, in order, as one unit — all of them or none.
   *
   * This exists because of what a `run` costs in production. Against
   * node:sqlite a write is a function call; against D1 it is a network round
   * trip, and a Worker is allowed a bounded number of those per request. A
   * loop of `run` over the rows of a bank statement is therefore not merely
   * slow at volume, it stops working: a large enough import or restore
   * exhausts the subrequest budget and fails part-written.
   *
   * The obvious alternative — one INSERT with a thousand placeholders — is not
   * available. D1 caps a single statement at 100 bound parameters, so a
   * multi-row VALUES list breaks somewhere around the twentieth row.
   *
   * Callers pass every statement they mean to write and let the implementation
   * decide how to get them there. Both send them in chunks, and both wrap a
   * chunk in a transaction, so a failure rolls its chunk back rather than
   * leaving half a row's worth of one behind.
   */
  batch(statements: readonly SqlStatement[]): Promise<void>
  /** Statements applied in order. Used by the migration runner and seeds. */
  exec(sql: string): Promise<void>
}

/**
 * How many statements go to the database at once.
 *
 * Bounded because a batch is one request: D1 has a request size limit, and a
 * ten-thousand-row restore sent as a single array would meet it. A hundred
 * turns a thousand round trips into ten, which is the whole of the win —
 * pushing it higher buys almost nothing and risks the ceiling.
 */
export const BATCH_SIZE = 100

/** The statements of a batch, in chunks of at most BATCH_SIZE. */
export function chunkStatements(
  statements: readonly SqlStatement[],
): Array<readonly SqlStatement[]> {
  const chunks: Array<readonly SqlStatement[]> = []
  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    chunks.push(statements.slice(i, i + BATCH_SIZE))
  }
  return chunks
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
