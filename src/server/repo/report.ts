/**
 * A Feast report, assembled from the database.
 *
 * The report's window is its own. cutoff_start/cutoff_end default to the
 * calendar bounds of the month but can be moved when a bank statement posts
 * late, and every figure below is computed against the cutoff rather than the
 * calendar. The Feast name comes from the month and never moves with it.
 */

import { monthsForYear } from '../../calendar/badi'
import type { ReportLineView, ReportStatus, ReportView } from '../../shared/types'
import type { SqlDatabase } from '../db/adapter'

/** Opening balance and closing partition both need a balance as at a date. */
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

export async function loadReport(
  db: SqlDatabase,
  assemblyId: string,
  bahaiYear: number,
  monthNumber: number,
): Promise<ReportView | null> {
  const period = monthsForYear(bahaiYear).find((p) => p.monthNumber === monthNumber)
  if (!period) return null

  const stored = await db.get<{
    cutoff_start: string
    cutoff_end: string
    status: ReportStatus
  }>(
    `SELECT cutoff_start, cutoff_end, status FROM reports
      WHERE assembly_id = ? AND bahai_year = ? AND month_number = ?`,
    [assemblyId, bahaiYear, monthNumber],
  )
  if (!stored) return null

  const { cutoff_start: from, cutoff_end: to, status } = stored

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
  const heldForOthers = await passthroughHeldAsOf(db, assemblyId, to)
  const cashCents = await cashAsOf(db, assemblyId, to)

  // Same partition as the dashboard's fund card: the Local Fund is the
  // residual, so the three lines always sum to the closing balance printed
  // beside them. The source mockup got this wrong by exactly the cash box.
  const closingBreakdown: ReportLineView[] = [
    { label: 'Local Fund', amountCents: closingCents - heldForOthers - cashCents },
    { label: 'held for other funds', amountCents: heldForOthers },
    { label: 'cash', amountCents: cashCents },
    // A zero line is noise on a report read aloud at Feast. The Local Fund
    // line always stays, even at zero, because it is the headline figure.
  ].filter((line, i) => i === 0 || line.amountCents !== 0)

  return {
    bahaiYear,
    monthNumber,
    cutoffStart: from,
    cutoffEnd: to,
    status,
    presentedAtMonth: monthNumber < 19 ? monthNumber + 1 : null,
    openingCents,
    income: income.map(toLine),
    expenses: expenses.map(toLine),
    remittedCents: counts?.remitted ?? 0,
    closingBreakdown,
    contributionCount: counts?.contributions ?? 0,
    householdCount: counts?.households ?? 0,
  }
}

interface ReportLineRow {
  label: string
  amount_cents: number
}

function toLine(row: ReportLineRow): ReportLineView {
  return { label: row.label, amountCents: row.amount_cents }
}
