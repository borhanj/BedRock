/**
 * Bank reconciliation: proving the ledger against the statement.
 *
 * The arithmetic is the classic one. At the statement date the bank's balance
 * is whatever the account opened with plus everything that has actually
 * cleared it. Tick off what the statement shows, and the difference between
 * that figure and the statement's own ending balance must come to nothing.
 *
 * When it does not, the difference is the point. There is no adjustment entry
 * here and no way to force a balance: a plug makes the books agree with the
 * bank while burying the reason they did not, and finding that reason is the
 * whole purpose of the exercise. `completeReconciliation` refuses anything but
 * zero, and says by how much.
 */

import type { Cents } from '../../lib/money'
import type { SqlDatabase } from '../db/adapter'
import { setAuditActor } from '../db/adapter'

/** A reconciliation step that cannot be taken, with the reason. */
export class ReconcileError extends Error {}

export type ReconcileStatus = 'open' | 'balanced'

export interface ReconcileItemView {
  readonly id: string
  readonly occurredOn: string
  readonly payee: string | null
  readonly memo: string | null
  readonly amountCents: Cents
  readonly method: string
  readonly kind: string
  readonly isCleared: boolean
}

export interface ReconciliationView {
  readonly id: string
  readonly accountId: string
  readonly accountName: string
  readonly statementEndedOn: string
  readonly statementBalanceCents: Cents
  readonly status: ReconcileStatus
  readonly completedAt: string | null
  readonly completedBy: string | null
  /** What the account opened with, before any transaction. */
  readonly openingCents: Cents
  /** Cleared on an earlier statement, and still part of the bank's balance. */
  readonly clearedEarlierCents: Cents
  readonly clearedHereCents: Cents
  /** Opening plus everything ever cleared. What the bank should be showing. */
  readonly reconciledBalanceCents: Cents
  /** The statement, less the books. Zero, or the exercise is not finished. */
  readonly differenceCents: Cents
  /** Written but not yet through the bank — cheques out, deposits in transit. */
  readonly outstandingCents: Cents
  readonly outstandingCount: number
  readonly items: readonly ReconcileItemView[]
}

export interface ReconciliationSummary {
  readonly id: string
  readonly accountId: string
  readonly accountName: string
  readonly statementEndedOn: string
  readonly statementBalanceCents: Cents
  readonly status: ReconcileStatus
  readonly completedAt: string | null
  readonly differenceCents: Cents
}

/** Everything cleared on this account, on any statement. */
async function clearedTotal(
  db: SqlDatabase,
  accountId: string,
  exceptReconciliation?: string,
): Promise<Cents> {
  const row = await db.get<{ cents: number }>(
    `SELECT COALESCE(SUM(t.amount_cents), 0) AS cents
       FROM reconciliation_items i
       JOIN transactions t ON t.id = i.transaction_id
      WHERE t.account_id = ?
        AND (? IS NULL OR i.reconciliation_id <> ?)`,
    [accountId, exceptReconciliation ?? null, exceptReconciliation ?? ''],
  )
  return row?.cents ?? 0
}

export async function listReconciliations(
  db: SqlDatabase,
  assemblyId: string,
): Promise<ReconciliationSummary[]> {
  const rows = await db.all<{
    id: string
    account_id: string
    account_name: string
    statement_ended_on: string
    statement_balance_cents: number
    status: ReconcileStatus
    completed_at: string | null
    opening: number
    cleared: number
  }>(
    `SELECT r.id, r.account_id, a.name AS account_name, r.statement_ended_on,
            r.statement_balance_cents, r.status, r.completed_at,
            a.opening_balance_cents AS opening,
            COALESCE((SELECT SUM(t.amount_cents)
                        FROM reconciliation_items i
                        JOIN transactions t ON t.id = i.transaction_id
                       WHERE t.account_id = r.account_id), 0) AS cleared
       FROM reconciliations r
       JOIN accounts a ON a.id = r.account_id
      WHERE r.assembly_id = ?
      ORDER BY r.statement_ended_on DESC, r.id DESC`,
    [assemblyId],
  )

  return rows.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    accountName: r.account_name,
    statementEndedOn: r.statement_ended_on,
    statementBalanceCents: r.statement_balance_cents,
    status: r.status,
    completedAt: r.completed_at,
    differenceCents: r.statement_balance_cents - (r.opening + r.cleared),
  }))
}

export async function loadReconciliation(
  db: SqlDatabase,
  assemblyId: string,
  id: string,
): Promise<ReconciliationView | null> {
  const header = await db.get<{
    id: string
    account_id: string
    account_name: string
    opening: number
    statement_ended_on: string
    statement_balance_cents: number
    status: ReconcileStatus
    completed_at: string | null
    completed_by: string | null
  }>(
    `SELECT r.id, r.account_id, a.name AS account_name,
            a.opening_balance_cents AS opening,
            r.statement_ended_on, r.statement_balance_cents, r.status,
            r.completed_at, r.completed_by
       FROM reconciliations r
       JOIN accounts a ON a.id = r.account_id
      WHERE r.assembly_id = ? AND r.id = ?`,
    [assemblyId, id],
  )
  if (!header) return null

  // What is on the table: rows this statement has already ticked, plus
  // anything on the account not yet cleared by any statement and dated on or
  // before the statement's end.
  //
  // Uncleared rows from earlier months are candidates too, and deliberately so
  // — an outstanding cheque from two months ago is exactly the sort of thing
  // that finally appears on a later statement, and hiding it would leave the
  // treasurer with a difference and nothing to attribute it to.
  const rows = await db.all<{
    id: string
    occurred_on: string
    payee: string | null
    memo: string | null
    amount_cents: number
    method: string
    kind: string
    cleared_here: number
  }>(
    `SELECT t.id, t.occurred_on, t.payee, t.memo, t.amount_cents, t.method, t.kind,
            CASE WHEN i.reconciliation_id IS NULL THEN 0 ELSE 1 END AS cleared_here
       FROM transactions t
       LEFT JOIN reconciliation_items i
              ON i.transaction_id = t.id AND i.reconciliation_id = ?
      WHERE t.assembly_id = ? AND t.account_id = ?
        AND (i.reconciliation_id IS NOT NULL
             OR (t.occurred_on <= ?
                 AND NOT EXISTS (SELECT 1 FROM reconciliation_items x
                                  WHERE x.transaction_id = t.id)))
      ORDER BY t.occurred_on ASC, t.id ASC`,
    [id, assemblyId, header.account_id, header.statement_ended_on],
  )

  const items = rows.map((r) => ({
    id: r.id,
    occurredOn: r.occurred_on,
    payee: r.payee,
    memo: r.memo,
    amountCents: r.amount_cents,
    method: r.method,
    kind: r.kind,
    isCleared: r.cleared_here === 1,
  }))

  const clearedHereCents = items
    .filter((i) => i.isCleared)
    .reduce((sum, i) => sum + i.amountCents, 0)
  const clearedEarlierCents = await clearedTotal(db, header.account_id, id)
  const reconciledBalanceCents = header.opening + clearedEarlierCents + clearedHereCents
  const outstanding = items.filter((i) => !i.isCleared)

  return {
    id: header.id,
    accountId: header.account_id,
    accountName: header.account_name,
    statementEndedOn: header.statement_ended_on,
    statementBalanceCents: header.statement_balance_cents,
    status: header.status,
    completedAt: header.completed_at,
    completedBy: header.completed_by,
    openingCents: header.opening,
    clearedEarlierCents,
    clearedHereCents,
    reconciledBalanceCents,
    differenceCents: header.statement_balance_cents - reconciledBalanceCents,
    outstandingCents: outstanding.reduce((sum, i) => sum + i.amountCents, 0),
    outstandingCount: outstanding.length,
    items,
  }
}

export interface NewReconciliation {
  readonly accountId: string
  readonly statementEndedOn: string
  readonly statementBalanceCents: Cents
}

export async function startReconciliation(
  db: SqlDatabase,
  assemblyId: string,
  input: NewReconciliation,
  actor: string,
  now: string,
): Promise<ReconciliationView> {
  await setAuditActor(db, actor)

  if (!Number.isInteger(input.statementBalanceCents)) {
    throw new ReconcileError('A statement balance must be a whole number of cents.')
  }

  const account = await db.get<{ id: string }>(
    'SELECT id FROM accounts WHERE assembly_id = ? AND id = ?',
    [assemblyId, input.accountId],
  )
  if (!account) throw new ReconcileError('No such account.')

  const clash = await db.get<{ id: string }>(
    `SELECT id FROM reconciliations
      WHERE assembly_id = ? AND account_id = ? AND statement_ended_on = ?`,
    [assemblyId, input.accountId, input.statementEndedOn],
  )
  if (clash) {
    throw new ReconcileError(
      `A statement ending ${input.statementEndedOn} has already been started for this account.`,
    )
  }

  const id = `rec-${input.accountId}-${input.statementEndedOn}`
  await db.run(
    `INSERT INTO reconciliations
       (id, assembly_id, account_id, statement_ended_on, statement_balance_cents,
        status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
    [
      id,
      assemblyId,
      input.accountId,
      input.statementEndedOn,
      input.statementBalanceCents,
      now,
      now,
    ],
  )

  return (await loadReconciliation(db, assemblyId, id))!
}

/** Amend the figure or the date read off the statement. Open ones only. */
export async function setStatement(
  db: SqlDatabase,
  assemblyId: string,
  id: string,
  statementEndedOn: string,
  statementBalanceCents: Cents,
  actor: string,
  now: string,
): Promise<ReconciliationView | null> {
  await setAuditActor(db, actor)

  const header = await db.get<{ status: ReconcileStatus }>(
    'SELECT status FROM reconciliations WHERE assembly_id = ? AND id = ?',
    [assemblyId, id],
  )
  if (!header) return null
  if (header.status === 'balanced') {
    throw new ReconcileError(
      'This reconciliation is balanced. Reopen it before changing the statement.',
    )
  }
  if (!Number.isInteger(statementBalanceCents)) {
    throw new ReconcileError('A statement balance must be a whole number of cents.')
  }

  await db.run(
    `UPDATE reconciliations
        SET statement_ended_on = ?, statement_balance_cents = ?, updated_at = ?
      WHERE assembly_id = ? AND id = ?`,
    [statementEndedOn, statementBalanceCents, now, assemblyId, id],
  )
  return loadReconciliation(db, assemblyId, id)
}

/**
 * Tick a row off the statement, or untick it.
 *
 * Works on a transaction inside a closed period, which is the point of keeping
 * this in its own table: a cheque written in Kamál can reach the bank in
 * ʿIzzat, long after Kamál's report has been presented. Whether the bank has
 * processed it is a fact about the bank, not an edit to the books.
 */
export async function setCleared(
  db: SqlDatabase,
  assemblyId: string,
  id: string,
  transactionId: string,
  cleared: boolean,
  actor: string,
  now: string,
): Promise<ReconciliationView | null> {
  await setAuditActor(db, actor)

  const header = await db.get<{ status: ReconcileStatus; account_id: string; ended: string }>(
    `SELECT status, account_id, statement_ended_on AS ended
       FROM reconciliations WHERE assembly_id = ? AND id = ?`,
    [assemblyId, id],
  )
  if (!header) return null
  if (header.status === 'balanced') {
    throw new ReconcileError(
      'This reconciliation is balanced. Reopen it before changing what has cleared.',
    )
  }

  const txn = await db.get<{ id: string }>(
    'SELECT id FROM transactions WHERE assembly_id = ? AND id = ? AND account_id = ?',
    [assemblyId, transactionId, header.account_id],
  )
  if (!txn) throw new ReconcileError('That transaction is not on this account.')

  if (cleared) {
    const elsewhere = await db.get<{ reconciliation_id: string }>(
      'SELECT reconciliation_id FROM reconciliation_items WHERE transaction_id = ?',
      [transactionId],
    )
    if (elsewhere && elsewhere.reconciliation_id !== id) {
      throw new ReconcileError(
        'That transaction has already cleared on another statement. It cannot clear twice.',
      )
    }
    await db.run(
      `INSERT INTO reconciliation_items (reconciliation_id, transaction_id, cleared_on)
       VALUES (?, ?, ?)
       ON CONFLICT (reconciliation_id, transaction_id) DO NOTHING`,
      [id, transactionId, header.ended],
    )
  } else {
    await db.run(
      'DELETE FROM reconciliation_items WHERE reconciliation_id = ? AND transaction_id = ?',
      [id, transactionId],
    )
  }

  await db.run('UPDATE reconciliations SET updated_at = ? WHERE id = ?', [now, id])
  return loadReconciliation(db, assemblyId, id)
}

/**
 * Declare the account reconciled.
 *
 * Only at a difference of exactly zero. The refusal names the amount, because
 * the amount is usually the clue: a figure equal to one transaction is a
 * missed tick, and a figure divisible by nine is very often two digits
 * transposed somewhere.
 */
export async function completeReconciliation(
  db: SqlDatabase,
  assemblyId: string,
  id: string,
  actor: string,
  now: string,
): Promise<ReconciliationView | null> {
  await setAuditActor(db, actor)

  const view = await loadReconciliation(db, assemblyId, id)
  if (!view) return null
  if (view.status === 'balanced') {
    throw new ReconcileError('This reconciliation is already balanced.')
  }
  if (view.differenceCents !== 0) {
    throw new ReconcileError(
      `The statement and the books differ by ${money(Math.abs(view.differenceCents))}. ` +
        'Find it before closing the reconciliation — there is no adjusting entry here, ' +
        'because one would hide exactly what this check exists to reveal.',
    )
  }

  await db.run(
    `UPDATE reconciliations
        SET status = 'balanced', completed_at = ?, completed_by = ?, updated_at = ?
      WHERE assembly_id = ? AND id = ?`,
    [now, actor, now, assemblyId, id],
  )
  return loadReconciliation(db, assemblyId, id)
}

/** Reopen a balanced reconciliation. Deliberate, and audited. */
export async function reopenReconciliation(
  db: SqlDatabase,
  assemblyId: string,
  id: string,
  actor: string,
  now: string,
): Promise<ReconciliationView | null> {
  await setAuditActor(db, actor)

  const header = await db.get<{ status: ReconcileStatus }>(
    'SELECT status FROM reconciliations WHERE assembly_id = ? AND id = ?',
    [assemblyId, id],
  )
  if (!header) return null
  if (header.status !== 'balanced') {
    throw new ReconcileError('This reconciliation is already open.')
  }

  await db.run(
    `UPDATE reconciliations
        SET status = 'open', completed_at = NULL, completed_by = NULL, updated_at = ?
      WHERE assembly_id = ? AND id = ?`,
    [now, assemblyId, id],
  )
  return loadReconciliation(db, assemblyId, id)
}

export interface ReconcileStanding {
  /** Null when no statement has ever been balanced. */
  readonly lastBalancedOn: string | null
  /**
   * Rows dated on or before the last balanced statement that still have not
   * cleared. Outstanding cheques age into this figure, which is the thing
   * worth chasing.
   */
  readonly unclearedCount: number
  readonly unclearedCents: Cents
}

/**
 * Where reconciliation stands, for the dashboard worklist.
 *
 * Reports null rather than zero when nothing has ever been reconciled. A
 * confident zero for a check that has never run is worse than saying the check
 * has never run.
 */
export async function reconcileStanding(
  db: SqlDatabase,
  assemblyId: string,
): Promise<ReconcileStanding> {
  const last = await db.get<{ ended: string }>(
    `SELECT MAX(statement_ended_on) AS ended
       FROM reconciliations WHERE assembly_id = ? AND status = 'balanced'`,
    [assemblyId],
  )
  if (!last?.ended) {
    return { lastBalancedOn: null, unclearedCount: 0, unclearedCents: 0 }
  }

  const row = await db.get<{ n: number; cents: number }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(t.amount_cents), 0) AS cents
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
      WHERE t.assembly_id = ? AND a.kind = 'bank' AND t.occurred_on <= ?
        AND NOT EXISTS (SELECT 1 FROM reconciliation_items i
                         WHERE i.transaction_id = t.id)`,
    [assemblyId, last.ended],
  )

  return {
    lastBalancedOn: last.ended,
    unclearedCount: row?.n ?? 0,
    unclearedCents: row?.cents ?? 0,
  }
}

/** Money inside an error message. The UI formats its own with Intl. */
function money(cents: Cents): string {
  const abs = Math.abs(cents)
  return `$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`
}
