/**
 * Feast reports: building them, closing them, and reopening them.
 *
 * Two ideas run through this file.
 *
 * The report's WINDOW is its own. cutoff_start/cutoff_end default to the
 * calendar bounds of the month but can be moved when a bank statement posts
 * late, which is the normal case rather than an exception. Every figure is
 * computed against the cutoff. The Feast NAME comes from the month and never
 * moves with it.
 *
 * A FINALISED report is a statement already made. Its figures are frozen into
 * a snapshot and its transactions are locked. If a later correction to a prior
 * period moves the numbers, the report keeps saying what it said and reports
 * the discrepancy — quietly rewriting a report the community has already been
 * read, and quietly serving stale figures with no warning, are both worse.
 */

import { monthsForYear, type BadiPeriod } from '../../calendar/badi'
import type {
  ReportDrift,
  ReportLineView,
  ReportStatus,
  ReportView,
  YearMonthSummary,
  YearSummaryView,
} from '../../shared/types'
import type { SqlDatabase } from '../db/adapter'
import { setAuditActor } from '../db/adapter'

// ── balance helpers ──────────────────────────────────────────────────────────

async function balanceAsOf(
  db: SqlDatabase,
  assemblyId: string,
  onDate: string,
  inclusive: boolean,
): Promise<number> {
  const comparison = inclusive ? '<=' : '<'
  const row = await db.get<{ cents: number }>(
    `SELECT (SELECT COALESCE(SUM(opening_balance_cents), 0) FROM accounts WHERE assembly_id = ?)
          + (SELECT COALESCE(SUM(amount_cents), 0) FROM transactions
              WHERE assembly_id = ? AND occurred_on ${comparison} ?) AS cents`,
    [assemblyId, assemblyId, onDate],
  )
  return row?.cents ?? 0
}

async function passthroughHeldAsOf(
  db: SqlDatabase,
  assemblyId: string,
  onDate: string,
): Promise<number> {
  const row = await db.get<{ cents: number }>(
    `SELECT COALESCE((SELECT SUM(c.amount_cents)
                        FROM contributions c
                        JOIN transactions t ON t.id = c.transaction_id
                        JOIN funds f ON f.id = c.fund_id
                       WHERE c.assembly_id = ? AND f.is_passthrough = 1
                         AND t.occurred_on <= ?), 0)
          - COALESCE((SELECT SUM(r.amount_cents)
                        FROM remittances r
                        JOIN funds f2 ON f2.id = r.fund_id
                       WHERE r.assembly_id = ? AND f2.is_passthrough = 1
                         AND r.sent_on <= ?), 0) AS cents`,
    [assemblyId, onDate, assemblyId, onDate],
  )
  return row?.cents ?? 0
}

async function cashAsOf(
  db: SqlDatabase,
  assemblyId: string,
  onDate: string,
): Promise<number> {
  const row = await db.get<{ cents: number }>(
    `SELECT (SELECT COALESCE(SUM(opening_balance_cents), 0)
               FROM accounts WHERE assembly_id = ? AND kind = 'cash')
          + COALESCE((SELECT SUM(t.amount_cents)
                        FROM transactions t
                        JOIN accounts a ON a.id = t.account_id
                       WHERE a.assembly_id = ? AND a.kind = 'cash'
                         AND t.occurred_on <= ?), 0) AS cents`,
    [assemblyId, assemblyId, onDate],
  )
  return row?.cents ?? 0
}

interface ReportLineRow {
  label: string
  amount_cents: number
}

const toLine = (row: ReportLineRow): ReportLineView => ({
  label: row.label,
  amountCents: row.amount_cents,
})

/**
 * The closing balance split three ways.
 *
 * Built as a partition of the closing balance rather than three independent
 * queries, so the lines always sum to the total printed beside them. The Local
 * Fund is the residual: what is left once other institutions' money and the
 * cash tin are set aside. Zero lines are dropped, except the Local Fund, which
 * is the headline figure and stays even at zero.
 */
async function closingBreakdown(
  db: SqlDatabase,
  assemblyId: string,
  onDate: string,
  closingCents: number,
): Promise<ReportLineView[]> {
  const heldForOthers = await passthroughHeldAsOf(db, assemblyId, onDate)
  const cashCents = await cashAsOf(db, assemblyId, onDate)
  return [
    { label: 'Local Fund', amountCents: closingCents - heldForOthers - cashCents },
    { label: 'held for other funds', amountCents: heldForOthers },
    { label: 'cash', amountCents: cashCents },
  ].filter((line, i) => i === 0 || line.amountCents !== 0)
}

// ── computing a report ───────────────────────────────────────────────────────

interface Computed {
  openingCents: number
  closingCents: number
  income: ReportLineView[]
  expenses: ReportLineView[]
  remittedCents: number
  closingBreakdown: ReportLineView[]
  contributionCount: number
  householdCount: number
}

/** The report as the data stands right now, for a given window. */
async function computeReport(
  db: SqlDatabase,
  assemblyId: string,
  from: string,
  to: string,
): Promise<Computed> {
  const income = await db.all<ReportLineRow>(
    `SELECT f.label AS label, SUM(c.amount_cents) AS amount_cents
       FROM contributions c
       JOIN transactions t ON t.id = c.transaction_id
       JOIN funds f ON f.id = c.fund_id
      WHERE c.assembly_id = ? AND t.occurred_on BETWEEN ? AND ?
      GROUP BY f.id, f.label
      ORDER BY f.sort_order`,
    [assemblyId, from, to],
  )

  const expenses = await db.all<ReportLineRow>(
    `SELECT COALESCE(cat.label, 'Uncategorised') AS label,
            -SUM(t.amount_cents) AS amount_cents
       FROM transactions t
       LEFT JOIN categories cat ON cat.id = t.category_id
      WHERE t.assembly_id = ? AND t.kind = 'expense' AND t.occurred_on BETWEEN ? AND ?
      GROUP BY cat.id, label
      ORDER BY amount_cents DESC`,
    [assemblyId, from, to],
  )

  const counts = await db.get<{
    contributions: number
    households: number
    remitted: number
  }>(
    `SELECT
       (SELECT COUNT(*) FROM contributions c
          JOIN transactions t ON t.id = c.transaction_id
         WHERE c.assembly_id = ? AND t.occurred_on BETWEEN ? AND ?) AS contributions,
       (SELECT COUNT(DISTINCT c.donor_id) FROM contributions c
          JOIN transactions t ON t.id = c.transaction_id
         WHERE c.assembly_id = ? AND c.donor_id IS NOT NULL
           AND t.occurred_on BETWEEN ? AND ?) AS households,
       (SELECT COALESCE(SUM(amount_cents), 0) FROM remittances
         WHERE assembly_id = ? AND sent_on BETWEEN ? AND ?) AS remitted`,
    [assemblyId, from, to, assemblyId, from, to, assemblyId, from, to],
  )

  const openingCents = await balanceAsOf(db, assemblyId, from, false)
  const closingCents = await balanceAsOf(db, assemblyId, to, true)

  return {
    openingCents,
    closingCents,
    income: income.map(toLine),
    expenses: expenses.map(toLine),
    remittedCents: counts?.remitted ?? 0,
    closingBreakdown: await closingBreakdown(db, assemblyId, to, closingCents),
    contributionCount: counts?.contributions ?? 0,
    householdCount: counts?.households ?? 0,
  }
}

const sum = (lines: readonly ReportLineView[]) =>
  lines.reduce((total, l) => total + l.amountCents, 0)

interface ReportRow {
  cutoff_start: string
  cutoff_end: string
  status: ReportStatus
  finalized_at: string | null
  presented_at: string | null
  snapshot_json: string | null
}

async function readRow(
  db: SqlDatabase,
  assemblyId: string,
  year: number,
  month: number,
): Promise<ReportRow | null> {
  return db.get<ReportRow>(
    `SELECT cutoff_start, cutoff_end, status, finalized_at, presented_at, snapshot_json
       FROM reports WHERE assembly_id = ? AND bahai_year = ? AND month_number = ?`,
    [assemblyId, year, month],
  )
}

function periodFor(year: number, month: number): BadiPeriod | undefined {
  return monthsForYear(year).find((p) => p.monthNumber === month)
}

export function reportId(assemblyId: string, year: number, month: number): string {
  return `rep-${assemblyId}-${year}-${month}`
}

/**
 * A report, snapshot-aware.
 *
 * A finalised report serves its frozen figures. Live data is recomputed anyway
 * so that a divergence can be reported rather than hidden.
 */
export async function loadReport(
  db: SqlDatabase,
  assemblyId: string,
  year: number,
  month: number,
): Promise<ReportView | null> {
  const period = periodFor(year, month)
  if (!period) return null

  const row = await readRow(db, assemblyId, year, month)
  if (!row) return null

  const live = await computeReport(db, assemblyId, row.cutoff_start, row.cutoff_end)
  const frozen: Computed | null = row.snapshot_json
    ? (JSON.parse(row.snapshot_json) as Computed)
    : null
  const shown = frozen ?? live

  let drift: ReportDrift | null = null
  if (frozen) {
    const changed =
      frozen.openingCents !== live.openingCents ||
      frozen.closingCents !== live.closingCents ||
      sum(frozen.income) !== sum(live.income) ||
      sum(frozen.expenses) !== sum(live.expenses)
    if (changed) {
      drift = {
        liveOpeningCents: live.openingCents,
        liveClosingCents: live.closingCents,
        liveIncomeCents: sum(live.income),
        liveExpensesCents: sum(live.expenses),
      }
    }
  }

  return {
    bahaiYear: year,
    monthNumber: month,
    cutoffStart: row.cutoff_start,
    cutoffEnd: row.cutoff_end,
    calendarStart: period.startDate,
    calendarEnd: period.endDate,
    status: row.status,
    presentedAtMonth: month < 19 ? month + 1 : null,
    openingCents: shown.openingCents,
    income: shown.income,
    expenses: shown.expenses,
    remittedCents: shown.remittedCents,
    closingBreakdown: shown.closingBreakdown,
    closingCents: shown.closingCents,
    contributionCount: shown.contributionCount,
    householdCount: shown.householdCount,
    finalizedAt: row.finalized_at,
    presentedAt: row.presented_at,
    locked: row.status !== 'draft',
    drift,
  }
}

/** Start a draft for a month, defaulting the cutoff to the calendar bounds. */
export async function ensureReport(
  db: SqlDatabase,
  assemblyId: string,
  year: number,
  month: number,
  actor: string,
): Promise<ReportView | null> {
  const period = periodFor(year, month)
  if (!period) return null

  const existing = await readRow(db, assemblyId, year, month)
  if (!existing) {
    await setAuditActor(db, actor)
    await db.run(
      `INSERT INTO reports
         (id, assembly_id, bahai_year, month_number, cutoff_start, cutoff_end, status)
       VALUES (?, ?, ?, ?, ?, ?, 'draft')`,
      [
        reportId(assemblyId, year, month),
        assemblyId,
        year,
        month,
        period.startDate,
        period.endDate,
      ],
    )
  }
  return loadReport(db, assemblyId, year, month)
}

export class ReportStateError extends Error {}

/**
 * Move the reporting window.
 *
 * Only on a draft. The Feast name is untouched — that comes from the month,
 * not from these dates — which is the whole point of keeping them separate.
 */
export async function setCutoff(
  db: SqlDatabase,
  assemblyId: string,
  year: number,
  month: number,
  cutoffStart: string,
  cutoffEnd: string,
  actor: string,
): Promise<ReportView | null> {
  const row = await readRow(db, assemblyId, year, month)
  if (!row) return null
  if (row.status !== 'draft') {
    throw new ReportStateError(
      'This report is closed. Unlock it before changing its reporting cutoff.',
    )
  }
  if (cutoffEnd < cutoffStart) {
    throw new ReportStateError('The cutoff must end on or after it starts.')
  }

  await setAuditActor(db, actor)
  await db.run(
    `UPDATE reports SET cutoff_start = ?, cutoff_end = ?
      WHERE assembly_id = ? AND bahai_year = ? AND month_number = ?`,
    [cutoffStart, cutoffEnd, assemblyId, year, month],
  )
  return loadReport(db, assemblyId, year, month)
}

/**
 * Close the books for the period.
 *
 * Freezes the figures and locks every transaction inside the window. The lock
 * is enforced by a trigger, so a locked row cannot be edited by any code path
 * until the report is explicitly unlocked.
 */
export async function finalizeReport(
  db: SqlDatabase,
  assemblyId: string,
  year: number,
  month: number,
  actor: string,
  now: string,
): Promise<ReportView | null> {
  const row = await readRow(db, assemblyId, year, month)
  if (!row) return null
  if (row.status !== 'draft') {
    throw new ReportStateError('This report is already closed.')
  }

  await setAuditActor(db, actor)
  const snapshot = await computeReport(db, assemblyId, row.cutoff_start, row.cutoff_end)

  await db.run(
    `UPDATE reports
        SET status = 'ready', finalized_at = ?, finalized_by = ?, snapshot_json = ?
      WHERE assembly_id = ? AND bahai_year = ? AND month_number = ?`,
    [now, actor, JSON.stringify(snapshot), assemblyId, year, month],
  )

  await db.run(
    `UPDATE transactions SET is_locked = 1
      WHERE assembly_id = ? AND is_locked = 0 AND occurred_on BETWEEN ? AND ?`,
    [assemblyId, row.cutoff_start, row.cutoff_end],
  )

  return loadReport(db, assemblyId, year, month)
}

/** Mark a finalised report as read out at Feast. */
export async function presentReport(
  db: SqlDatabase,
  assemblyId: string,
  year: number,
  month: number,
  actor: string,
  now: string,
): Promise<ReportView | null> {
  const row = await readRow(db, assemblyId, year, month)
  if (!row) return null
  if (row.status !== 'ready') {
    throw new ReportStateError(
      row.status === 'draft'
        ? 'Build the report before presenting it.'
        : 'This report has already been presented.',
    )
  }

  await setAuditActor(db, actor)
  await db.run(
    `UPDATE reports SET status = 'presented', presented_at = ?
      WHERE assembly_id = ? AND bahai_year = ? AND month_number = ?`,
    [now, assemblyId, year, month],
  )
  return loadReport(db, assemblyId, year, month)
}

/**
 * Reopen closed books.
 *
 * Discards the frozen snapshot and unlocks the period's transactions. This is
 * deliberately a distinct, audited act rather than a side effect of editing:
 * the treasurer has to say they are reopening a period, and the log records
 * that they did.
 *
 * Transactions locked by an OVERLAPPING report stay locked — a row inside two
 * windows is only free when both are open.
 */
export async function unlockReport(
  db: SqlDatabase,
  assemblyId: string,
  year: number,
  month: number,
  actor: string,
  now: string,
): Promise<ReportView | null> {
  const row = await readRow(db, assemblyId, year, month)
  if (!row) return null
  if (row.status === 'draft') {
    throw new ReportStateError('This report is already open.')
  }

  await setAuditActor(db, actor)
  await db.run(
    `UPDATE reports
        SET status = 'draft', finalized_at = NULL, presented_at = NULL,
            snapshot_json = NULL, unlocked_at = ?, unlocked_by = ?
      WHERE assembly_id = ? AND bahai_year = ? AND month_number = ?`,
    [now, actor, assemblyId, year, month],
  )

  await db.run(
    `UPDATE transactions SET is_locked = 0
      WHERE assembly_id = ? AND occurred_on BETWEEN ? AND ?
        AND NOT EXISTS (
          SELECT 1 FROM reports r
           WHERE r.assembly_id = transactions.assembly_id
             AND r.status <> 'draft'
             AND transactions.occurred_on BETWEEN r.cutoff_start AND r.cutoff_end
        )`,
    [assemblyId, row.cutoff_start, row.cutoff_end],
  )

  return loadReport(db, assemblyId, year, month)
}

// ── the year ─────────────────────────────────────────────────────────────────

/**
 * The Bahá'í year end to end, for the Assembly's annual review.
 *
 * Runs over the whole year rather than the union of the reports, so money that
 * fell outside every report's cutoff still appears. A year summary that
 * silently omitted a transaction because no monthly report happened to cover
 * it would be worse than useless at audit.
 */
export async function loadYearSummary(
  db: SqlDatabase,
  assemblyId: string,
  year: number,
): Promise<YearSummaryView | null> {
  const assembly = await db.get<{ name: string; short_name: string }>(
    'SELECT name, short_name FROM assemblies WHERE id = ?',
    [assemblyId],
  )
  if (!assembly) return null

  const periods = monthsForYear(year)
  const from = periods[0].startDate
  const to = periods[periods.length - 1].endDate

  const totals = await computeReport(db, assemblyId, from, to)

  const remittances = await db.all<ReportLineRow>(
    `SELECT f.label AS label, SUM(r.amount_cents) AS amount_cents
       FROM remittances r JOIN funds f ON f.id = r.fund_id
      WHERE r.assembly_id = ? AND r.sent_on BETWEEN ? AND ?
      GROUP BY f.id, f.label ORDER BY f.sort_order`,
    [assemblyId, from, to],
  )

  const statuses = new Map(
    (
      await db.all<{ month_number: number; status: ReportStatus }>(
        'SELECT month_number, status FROM reports WHERE assembly_id = ? AND bahai_year = ?',
        [assemblyId, year],
      )
    ).map((r) => [r.month_number, r.status]),
  )

  const months: YearMonthSummary[] = []
  for (const period of periods) {
    if (period.kind !== 'month') continue
    const monthTotals = await computeReport(
      db,
      assemblyId,
      period.startDate,
      period.endDate,
    )
    months.push({
      monthNumber: period.monthNumber!,
      name: period.name,
      contributionsCents: sum(monthTotals.income),
      expensesCents: sum(monthTotals.expenses),
      remittedCents: monthTotals.remittedCents,
      closingCents: monthTotals.closingCents,
      status: statuses.get(period.monthNumber!) ?? 'none',
    })
  }

  return {
    bahaiYear: year,
    nawRuz: from,
    yearEnd: to,
    assembly: {
      name: assembly.name,
      shortName: assembly.short_name,
      treasurerInitials: 'RN',
    },
    openingCents: totals.openingCents,
    closingCents: totals.closingCents,
    incomeByFund: totals.income,
    expensesByCategory: totals.expenses,
    remittancesByFund: remittances.map(toLine),
    months,
    contributionCount: totals.contributionCount,
    householdCount: totals.householdCount,
    reportsPresented: [...statuses.values()].filter((s) => s === 'presented').length,
    closingBreakdown: totals.closingBreakdown,
  }
}
