/**
 * Receipts.
 *
 * Two rules shape this file.
 *
 * The numbering is GAPLESS. A missing number in a receipt book reads to an
 * auditor as a destroyed record, so a receipt is never deleted — a trigger in
 * 0001_core.sql refuses it outright. A mistake is voided, which keeps the
 * number and records why.
 *
 * The log is CONFIDENTIAL by default. Listing receipts returns amounts, dates,
 * funds and numbers without a PIN, because that is what reconciling and
 * auditing need. Donor names require the PIN and are fetched separately, so
 * the common case never decrypts anything.
 */

import type { Cents } from '../../lib/money'
import type { SqlDatabase } from '../db/adapter'
import { setAuditActor } from '../db/adapter'

export interface ReceiptView {
  readonly id: string
  readonly number: number
  readonly issuedOn: string
  readonly amountCents: Cents
  readonly method: string
  readonly fundLabel: string
  readonly note: string | null
  /** Opaque. Resolving it to a name needs the PIN; see repo/donors.ts. */
  readonly donorId: string | null
  readonly anonymous: boolean
  readonly voidedAt: string | null
  readonly voidReason: string | null
}

export interface UnreceiptedGift {
  readonly contributionId: string
  readonly occurredOn: string
  readonly amountCents: Cents
  readonly fundId: string
  readonly fundLabel: string
  readonly method: string
  readonly payee: string | null
  readonly donorId: string | null
}

export class ReceiptError extends Error {}

/**
 * The next number in the sequence.
 *
 * MAX + 1 rather than a count, so voided receipts still consume their number
 * and the sequence never reuses one. SQLite serialises writers and the
 * UNIQUE (assembly_id, number) index is the backstop if two ever race.
 */
export async function nextReceiptNumber(
  db: SqlDatabase,
  assemblyId: string,
): Promise<number> {
  const row = await db.get<{ next: number }>(
    'SELECT COALESCE(MAX(number), 0) + 1 AS next FROM receipts WHERE assembly_id = ?',
    [assemblyId],
  )
  return row?.next ?? 1
}

/** Contributions with no receipt yet — what the dashboard's worklist counts. */
export async function unreceiptedGifts(
  db: SqlDatabase,
  assemblyId: string,
): Promise<UnreceiptedGift[]> {
  const rows = await db.all<{
    contribution_id: string
    occurred_on: string
    amount_cents: number
    fund_id: string
    fund_label: string
    method: string
    payee: string | null
    donor_id: string | null
  }>(
    `SELECT c.id AS contribution_id, t.occurred_on, c.amount_cents,
            c.fund_id, f.label AS fund_label, t.method, t.payee, c.donor_id
       FROM contributions c
       JOIN transactions t ON t.id = c.transaction_id
       JOIN funds f ON f.id = c.fund_id
      WHERE c.assembly_id = ? AND c.receipt_id IS NULL
      ORDER BY t.occurred_on DESC, c.id`,
    [assemblyId],
  )
  return rows.map((r) => ({
    contributionId: r.contribution_id,
    occurredOn: r.occurred_on,
    amountCents: r.amount_cents,
    fundId: r.fund_id,
    fundLabel: r.fund_label,
    method: r.method,
    payee: r.payee,
    donorId: r.donor_id,
  }))
}

export interface IssueRequest {
  readonly contributionId: string
  /** Null for a gift given without a name. */
  readonly donorId: string | null
  readonly note: string | null
  readonly issuedOn: string
}

/** Issue a receipt for a contribution, taking the next number in the book. */
export async function issueReceipt(
  db: SqlDatabase,
  assemblyId: string,
  request: IssueRequest,
  actor: string,
): Promise<ReceiptView> {
  await setAuditActor(db, actor)

  const contribution = await db.get<{
    id: string
    amount_cents: number
    fund_id: string
    receipt_id: string | null
    method: string
  }>(
    `SELECT c.id, c.amount_cents, c.fund_id, c.receipt_id, t.method
       FROM contributions c
       JOIN transactions t ON t.id = c.transaction_id
      WHERE c.assembly_id = ? AND c.id = ?`,
    [assemblyId, request.contributionId],
  )
  if (!contribution) throw new ReceiptError('No such contribution.')
  if (contribution.receipt_id) {
    throw new ReceiptError('A receipt has already been issued for this contribution.')
  }

  const number = await nextReceiptNumber(db, assemblyId)
  const id = `rcpt-${assemblyId}-${number}`

  await db.run(
    `INSERT INTO receipts
       (id, assembly_id, number, issued_on, amount_cents, method, fund_id,
        donor_id, note, contribution_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      assemblyId,
      number,
      request.issuedOn,
      contribution.amount_cents,
      contribution.method,
      contribution.fund_id,
      request.donorId,
      request.note,
      contribution.id,
    ],
  )

  await db.run('UPDATE contributions SET receipt_id = ? WHERE id = ?', [
    id,
    contribution.id,
  ])
  // Keep the donor on the contribution too, so the household count on a Feast
  // report reflects a gift the moment it is attributed rather than only once
  // a receipt is written.
  if (request.donorId) {
    await db.run('UPDATE contributions SET donor_id = ? WHERE id = ?', [
      request.donorId,
      contribution.id,
    ])
  }

  const issued = await readReceipt(db, assemblyId, id)
  if (!issued) throw new ReceiptError('The receipt could not be read back.')
  return issued
}

const SELECT_RECEIPT = `
  SELECT r.id, r.number, r.issued_on, r.amount_cents, r.method, r.note,
         r.donor_id, r.voided_at, r.void_reason, f.label AS fund_label,
         COALESCE(d.is_anonymous, 0) AS anonymous
    FROM receipts r
    JOIN funds f ON f.id = r.fund_id
    LEFT JOIN donors d ON d.id = r.donor_id
`

interface ReceiptRow {
  id: string
  number: number
  issued_on: string
  amount_cents: number
  method: string
  note: string | null
  donor_id: string | null
  voided_at: string | null
  void_reason: string | null
  fund_label: string
  anonymous: number
}

const toView = (r: ReceiptRow): ReceiptView => ({
  id: r.id,
  number: r.number,
  issuedOn: r.issued_on,
  amountCents: r.amount_cents,
  method: r.method,
  fundLabel: r.fund_label,
  note: r.note,
  donorId: r.donor_id,
  anonymous: r.anonymous === 1,
  voidedAt: r.voided_at,
  voidReason: r.void_reason,
})

export async function readReceipt(
  db: SqlDatabase,
  assemblyId: string,
  id: string,
): Promise<ReceiptView | null> {
  const row = await db.get<ReceiptRow>(
    `${SELECT_RECEIPT} WHERE r.assembly_id = ? AND r.id = ?`,
    [assemblyId, id],
  )
  return row ? toView(row) : null
}

/** The receipt log. No names — those need the PIN, and are fetched separately. */
export async function listReceipts(
  db: SqlDatabase,
  assemblyId: string,
): Promise<ReceiptView[]> {
  const rows = await db.all<ReceiptRow>(
    `${SELECT_RECEIPT} WHERE r.assembly_id = ? ORDER BY r.number DESC`,
    [assemblyId],
  )
  return rows.map(toView)
}

/**
 * Void a receipt. The number stays in the book.
 *
 * The contribution is released so a corrected receipt can be issued against
 * it, which takes the next number rather than reusing the voided one.
 */
export async function voidReceipt(
  db: SqlDatabase,
  assemblyId: string,
  id: string,
  reason: string,
  actor: string,
  now: string,
): Promise<ReceiptView | null> {
  await setAuditActor(db, actor)

  const existing = await readReceipt(db, assemblyId, id)
  if (!existing) return null
  if (existing.voidedAt) throw new ReceiptError('This receipt is already void.')
  if (!reason.trim()) {
    throw new ReceiptError('Say why the receipt is being voided — it stays on the record.')
  }

  await db.run(
    'UPDATE receipts SET voided_at = ?, void_reason = ? WHERE assembly_id = ? AND id = ?',
    [now, reason.trim(), assemblyId, id],
  )
  await db.run('UPDATE contributions SET receipt_id = NULL WHERE receipt_id = ?', [id])

  return readReceipt(db, assemblyId, id)
}

export interface ReceiptLogSummary {
  readonly issued: number
  readonly voided: number
  readonly totalCents: Cents
  readonly awaiting: number
  readonly nextNumber: number
}

export async function receiptSummary(
  db: SqlDatabase,
  assemblyId: string,
): Promise<ReceiptLogSummary> {
  const row = await db.get<{
    issued: number
    voided: number
    total: number
    awaiting: number
  }>(
    `SELECT
       (SELECT COUNT(*) FROM receipts WHERE assembly_id = ?) AS issued,
       (SELECT COUNT(*) FROM receipts WHERE assembly_id = ? AND voided_at IS NOT NULL) AS voided,
       (SELECT COALESCE(SUM(amount_cents), 0) FROM receipts
         WHERE assembly_id = ? AND voided_at IS NULL) AS total,
       (SELECT COUNT(*) FROM contributions WHERE assembly_id = ? AND receipt_id IS NULL) AS awaiting`,
    [assemblyId, assemblyId, assemblyId, assemblyId],
  )
  return {
    issued: row?.issued ?? 0,
    voided: row?.voided ?? 0,
    totalCents: row?.total ?? 0,
    awaiting: row?.awaiting ?? 0,
    nextNumber: await nextReceiptNumber(db, assemblyId),
  }
}
