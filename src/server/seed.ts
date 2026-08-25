/**
 * A worked year of 183 B.E., written as real rows.
 *
 * The figures are chosen to reproduce the source design exactly — $5,172.40 on
 * hand, split $4,182.90 / $625.00 / $150.00 / $214.50, and "23 contributions
 * from 11 households" in the month of Kamál. Nothing is written down twice:
 * the fund balances and every report total fall out of the rows below.
 *
 * Replaced by the treasurer's own CSV imports in Phase 3.
 */

import { monthsForYear, toDayIndex, toISODate } from '../calendar/badi'
import type { SqlDatabase } from './db/adapter'
import { setAuditActor } from './db/adapter'

export const ASSEMBLY_ID = 'riverbend'
export const SEED_YEAR = 183
export const SEED_TODAY = '2026-08-28'

const BANK = 'acct-bank'
const CASH = 'acct-cash'
const OPENING_BALANCE_CENTS = 164_780
/** Physical cash on hand, arriving as two ungiven-name gifts at Feast. */
const CASH_GIFTS = [10_000, 11_450]

const FUNDS = [
  { id: 'fund-local', key: 'local', label: 'Local Fund', passthrough: 0, order: 0 },
  { id: 'fund-national', key: 'national', label: 'National Fund', passthrough: 1, order: 1 },
  { id: 'fund-continental', key: 'continental', label: 'Continental Fund', passthrough: 1, order: 2 },
]

// Each income category names the fund it feeds, so the budget can keep money
// owed upward out of the Assembly's surplus.
const INCOME_CATEGORIES = [
  { id: 'cat-inc-local', label: 'Local Fund contributions', fund: 'fund-local' },
  { id: 'cat-inc-national', label: 'National Fund contributions', fund: 'fund-national' },
  { id: 'cat-inc-continental', label: 'Continental Fund contributions', fund: 'fund-continental' },
]

const EXPENSE_CATEGORIES = [
  { id: 'cat-rent', label: 'Rent / facility use' },
  { id: 'cat-hospitality', label: 'Feast hospitality' },
  { id: 'cat-utilities', label: 'Utilities' },
  { id: 'cat-children', label: 'Children’s classes' },
  { id: 'cat-holyday', label: 'Holy Day observance' },
  { id: 'cat-deepening', label: 'Deepening materials' },
  { id: 'cat-proclamation', label: 'Proclamation' },
  { id: 'cat-travel', label: 'Travel / institute' },
  { id: 'cat-supplies', label: 'Administrative supplies' },
  { id: 'cat-bank', label: 'Bank fees' },
]

interface FundSplit {
  local: number
  national: number
  continental: number
}

/** Contributions per month, by fund. Cents. */
const CONTRIBUTIONS: Record<number, FundSplit> = {
  1: { local: 110_500, national: 20_000, continental: 2_500 },
  2: { local: 85_500, national: 15_000, continental: 2_500 },
  3: { local: 127_500, national: 22_500, continental: 2_500 },
  4: { local: 98_000, national: 17_500, continental: 2_500 },
  5: { local: 79_500, national: 12_500, continental: 2_500 },
  6: { local: 119_000, national: 20_000, continental: 2_500 },
  7: { local: 94_000, national: 15_000, continental: 2_500 },
  // Kamál is the month with a full Feast report; its split is pinned to the
  // figures the design prints.
  8: { local: 110_500, national: 42_500, continental: 10_000 },
  9: { local: 42_000, national: 2_500, continental: 2_500 },
}

/**
 * How many individual gifts make up each month's deposit per fund.
 *
 * A deposit is one bank transaction; the gifts inside it are separate
 * contribution rows, which is why the schema makes contributions children of a
 * transaction. Kamál totals 15 + 6 + 2 = 23, the figure the report prints.
 */
const GIFT_COUNTS: Record<number, FundSplit> = {
  8: { local: 15, national: 6, continental: 2 },
}
const DEFAULT_GIFTS: FundSplit = { local: 8, national: 3, continental: 1 }

/** Expenses per month, by category id. Cents, positive magnitudes. */
const EXPENSES: Record<number, Array<[string, number]>> = {
  1: [['cat-rent', 35_000], ['cat-utilities', 8_900], ['cat-hospitality', 10_500], ['cat-children', 8_000], ['cat-deepening', 11_030], ['cat-bank', 800]],
  2: [['cat-rent', 35_000], ['cat-utilities', 8_200], ['cat-hospitality', 9_300], ['cat-children', 7_500], ['cat-proclamation', 8_015], ['cat-bank', 800]],
  3: [['cat-rent', 35_000], ['cat-utilities', 9_100], ['cat-hospitality', 11_200], ['cat-children', 8_500], ['cat-travel', 14_940], ['cat-bank', 800]],
  4: [['cat-rent', 35_000], ['cat-utilities', 7_800], ['cat-hospitality', 9_900], ['cat-children', 6_800], ['cat-supplies', 4_800], ['cat-bank', 800]],
  5: [['cat-rent', 35_000], ['cat-utilities', 7_200], ['cat-hospitality', 8_900], ['cat-children', 6_200], ['cat-supplies', 3_975], ['cat-bank', 800]],
  6: [['cat-rent', 35_000], ['cat-utilities', 9_600], ['cat-hospitality', 12_100], ['cat-children', 9_200], ['cat-travel', 14_560], ['cat-bank', 800]],
  7: [['cat-rent', 35_000], ['cat-utilities', 8_500], ['cat-holyday', 12_000], ['cat-children', 7_200], ['cat-deepening', 6_835], ['cat-bank', 800]],
  8: [['cat-rent', 35_000], ['cat-hospitality', 9_675], ['cat-utilities', 8_420], ['cat-children', 6_250], ['cat-bank', 800]],
  // Asmáʼ is in progress: rent is not paid yet, and the rows have arrived
  // from the bank but nothing has been categorised. This is what a treasurer
  // opens the app to find.
  9: [['', 8_240], ['', 7_500], ['', 5_500], ['', 8_000], ['', 800]],
}

/** Payees for the uncategorised current-month rows, as the bank sent them. */
const UNSORTED_PAYEES = [
  'CITY WATER UTILITY',
  'RIVERBEND GROCERY',
  'OFFICE DEPOT #2241',
  'PRINTWORKS LTD',
  'MONTHLY ACCOUNT FEE',
]

/**
 * The budget the Assembly adopted before the year began. Cents.
 *
 * Round figures, because a body of nine people votes on round figures. Two are
 * deliberately tight against what the year actually did — deepening materials
 * is already over, and travel is nearly spent less than half way through — so
 * the variance and pace marks on the budget screen have something to say.
 */
const BUDGET = {
  approvedOn: '2026-03-08',
  note: 'Adopted by the Assembly at its meeting of 8 March 2026.',
  lines: [
    ['cat-inc-local', 1_700_000],
    ['cat-inc-national', 300_000],
    ['cat-inc-continental', 50_000],
    ['cat-rent', 665_000],
    ['cat-hospitality', 200_000],
    ['cat-utilities', 170_000],
    ['cat-children', 150_000],
    ['cat-holyday', 60_000],
    ['cat-deepening', 15_000],
    ['cat-proclamation', 40_000],
    ['cat-travel', 30_000],
    ['cat-supplies', 35_000],
    ['cat-bank', 16_000],
  ] as Array<[string, number]>,
}

/** Forwarded upward. Cents. */
const REMITTANCES = [
  { month: 3, fund: 'fund-national', cents: 45_000, reference: 'NF-2026-0417' },
  { month: 6, fund: 'fund-national', cents: 30_000, reference: 'NF-2026-0713' },
  { month: 6, fund: 'fund-continental', cents: 15_000, reference: 'CF-2026-0713' },
  { month: 8, fund: 'fund-national', cents: 30_000, reference: 'NF-2026-0812' },
]

/** Eleven households, as opaque ids. Names arrive encrypted in Phase 5. */
const DONORS = Array.from({ length: 11 }, (_, i) => `donor-${i + 1}`)

const NOW = '2026-08-28T12:00:00Z'

/**
 * Break a deposit into `parts` individual gifts that sum to it exactly.
 * Deterministic, and never returns a gift under a dollar.
 */
export function splitAmount(total: number, parts: number): number[] {
  if (parts <= 1) return [total]
  const out: number[] = []
  let remaining = total
  for (let i = 0; i < parts - 1; i++) {
    const left = parts - i
    const even = remaining / left
    // A fixed wobble so the gifts are not all identical, without randomness.
    const share = Math.round((even * (80 + ((i * 37) % 45))) / 100)
    const floor = 100
    const amount = Math.max(floor, Math.min(share, remaining - (left - 1) * floor))
    out.push(amount)
    remaining -= amount
  }
  out.push(remaining)
  return out
}

export async function seed(db: SqlDatabase): Promise<void> {
  // Nothing may write money without an attributable actor; the triggers abort
  // the insert otherwise. The seed is no exception.
  await setAuditActor(db, 'seed')

  const periods = monthsForYear(SEED_YEAR)
  const dayIn = (month: number, offset: number) => {
    const period = periods.find((p) => p.monthNumber === month)!
    return toISODate(toDayIndex(period.startDate) + offset)
  }

  await db.run(
    'INSERT INTO assemblies (id, name, short_name, created_at) VALUES (?, ?, ?, ?)',
    [ASSEMBLY_ID, 'Local Spiritual Assembly of Riverbend', 'Riverbend Fund', NOW],
  )

  await db.run(
    `INSERT INTO accounts (id, assembly_id, name, kind, opening_balance_cents)
     VALUES (?, ?, ?, 'bank', ?)`,
    [BANK, ASSEMBLY_ID, 'Riverbend Credit Union — chequing', OPENING_BALANCE_CENTS],
  )
  await db.run(
    `INSERT INTO accounts (id, assembly_id, name, kind, opening_balance_cents)
     VALUES (?, ?, ?, 'cash', 0)`,
    [CASH, ASSEMBLY_ID, 'Cash box'],
  )

  for (const f of FUNDS) {
    await db.run(
      `INSERT INTO funds (id, assembly_id, key, label, is_passthrough, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [f.id, ASSEMBLY_ID, f.key, f.label, f.passthrough, f.order],
    )
  }

  for (const [i, c] of INCOME_CATEGORIES.entries()) {
    await db.run(
      `INSERT INTO categories (id, assembly_id, label, kind, sort_order, fund_id)
       VALUES (?, ?, ?, 'income', ?, ?)`,
      [c.id, ASSEMBLY_ID, c.label, i, c.fund],
    )
  }
  for (const [i, c] of EXPENSE_CATEGORIES.entries()) {
    await db.run(
      `INSERT INTO categories (id, assembly_id, label, kind, sort_order)
       VALUES (?, ?, ?, 'expense', ?)`,
      [c.id, ASSEMBLY_ID, c.label, i],
    )
  }

  for (const id of DONORS) {
    // Eleven households that have given, with no name on file.
    //
    // The seed cannot write an encrypted name: encryption needs the
    // treasurer's PIN, and no vault exists until they set one. A placeholder
    // string here would be ciphertext the vault cannot open, so the column
    // stays NULL — which is also the truthful state. Everything that matters
    // for reporting is the opaque id, and the household count on a Feast
    // report works from that alone.
    await db.run(
      `INSERT INTO donors (id, assembly_id, name_encrypted, is_anonymous, created_at)
       VALUES (?, ?, NULL, 0, ?)`,
      [id, ASSEMBLY_ID, NOW],
    )
  }

  let seq = 0
  const nextId = (prefix: string) => `${prefix}-${String(++seq).padStart(4, '0')}`

  const insertTransaction = async (t: {
    id: string
    account: string
    fund: string | null
    category: string | null
    date: string
    cents: number
    payee: string
    method: string
    kind: string
  }) => {
    await db.run(
      `INSERT INTO transactions
         (id, assembly_id, account_id, fund_id, category_id, occurred_on, amount_cents,
          payee, memo, method, source, kind, dedupe_hash, is_locked, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'import', ?, NULL, 0, ?, ?)`,
      [
        t.id, ASSEMBLY_ID, t.account, t.fund, t.category, t.date, t.cents,
        t.payee, t.method, t.kind, NOW, NOW,
      ],
    )
  }

  let donorCursor = 0
  const addGifts = async (
    transactionId: string,
    fund: string,
    total: number,
    parts: number,
    receipted: boolean,
  ) => {
    for (const amount of splitAmount(total, parts)) {
      await db.run(
        `INSERT INTO contributions (id, assembly_id, transaction_id, donor_id, fund_id, amount_cents, receipt_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          nextId('con'), ASSEMBLY_ID, transactionId,
          receipted ? DONORS[donorCursor++ % DONORS.length] : null,
          fund, amount,
          // Receipt issuance is Phase 5; the id is the marker the dashboard
          // counts against, so bank gifts are treated as already receipted.
          receipted ? `rcpt-${transactionId}` : null,
        ],
      )
    }
  }

  // ── contributions ────────────────────────────────────────────────────────

  for (const [monthText, split] of Object.entries(CONTRIBUTIONS)) {
    const month = Number(monthText)
    const gifts = GIFT_COUNTS[month] ?? DEFAULT_GIFTS
    const isCurrent = month === 9

    const lines: Array<[keyof FundSplit, string, string, number]> = [
      ['local', 'fund-local', 'cat-inc-local', split.local],
      ['national', 'fund-national', 'cat-inc-national', split.national],
      ['continental', 'fund-continental', 'cat-inc-continental', split.continental],
    ]

    for (const [key, fund, category, cents] of lines) {
      if (cents === 0) continue

      // The cash tin at Feast: two gifts, no names taken, no receipts written
      // yet. This is what the "receipts not yet issued" count is counting.
      const cashTotal = isCurrent && key === 'local' ? CASH_GIFTS.reduce((a, b) => a + b, 0) : 0
      const bankCents = cents - cashTotal

      if (cashTotal > 0) {
        for (const [i, amount] of CASH_GIFTS.entries()) {
          const id = nextId('txn')
          await insertTransaction({
            id, account: CASH, fund, category: null,
            date: dayIn(month, 2 + i), cents: amount,
            payee: 'Cash at Feast', method: 'cash', kind: 'contribution',
          })
          await addGifts(id, fund, amount, 1, false)
        }
      }

      const id = nextId('txn')
      await insertTransaction({
        id, account: BANK, fund, category, date: dayIn(month, 3),
        cents: bankCents, payee: 'Contributions', method: 'bank', kind: 'contribution',
      })
      await addGifts(id, fund, bankCents, gifts[key], true)
    }
  }

  // ── expenses ─────────────────────────────────────────────────────────────

  const expenseIds: string[] = []
  for (const [monthText, lines] of Object.entries(EXPENSES)) {
    const month = Number(monthText)
    for (const [i, [category, cents]] of lines.entries()) {
      const id = nextId('txn')
      expenseIds.push(id)
      await insertTransaction({
        id, account: BANK, fund: 'fund-local',
        category: category === '' ? null : category,
        date: dayIn(month, 6 + i),
        cents: -cents,
        payee:
          EXPENSE_CATEGORIES.find((c) => c.id === category)?.label ??
          UNSORTED_PAYEES[i % UNSORTED_PAYEES.length],
        method: 'bank', kind: 'expense',
      })
    }
  }

  // Receipt images for every expense but the three most recent — the backlog
  // the dashboard nags about.
  for (const id of expenseIds.slice(0, -3)) {
    await db.run(
      `INSERT INTO attachments (id, assembly_id, transaction_id, kind, r2_key, filename, uploaded_at)
       VALUES (?, ?, ?, 'receipt_image', ?, ?, ?)`,
      [nextId('att'), ASSEMBLY_ID, id, `receipts/${id}.jpg`, `${id}.jpg`, NOW],
    )
  }

  // ── remittances ──────────────────────────────────────────────────────────

  for (const r of REMITTANCES) {
    const date = dayIn(r.month, 12)
    const id = nextId('txn')
    await insertTransaction({
      id, account: BANK, fund: r.fund, category: null,
      date, cents: -r.cents,
      payee: 'Forwarded upward', method: 'bank', kind: 'remittance',
    })
    await db.run(
      `INSERT INTO remittances (id, assembly_id, fund_id, transaction_id, sent_on, amount_cents, reference)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [nextId('rem'), ASSEMBLY_ID, r.fund, id, date, r.cents, r.reference],
    )
  }

  // ── the bank statement, reconciled ───────────────────────────────────────
  //
  // The treasurer has proved the account against the statement that ended with
  // Kamál. Two cheques written in the last days of the month had not reached
  // the bank by then, which is the ordinary case and the reason a difference
  // is not the same thing as a mistake — they stay outstanding, and they are
  // what the dashboard's fourth worklist row is counting.
  //
  // Most of what is ticked here belongs to months 1–7, whose reports are
  // presented and whose transactions are locked. Clearing them works anyway,
  // because what the bank has processed is recorded beside a transaction
  // rather than on it.
  const statementEnd = periods.find((p) => p.monthNumber === 8)!.endDate
  const bankRows = await db.all<{
    id: string
    kind: string
    category_id: string | null
    amount_cents: number
  }>(
    `SELECT id, kind, category_id, amount_cents FROM transactions
      WHERE account_id = ? AND occurred_on <= ?
      ORDER BY occurred_on ASC, id ASC`,
    [BANK, statementEnd],
  )
  // Bank fees are charged by the bank itself, so they are never in flight.
  const inFlight = new Set(
    bankRows
      .filter((r) => r.kind === 'expense' && r.category_id !== 'cat-bank')
      .slice(-2)
      .map((r) => r.id),
  )
  const clearedRows = bankRows.filter((r) => !inFlight.has(r.id))
  const statementBalance =
    OPENING_BALANCE_CENTS + clearedRows.reduce((sum, r) => sum + r.amount_cents, 0)

  // Open, then ticked, then balanced — the same order the app has to follow,
  // because a balanced reconciliation refuses to have its ticks changed.
  const reconciliationId = `rec-${BANK}-${statementEnd}`
  await db.run(
    `INSERT INTO reconciliations
       (id, assembly_id, account_id, statement_ended_on, statement_balance_cents,
        status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
    [reconciliationId, ASSEMBLY_ID, BANK, statementEnd, statementBalance, NOW, NOW],
  )
  for (const row of clearedRows) {
    await db.run(
      `INSERT INTO reconciliation_items (reconciliation_id, transaction_id, cleared_on)
       VALUES (?, ?, ?)`,
      [reconciliationId, row.id, statementEnd],
    )
  }
  await db.run(
    `UPDATE reconciliations
        SET status = 'balanced', completed_at = ?, completed_by = 'seed', updated_at = ?
      WHERE id = ?`,
    [NOW, NOW, reconciliationId],
  )

  // ── the budget ───────────────────────────────────────────────────────────
  //
  // Lines first, then the header. An approved year refuses new lines — that is
  // the point of the trigger — so the order here is the same order the app
  // itself has to follow.
  for (const [category, cents] of BUDGET.lines) {
    await db.run(
      `INSERT INTO budgets
         (id, assembly_id, bahai_year, category_id, amount_cents, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      [`bud-${SEED_YEAR}-${category}`, ASSEMBLY_ID, SEED_YEAR, category, cents, NOW, NOW],
    )
  }
  await db.run(
    `INSERT INTO budget_years
       (assembly_id, bahai_year, status, approved_on, approved_by, note, created_at, updated_at)
     VALUES (?, ?, 'approved', ?, NULL, ?, ?, ?)`,
    [ASSEMBLY_ID, SEED_YEAR, BUDGET.approvedOn, BUDGET.note, NOW, NOW],
  )

  // ── reports ──────────────────────────────────────────────────────────────
  //
  // Months 1-7 were presented at their Feast. Kamál's report is built but not
  // yet read out, which is the state the design illustrates.
  for (let month = 1; month <= 8; month++) {
    const period = periods.find((p) => p.monthNumber === month)!
    const presented = month <= 7
    await db.run(
      `INSERT INTO reports
         (id, assembly_id, bahai_year, month_number, cutoff_start, cutoff_end,
          status, finalized_at, finalized_by, presented_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'seed', ?)`,
      [
        `rep-${ASSEMBLY_ID}-${SEED_YEAR}-${month}`, ASSEMBLY_ID, SEED_YEAR, month,
        period.startDate, period.endDate,
        presented ? 'presented' : 'ready',
        NOW,
        presented ? NOW : null,
      ],
    )

    // A presented month is closed: its transactions are locked, and reopening
    // it is an explicit act. Kamál's report is built but not yet read out, so
    // its rows stay editable.
    if (presented) {
      await db.run(
        `UPDATE transactions SET is_locked = 1
          WHERE assembly_id = ? AND occurred_on BETWEEN ? AND ?`,
        [ASSEMBLY_ID, period.startDate, period.endDate],
      )
    }
  }
}
