/**
 * The funds: what each one holds, what has moved through it, and what is owed
 * upward.
 *
 * An Assembly's bank account holds money belonging to three institutions at
 * once. Contributions to the National and Continental Funds pass through the
 * local account and are owed upward; only the Local Fund is the Assembly's to
 * spend. This module is the sub-ledger that keeps those apart, and the record
 * of what has been forwarded.
 *
 * `loadFundBalances` lives here and the dashboard imports it, so the "where
 * the money sits" card and this screen cannot arrive at different figures for
 * the same fund. They are not two implementations that agree; they are one.
 */

import { monthsForYear, nawRuz } from '../../calendar/badi'
import type { Cents } from '../../lib/money'
import type { FundBalanceView } from '../../shared/types'
import type { SqlDatabase, SqlValue } from '../db/adapter'
import { setAuditActor } from '../db/adapter'

/** A remittance that cannot be recorded, with the reason a treasurer needs. */
export class RemittanceError extends Error {}

export interface FundFlowView {
  readonly key: string
  readonly label: string
  readonly isPassthrough: boolean
  /** Contributed to this fund inside the year. */
  readonly receivedCents: Cents
  /** Spent from this fund inside the year. Zero for a pass-through fund. */
  readonly spentCents: Cents
  /** Forwarded to the institution that owns this fund, inside the year. */
  readonly forwardedCents: Cents
  /** Held now. The same figure, from the same query, as the dashboard card. */
  readonly balanceCents: Cents
}

export interface RemittanceView {
  readonly id: string
  readonly fundId: string
  readonly fundLabel: string
  readonly sentOn: string
  readonly amountCents: Cents
  readonly reference: string | null
  readonly transactionId: string | null
}

export interface FundsView {
  readonly bahaiYear: number
  readonly nawRuz: string
  readonly yearEnd: string
  readonly funds: readonly FundFlowView[]
  /** The sum of the balances above, which is everything on hand. */
  readonly onHandCents: Cents
  /** Held for other institutions and not yet forwarded. */
  readonly owedUpwardCents: Cents
  readonly remittances: readonly RemittanceView[]
}

/**
 * Where the money sits, as a partition of what is on hand.
 *
 * The rows have to sum to the on-hand balance or the card is lying, so they
 * are built as a partition rather than as independent queries:
 *
 *   pass-through funds — contributed in, minus what has been forwarded up
 *   cash box           — the physical cash, less any pass-through money in it
 *   Local Fund         — the residual, i.e. what the Assembly may actually spend
 *
 * Treating the Local Fund as the remainder is also the honest reading: it is
 * whatever is left once other institutions' money and the cash tin are set
 * aside.
 *
 * The cash row nets out pass-through money sitting in the tin. A National Fund
 * gift dropped in the cash box at Feast is already counted by the National
 * row; without this subtraction the cash row would count it a second time, and
 * the Local Fund — being the residual — would absorb the difference as a
 * shortfall that never happened.
 */
export async function loadFundBalances(
  db: SqlDatabase,
  assemblyId: string,
  onHandCents: Cents,
): Promise<FundBalanceView[]> {
  const rows = await db.all<{
    key: string
    label: string
    is_passthrough: number
    balance_cents: number
  }>(
    `SELECT f.key, f.label, f.is_passthrough,
            COALESCE((SELECT SUM(c.amount_cents) FROM contributions c WHERE c.fund_id = f.id), 0)
          - COALESCE((SELECT SUM(r.amount_cents) FROM remittances r WHERE r.fund_id = f.id), 0)
            AS balance_cents
       FROM funds f
      WHERE f.assembly_id = ?
      ORDER BY f.sort_order`,
    [assemblyId],
  )

  const cash = await db.get<{ cents: number }>(
    `SELECT COALESCE((SELECT SUM(a.opening_balance_cents) FROM accounts a
                       WHERE a.assembly_id = ? AND a.kind = 'cash'), 0)
          + COALESCE((SELECT SUM(t.amount_cents) FROM transactions t
                       JOIN accounts ca ON ca.id = t.account_id
                      WHERE ca.assembly_id = ? AND ca.kind = 'cash'), 0) AS cents`,
    [assemblyId, assemblyId],
  )

  // Pass-through money physically in the tin: gifts to another institution's
  // fund received in cash, less anything forwarded out of a cash account.
  const inTin = await db.get<{ cents: number }>(
    `SELECT COALESCE((SELECT SUM(c.amount_cents)
                        FROM contributions c
                        JOIN transactions t ON t.id = c.transaction_id
                        JOIN accounts a ON a.id = t.account_id
                        JOIN funds f ON f.id = c.fund_id
                       WHERE c.assembly_id = ? AND a.kind = 'cash' AND f.is_passthrough = 1), 0)
          - COALESCE((SELECT SUM(r.amount_cents)
                        FROM remittances r
                        JOIN transactions t ON t.id = r.transaction_id
                        JOIN accounts a ON a.id = t.account_id
                       WHERE r.assembly_id = ? AND a.kind = 'cash'), 0) AS cents`,
    [assemblyId, assemblyId],
  )

  const cashCents = (cash?.cents ?? 0) - (inTin?.cents ?? 0)

  const passthrough = rows.filter((r) => r.is_passthrough === 1)
  const passthroughTotal = passthrough.reduce((sum, r) => sum + r.balance_cents, 0)
  const local = rows.find((r) => r.is_passthrough === 0)

  return [
    {
      key: local?.key ?? 'local',
      label: local?.label ?? 'Local Fund',
      balanceCents: onHandCents - passthroughTotal - cashCents,
      isPassthrough: false,
    },
    ...passthrough.map((r) => ({
      key: r.key,
      label: r.label,
      balanceCents: r.balance_cents,
      isPassthrough: true,
    })),
    { key: 'cash', label: 'Cash box', balanceCents: cashCents, isPassthrough: false },
  ]
}

/** Everything on hand: what the accounts opened with, plus every movement since. */
export async function onHand(db: SqlDatabase, assemblyId: string): Promise<Cents> {
  const row = await db.get<{ cents: number }>(
    `SELECT (SELECT COALESCE(SUM(opening_balance_cents), 0) FROM accounts WHERE assembly_id = ?)
          + (SELECT COALESCE(SUM(amount_cents), 0) FROM transactions WHERE assembly_id = ?) AS cents`,
    [assemblyId, assemblyId],
  )
  return row?.cents ?? 0
}

export async function loadFunds(
  db: SqlDatabase,
  assemblyId: string,
  bahaiYear: number,
): Promise<FundsView> {
  const periods = monthsForYear(bahaiYear)
  const from = nawRuz(bahaiYear)
  const to = periods[periods.length - 1].endDate

  const onHandNow = await onHand(db, assemblyId)
  const balances = await loadFundBalances(db, assemblyId, onHandNow)

  // Flows inside the year, by fund. A cash-account row is attributed to the
  // fund it was given to, not to the cash row: the cash box is a place money
  // sits, not a fund it belongs to.
  const received = await keyedSums(
    db,
    `SELECT f.key AS k, SUM(c.amount_cents) AS cents
       FROM contributions c
       JOIN transactions t ON t.id = c.transaction_id
       JOIN funds f ON f.id = c.fund_id
      WHERE c.assembly_id = ? AND t.occurred_on BETWEEN ? AND ?
      GROUP BY f.key`,
    [assemblyId, from, to],
  )

  const spent = await keyedSums(
    db,
    // An expense with no fund belongs to the Local Fund. An Assembly spends
    // its own money, and a row nobody has assigned is not another
    // institution's — leaving it out entirely would understate what the Local
    // Fund has actually paid.
    `SELECT COALESCE(f.key, (SELECT key FROM funds
                              WHERE assembly_id = t.assembly_id AND is_passthrough = 0
                              ORDER BY sort_order LIMIT 1)) AS k,
            -SUM(t.amount_cents) AS cents
       FROM transactions t
       LEFT JOIN funds f ON f.id = t.fund_id
      WHERE t.assembly_id = ? AND t.kind = 'expense' AND t.occurred_on BETWEEN ? AND ?
      GROUP BY k`,
    [assemblyId, from, to],
  )

  const forwarded = await keyedSums(
    db,
    `SELECT f.key AS k, SUM(r.amount_cents) AS cents
       FROM remittances r
       JOIN funds f ON f.id = r.fund_id
      WHERE r.assembly_id = ? AND r.sent_on BETWEEN ? AND ?
      GROUP BY f.key`,
    [assemblyId, from, to],
  )

  const funds: FundFlowView[] = balances.map((b) => ({
    key: b.key,
    label: b.label,
    isPassthrough: b.isPassthrough,
    receivedCents: b.key === 'cash' ? 0 : (received.get(b.key) ?? 0),
    spentCents: b.key === 'cash' ? 0 : (spent.get(b.key) ?? 0),
    forwardedCents: b.key === 'cash' ? 0 : (forwarded.get(b.key) ?? 0),
    balanceCents: b.balanceCents,
  }))

  return {
    bahaiYear,
    nawRuz: from,
    yearEnd: to,
    funds,
    onHandCents: onHandNow,
    owedUpwardCents: funds
      .filter((f) => f.isPassthrough)
      .reduce((sum, f) => sum + f.balanceCents, 0),
    remittances: await listRemittances(db, assemblyId, bahaiYear),
  }
}

async function keyedSums(
  db: SqlDatabase,
  sql: string,
  params: SqlValue[],
): Promise<Map<string, number>> {
  const rows = await db.all<{ k: string | null; cents: number }>(sql, params)
  return new Map(rows.filter((r) => r.k !== null).map((r) => [r.k as string, r.cents]))
}

export async function listRemittances(
  db: SqlDatabase,
  assemblyId: string,
  bahaiYear: number,
): Promise<RemittanceView[]> {
  const periods = monthsForYear(bahaiYear)
  const rows = await db.all<{
    id: string
    fund_id: string
    fund_label: string
    sent_on: string
    amount_cents: number
    reference: string | null
    transaction_id: string | null
  }>(
    `SELECT r.id, r.fund_id, f.label AS fund_label, r.sent_on, r.amount_cents,
            r.reference, r.transaction_id
       FROM remittances r
       JOIN funds f ON f.id = r.fund_id
      WHERE r.assembly_id = ? AND r.sent_on BETWEEN ? AND ?
      ORDER BY r.sent_on DESC, r.id DESC`,
    [assemblyId, nawRuz(bahaiYear), periods[periods.length - 1].endDate],
  )
  return rows.map((r) => ({
    id: r.id,
    fundId: r.fund_id,
    fundLabel: r.fund_label,
    sentOn: r.sent_on,
    amountCents: r.amount_cents,
    reference: r.reference,
    transactionId: r.transaction_id,
  }))
}

// ── one fund, line by line ───────────────────────────────────────────────────

export type FundMovement = 'received' | 'spent' | 'forwarded'

export interface FundEntryView {
  readonly id: string
  readonly occurredOn: string
  readonly description: string
  readonly movement: FundMovement
  /** Signed from the fund's point of view: in is positive, out is negative. */
  readonly amountCents: Cents
  /** The fund's balance immediately after this line. */
  readonly balanceCents: Cents
  readonly isLocked: boolean
}

export interface FundLedgerView {
  readonly key: string
  readonly label: string
  readonly isPassthrough: boolean
  readonly bahaiYear: number
  /** Held by this fund at Naw-Rúz. */
  readonly openingCents: Cents
  readonly closingCents: Cents
  readonly entries: readonly FundEntryView[]
}

/**
 * One fund's own ledger, oldest first, with a running balance.
 *
 * Ascending like the cash journal and for the same reason: the point is to
 * follow the balance forward to a figure that can be checked — here, against
 * what is still owed to the institution that owns the fund.
 *
 * Contributions are rolled up per deposit rather than listed per gift. One
 * bank deposit carrying fifteen gifts is one line on the bank statement, and
 * the sub-ledger has to be readable beside it. Individual amounts stay behind
 * the donor vault either way.
 */
export async function loadFundLedger(
  db: SqlDatabase,
  assemblyId: string,
  fundKey: string,
  bahaiYear: number,
): Promise<FundLedgerView | null> {
  const fund = await db.get<{
    id: string
    key: string
    label: string
    is_passthrough: number
  }>(
    'SELECT id, key, label, is_passthrough FROM funds WHERE assembly_id = ? AND key = ?',
    [assemblyId, fundKey],
  )
  if (!fund) return null

  const periods = monthsForYear(bahaiYear)
  const from = nawRuz(bahaiYear)
  const to = periods[periods.length - 1].endDate
  const isLocal = fund.is_passthrough === 0

  // An expense with no fund belongs to the Local Fund; see loadFunds.
  const expenseWhere = isLocal ? '(t.fund_id = ? OR t.fund_id IS NULL)' : 't.fund_id = ?'

  const opening = await db.get<{ cents: number }>(
    `SELECT COALESCE((SELECT SUM(c.amount_cents) FROM contributions c
                        JOIN transactions t ON t.id = c.transaction_id
                       WHERE c.fund_id = ? AND t.occurred_on < ?), 0)
          + COALESCE((SELECT SUM(t.amount_cents) FROM transactions t
                       WHERE t.assembly_id = ? AND t.kind = 'expense'
                         AND ${expenseWhere} AND t.occurred_on < ?), 0)
          - COALESCE((SELECT SUM(r.amount_cents) FROM remittances r
                       WHERE r.fund_id = ? AND r.sent_on < ?), 0) AS cents`,
    [fund.id, from, assemblyId, fund.id, from, fund.id, from],
  )

  const rows = await db.all<{
    id: string
    occurred_on: string
    description: string
    movement: FundMovement
    amount_cents: number
    is_locked: number
  }>(
    `SELECT t.id AS id, t.occurred_on AS occurred_on,
            COALESCE(t.payee, 'Contributions') AS description,
            'received' AS movement, SUM(c.amount_cents) AS amount_cents,
            t.is_locked AS is_locked
       FROM contributions c
       JOIN transactions t ON t.id = c.transaction_id
      WHERE c.fund_id = ? AND t.occurred_on BETWEEN ? AND ?
      GROUP BY t.id

      UNION ALL

     SELECT t.id, t.occurred_on,
            COALESCE(t.payee, 'Expense'),
            'spent', t.amount_cents, t.is_locked
       FROM transactions t
      WHERE t.assembly_id = ? AND t.kind = 'expense'
        AND ${expenseWhere} AND t.occurred_on BETWEEN ? AND ?

      UNION ALL

     SELECT r.id, r.sent_on,
            'Forwarded upward' || COALESCE(' · ' || r.reference, ''),
            'forwarded', -r.amount_cents, 0
       FROM remittances r
      WHERE r.fund_id = ? AND r.sent_on BETWEEN ? AND ?

      ORDER BY occurred_on ASC, id ASC`,
    [fund.id, from, to, assemblyId, fund.id, from, to, fund.id, from, to],
  )

  let balance = opening?.cents ?? 0
  const entries = rows.map((r) => {
    balance += r.amount_cents
    return {
      id: r.id,
      occurredOn: r.occurred_on,
      description: r.description,
      movement: r.movement,
      amountCents: r.amount_cents,
      balanceCents: balance,
      isLocked: r.is_locked === 1,
    }
  })

  return {
    key: fund.key,
    label: fund.label,
    isPassthrough: fund.is_passthrough === 1,
    bahaiYear,
    openingCents: opening?.cents ?? 0,
    closingCents: balance,
    entries,
  }
}

// ── forwarding upward ────────────────────────────────────────────────────────

export interface NewRemittance {
  readonly fundKey: string
  readonly accountId: string
  readonly sentOn: string
  readonly amountCents: Cents
  readonly reference: string | null
}

/**
 * Record money forwarded to another institution.
 *
 * Two rows, always: a transaction taking the money out of the account, and a
 * remittance row saying which fund it discharged. Writing only the second
 * would leave the money still sitting in the bank balance while the fund
 * showed it as gone, and every screen reading those two figures would disagree
 * by the amount forwarded.
 *
 * Refuses to forward more than the fund holds. An Assembly cannot send onward
 * money it was never given, so a figure larger than the outstanding balance is
 * a miscount somewhere — in this form, or in what was recorded as received —
 * and posting it would bury the discrepancy in two places at once.
 */
export async function recordRemittance(
  db: SqlDatabase,
  assemblyId: string,
  input: NewRemittance,
  actor: string,
  now: string,
): Promise<RemittanceView> {
  await setAuditActor(db, actor)

  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new RemittanceError('A remittance must be a positive whole number of cents.')
  }

  const fund = await db.get<{ id: string; label: string; is_passthrough: number }>(
    'SELECT id, label, is_passthrough FROM funds WHERE assembly_id = ? AND key = ?',
    [assemblyId, input.fundKey],
  )
  if (!fund) throw new RemittanceError(`No fund "${input.fundKey}".`)

  // The Local Fund is the Assembly's own money. Spending it is an expense with
  // a category; recording it here would take it out of the expense figures the
  // Feast report reads and hide it in a line about other institutions.
  if (fund.is_passthrough === 0) {
    throw new RemittanceError(
      `${fund.label} is the Assembly's own money, not held for another institution. ` +
        'Record spending from it as an expense.',
    )
  }

  const account = await db.get<{ id: string }>(
    'SELECT id FROM accounts WHERE assembly_id = ? AND id = ? AND is_active = 1',
    [assemblyId, input.accountId],
  )
  if (!account) throw new RemittanceError('No such account.')

  const held = await db.get<{ cents: number }>(
    `SELECT COALESCE((SELECT SUM(amount_cents) FROM contributions WHERE fund_id = ?), 0)
          - COALESCE((SELECT SUM(amount_cents) FROM remittances WHERE fund_id = ?), 0) AS cents`,
    [fund.id, fund.id],
  )
  const outstanding = held?.cents ?? 0
  if (input.amountCents > outstanding) {
    throw new RemittanceError(
      `${fund.label} holds ${money(outstanding)}, so ${money(input.amountCents)} cannot ` +
        'be forwarded. Check what was recorded as received before sending more.',
    )
  }

  const stamp = now.replace(/[^0-9]/g, '')
  const transactionId = `txn-rem-${stamp}-${input.amountCents}`
  const remittanceId = `rem-${stamp}-${input.amountCents}`

  await db.run(
    `INSERT INTO transactions
       (id, assembly_id, account_id, fund_id, category_id, occurred_on, amount_cents,
        payee, memo, method, source, kind, dedupe_hash, is_locked, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, 'bank', 'manual', 'remittance', NULL, 0, ?, ?)`,
    [
      transactionId,
      assemblyId,
      input.accountId,
      fund.id,
      input.sentOn,
      -input.amountCents,
      `Forwarded to ${fund.label}`,
      input.reference,
      now,
      now,
    ],
  )

  await db.run(
    `INSERT INTO remittances
       (id, assembly_id, fund_id, transaction_id, sent_on, amount_cents, reference)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      remittanceId,
      assemblyId,
      fund.id,
      transactionId,
      input.sentOn,
      input.amountCents,
      input.reference,
    ],
  )

  return {
    id: remittanceId,
    fundId: fund.id,
    fundLabel: fund.label,
    sentOn: input.sentOn,
    amountCents: input.amountCents,
    reference: input.reference,
    transactionId,
  }
}

/** Money inside an error message. The UI formats its own with Intl. */
function money(cents: Cents): string {
  const sign = cents < 0 ? '−' : ''
  const abs = Math.abs(cents)
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`
}
