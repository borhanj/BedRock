/**
 * The ledger and the cash journal.
 *
 * Both are the same underlying rows seen two ways: the ledger is everything,
 * filterable; the cash journal is the cash accounts only, in date order with a
 * running balance the treasurer can count against the tin.
 */

import { monthsForYear, nawRuz } from '../../calendar/badi'
import type { Cents } from '../../lib/money'
import type { SqlDatabase } from '../db/adapter'
import { setAuditActor } from '../db/adapter'
import { suggestForAll } from './rules'
import type { Suggestion } from './rules'

export interface LedgerRow {
  readonly id: string
  readonly occurredOn: string
  readonly payee: string | null
  readonly memo: string | null
  readonly amountCents: Cents
  readonly method: string
  readonly kind: string
  readonly source: string
  readonly categoryId: string | null
  readonly categoryLabel: string | null
  readonly fundId: string | null
  readonly fundLabel: string | null
  readonly accountName: string
  readonly accountKind: string
  readonly isLocked: boolean
  readonly hasReceiptImage: boolean
  /** Only present for uncategorised rows, and only ever a suggestion. */
  readonly suggestion: Suggestion | null
}

export interface LedgerFilters {
  readonly bahaiYear?: number
  readonly monthNumber?: number
  readonly accountId?: string
  readonly uncategorisedOnly?: boolean
  readonly search?: string
  readonly limit?: number
}

interface LedgerRowRecord {
  id: string
  occurred_on: string
  payee: string | null
  memo: string | null
  amount_cents: number
  method: string
  kind: string
  source: string
  category_id: string | null
  category_label: string | null
  fund_id: string | null
  fund_label: string | null
  account_name: string
  account_kind: string
  is_locked: number
  receipt_images: number
}

const SELECT_LEDGER = `
  SELECT t.id, t.occurred_on, t.payee, t.memo, t.amount_cents, t.method, t.kind,
         t.source, t.category_id, c.label AS category_label,
         t.fund_id, f.label AS fund_label,
         a.name AS account_name, a.kind AS account_kind, t.is_locked,
         (SELECT COUNT(*) FROM attachments at
           WHERE at.transaction_id = t.id AND at.kind = 'receipt_image') AS receipt_images
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN funds f ON f.id = t.fund_id
`

export async function loadLedger(
  db: SqlDatabase,
  assemblyId: string,
  filters: LedgerFilters = {},
): Promise<LedgerRow[]> {
  const where: string[] = ['t.assembly_id = ?']
  const params: (string | number)[] = [assemblyId]

  if (filters.bahaiYear !== undefined) {
    const periods = monthsForYear(filters.bahaiYear)
    if (filters.monthNumber !== undefined) {
      const period = periods.find((p) => p.monthNumber === filters.monthNumber)
      if (!period) return []
      where.push('t.occurred_on BETWEEN ? AND ?')
      params.push(period.startDate, period.endDate)
    } else {
      where.push('t.occurred_on BETWEEN ? AND ?')
      params.push(nawRuz(filters.bahaiYear), periods[periods.length - 1].endDate)
    }
  }
  if (filters.accountId) {
    where.push('t.account_id = ?')
    params.push(filters.accountId)
  }
  if (filters.uncategorisedOnly) {
    where.push("t.category_id IS NULL AND t.kind IN ('contribution', 'expense')")
  }
  if (filters.search) {
    where.push('(LOWER(t.payee) LIKE ? OR LOWER(t.memo) LIKE ?)')
    const needle = `%${filters.search.toLowerCase()}%`
    params.push(needle, needle)
  }

  const limit = Math.min(filters.limit ?? 500, 2000)
  const rows = await db.all<LedgerRowRecord>(
    `${SELECT_LEDGER} WHERE ${where.join(' AND ')}
      ORDER BY t.occurred_on DESC, t.id DESC
      LIMIT ${limit}`,
    params,
  )

  // Suggestions are only computed for rows that need one, so a fully
  // categorised ledger costs nothing extra to render.
  const needing = rows.filter((r) => r.category_id === null)
  const suggestions = await suggestForAll(
    db,
    assemblyId,
    needing.map((r) => r.payee ?? ''),
  )
  const byId = new Map(needing.map((r, i) => [r.id, suggestions[i]]))

  return rows.map((r) => toLedgerRow(r, byId.get(r.id) ?? null))
}

function toLedgerRow(r: LedgerRowRecord, suggestion: Suggestion | null): LedgerRow {
  return {
    id: r.id,
    occurredOn: r.occurred_on,
    payee: r.payee,
    memo: r.memo,
    amountCents: r.amount_cents,
    method: r.method,
    kind: r.kind,
    source: r.source,
    categoryId: r.category_id,
    categoryLabel: r.category_label,
    fundId: r.fund_id,
    fundLabel: r.fund_label,
    accountName: r.account_name,
    accountKind: r.account_kind,
    isLocked: r.is_locked === 1,
    hasReceiptImage: r.receipt_images > 0,
    suggestion,
  }
}

export interface CashJournalEntry extends LedgerRow {
  /** Cash on hand immediately after this entry. */
  readonly balanceCents: Cents
}

export interface CashJournal {
  readonly openingCents: Cents
  readonly closingCents: Cents
  readonly entries: readonly CashJournalEntry[]
}

/**
 * Cash in and out, oldest first, with a running balance.
 *
 * Ordered ascending — the opposite of the ledger — because the point of this
 * view is to follow the balance forward to a figure that can be checked
 * against a physical count.
 */
export async function loadCashJournal(
  db: SqlDatabase,
  assemblyId: string,
  bahaiYear: number,
): Promise<CashJournal> {
  const periods = monthsForYear(bahaiYear)
  const from = nawRuz(bahaiYear)
  const to = periods[periods.length - 1].endDate

  const opening = await db.get<{ cents: number }>(
    `SELECT (SELECT COALESCE(SUM(opening_balance_cents), 0)
               FROM accounts WHERE assembly_id = ? AND kind = 'cash')
          + COALESCE((SELECT SUM(t.amount_cents) FROM transactions t
                        JOIN accounts a ON a.id = t.account_id
                       WHERE a.assembly_id = ? AND a.kind = 'cash'
                         AND t.occurred_on < ?), 0) AS cents`,
    [assemblyId, assemblyId, from],
  )

  const rows = await db.all<LedgerRowRecord>(
    `${SELECT_LEDGER}
      WHERE t.assembly_id = ? AND a.kind = 'cash' AND t.occurred_on BETWEEN ? AND ?
      ORDER BY t.occurred_on ASC, t.id ASC`,
    [assemblyId, from, to],
  )

  let balance = opening?.cents ?? 0
  const entries = rows.map((r) => {
    balance += r.amount_cents
    return { ...toLedgerRow(r, null), balanceCents: balance }
  })

  return {
    openingCents: opening?.cents ?? 0,
    closingCents: balance,
    entries,
  }
}

export interface NewTransaction {
  readonly accountId: string
  readonly occurredOn: string
  readonly amountCents: Cents
  readonly payee: string
  readonly memo: string | null
  readonly method: string
  readonly kind: string
  readonly categoryId: string | null
  readonly fundId: string | null
}

/**
 * Hand-entered cash and anything the bank did not carry.
 *
 * No dedupe hash: these rows did not come from a file, so there is nothing to
 * re-import and match against. The partial unique index only covers rows that
 * have a hash, which is why hand entry can never collide with an import.
 */
export async function createTransaction(
  db: SqlDatabase,
  assemblyId: string,
  input: NewTransaction,
  actor: string,
  now: string,
): Promise<string> {
  await setAuditActor(db, actor)

  const id = `txn-manual-${now.replace(/[^0-9]/g, '')}-${Math.abs(input.amountCents)}`
  await db.run(
    `INSERT INTO transactions
       (id, assembly_id, account_id, fund_id, category_id, occurred_on, amount_cents,
        payee, memo, method, source, kind, dedupe_hash, is_locked, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
    [
      id,
      assemblyId,
      input.accountId,
      input.fundId,
      input.categoryId,
      input.occurredOn,
      input.amountCents,
      input.payee,
      input.memo,
      input.method,
      input.method === 'cash' ? 'cash' : 'manual',
      input.kind,
      now,
      now,
    ],
  )

  // A contribution needs its child row, or it will not appear in any income
  // total — the reports read `contributions`, not `transactions`.
  if (input.kind === 'contribution' && input.fundId) {
    await db.run(
      `INSERT INTO contributions
         (id, assembly_id, transaction_id, donor_id, fund_id, amount_cents, receipt_id)
       VALUES (?, ?, ?, NULL, ?, ?, NULL)`,
      [`con-${id}`, assemblyId, id, input.fundId, input.amountCents],
    )
  }

  return id
}

export interface AccountView {
  readonly id: string
  readonly name: string
  readonly kind: string
}

export interface CategoryView {
  readonly id: string
  readonly label: string
  readonly kind: string
}

export interface FundView {
  readonly id: string
  readonly label: string
}

/** Everything the entry and categorisation forms need to offer choices. */
export async function loadChoices(db: SqlDatabase, assemblyId: string) {
  const [accounts, categories, funds] = await Promise.all([
    db.all<AccountView>(
      // Bank first: it is what statements are imported into, and what most
      // screens default to.
      'SELECT id, name, kind FROM accounts WHERE assembly_id = ? AND is_active = 1 ORDER BY kind ASC, name',
      [assemblyId],
    ),
    db.all<CategoryView>(
      'SELECT id, label, kind FROM categories WHERE assembly_id = ? AND is_archived = 0 ORDER BY kind, sort_order',
      [assemblyId],
    ),
    db.all<FundView>(
      'SELECT id, label FROM funds WHERE assembly_id = ? ORDER BY sort_order',
      [assemblyId],
    ),
  ])
  return { accounts, categories, funds }
}
