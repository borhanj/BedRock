/**
 * The year dashboard, assembled from the database.
 *
 * Month boundaries are NOT in SQL. Daily sums come back from the database and
 * are bucketed into the nineteen months here, using the calendar engine — so
 * the Naw-Rúz table stays the only thing that decides where a month starts,
 * and a correction to it can never leave the database disagreeing.
 */

import { monthsForYear, nawRuz, toDayIndex } from '../../calendar/badi'
import { loadFundBalances } from './funds'
import { isSampleData } from './settings'
import { reconcileStanding } from './reconcile'
import type {
  AttentionView,
  MonthActivityView,
  MonthStatus,
  YearView,
} from '../../shared/types'
import type { SqlDatabase } from '../db/adapter'

interface DailyRow {
  on_date: string
  cents: number
}

/** Sum daily rows into the calendar month that contains each date. */
function bucketByMonth(
  rows: readonly DailyRow[],
  bounds: readonly { monthNumber: number; from: number; to: number }[],
): Map<number, number> {
  const totals = new Map<number, number>()
  for (const row of rows) {
    const day = toDayIndex(row.on_date)
    const bucket = bounds.find((b) => day >= b.from && day <= b.to)
    // Dates outside the year, or inside Ayyám-i-Há, have no month bucket. They
    // still count toward the year totals, just not toward a month's bar.
    if (!bucket) continue
    totals.set(bucket.monthNumber, (totals.get(bucket.monthNumber) ?? 0) + row.cents)
  }
  return totals
}

export async function loadYear(
  db: SqlDatabase,
  assemblyId: string,
  bahaiYear: number,
  today: string,
): Promise<YearView> {
  const assembly = await db.get<{ name: string; short_name: string }>(
    'SELECT name, short_name FROM assemblies WHERE id = ?',
    [assemblyId],
  )
  if (!assembly) throw new Error(`No assembly ${assemblyId}`)

  const periods = monthsForYear(bahaiYear)
  const yearStart = nawRuz(bahaiYear)
  const yearEnd = periods[periods.length - 1].endDate
  const todayIndex = toDayIndex(today)

  const bounds = periods
    .filter((p) => p.kind === 'month')
    .map((p) => ({
      monthNumber: p.monthNumber!,
      from: toDayIndex(p.startDate),
      to: toDayIndex(p.endDate),
    }))

  // ── daily flows, bucketed in TypeScript ──────────────────────────────────

  const contributionDays = await db.all<DailyRow>(
    `SELECT t.occurred_on AS on_date, SUM(c.amount_cents) AS cents
       FROM contributions c
       JOIN transactions t ON t.id = c.transaction_id
      WHERE c.assembly_id = ? AND t.occurred_on BETWEEN ? AND ?
      GROUP BY t.occurred_on`,
    [assemblyId, yearStart, yearEnd],
  )

  const expenseDays = await db.all<DailyRow>(
    // Expenses are stored negative; report them as positive magnitudes.
    `SELECT occurred_on AS on_date, -SUM(amount_cents) AS cents
       FROM transactions
      WHERE assembly_id = ? AND kind = 'expense' AND occurred_on BETWEEN ? AND ?
      GROUP BY occurred_on`,
    [assemblyId, yearStart, yearEnd],
  )

  const remittanceDays = await db.all<DailyRow>(
    `SELECT sent_on AS on_date, SUM(amount_cents) AS cents
       FROM remittances
      WHERE assembly_id = ? AND sent_on BETWEEN ? AND ?
      GROUP BY sent_on`,
    [assemblyId, yearStart, yearEnd],
  )

  const contributionsByMonth = bucketByMonth(contributionDays, bounds)
  const expensesByMonth = bucketByMonth(expenseDays, bounds)
  const remittedByMonth = bucketByMonth(remittanceDays, bounds)

  // ── report status per month ──────────────────────────────────────────────

  const reportRows = await db.all<{ month_number: number; status: string }>(
    'SELECT month_number, status FROM reports WHERE assembly_id = ? AND bahai_year = ?',
    [assemblyId, bahaiYear],
  )
  const reportStatus = new Map(reportRows.map((r) => [r.month_number, r.status]))

  const months: MonthActivityView[] = bounds.map((b) => {
    let status: MonthStatus
    if (b.from > todayIndex) {
      status = 'future'
    } else if (b.to >= todayIndex) {
      status = 'current'
    } else {
      // The period has ended. Only a presented report closes a month; anything
      // else still needs the treasurer.
      status = reportStatus.get(b.monthNumber) === 'presented' ? 'closed' : 'ready'
    }
    return {
      monthNumber: b.monthNumber,
      status,
      contributionsCents: contributionsByMonth.get(b.monthNumber) ?? 0,
      expensesCents: expensesByMonth.get(b.monthNumber) ?? 0,
      remittedCents: remittedByMonth.get(b.monthNumber) ?? 0,
    }
  })

  // ── year totals ──────────────────────────────────────────────────────────

  const totals = await db.get<{
    opening: number
    received: number
    paid: number
    remitted: number
    flows: number
  }>(
    `SELECT
       (SELECT COALESCE(SUM(opening_balance_cents), 0) FROM accounts WHERE assembly_id = ?) AS opening,
       (SELECT COALESCE(SUM(amount_cents), 0) FROM contributions WHERE assembly_id = ?) AS received,
       (SELECT COALESCE(-SUM(amount_cents), 0) FROM transactions WHERE assembly_id = ? AND kind = 'expense') AS paid,
       (SELECT COALESCE(SUM(amount_cents), 0) FROM remittances WHERE assembly_id = ?) AS remitted,
       (SELECT COALESCE(SUM(amount_cents), 0) FROM transactions WHERE assembly_id = ?) AS flows`,
    [assemblyId, assemblyId, assemblyId, assemblyId, assemblyId],
  )

  const openingBalanceCents = totals?.opening ?? 0
  // Every movement of money is a transaction, signed. The balance is simply
  // what the accounts opened with plus everything that has moved since.
  const onHandTodayCents = openingBalanceCents + (totals?.flows ?? 0)

  const funds = await loadFundBalances(db, assemblyId, onHandTodayCents)
  const [attention, sample] = await Promise.all([
    loadAttention(db, assemblyId),
    isSampleData(db, assemblyId),
  ])

  return {
    bahaiYear,
    today,
    assembly: {
      name: assembly.name,
      shortName: assembly.short_name,
      // Phase 5 replaces this with the signed-in treasurer from Cloudflare Access.
      treasurerInitials: 'RN',
    },
    openingBalanceCents,
    receivedToDateCents: totals?.received ?? 0,
    paidToDateCents: totals?.paid ?? 0,
    remittedToDateCents: totals?.remitted ?? 0,
    onHandTodayCents,
    months,
    funds,
    attention,
    isSampleData: sample,
  }
}

/**
 * The worklist.
 *
 * Only counts the database can actually answer. The fourth row — unmatched
 * bank items — is the one the mockup showed and Phase 2 left out, because a
 * confident zero for a check that had never run would have been worse than no
 * row at all. It is here now, and it still refuses to claim a zero: until a
 * statement has been balanced it reports that the check has not run, rather
 * than that there is nothing to find.
 */
async function loadAttention(
  db: SqlDatabase,
  assemblyId: string,
): Promise<AttentionView[]> {
  const row = await db.get<{
    uncategorised: number
    missing_receipt_image: number
    unissued_receipts: number
  }>(
    `SELECT
       (SELECT COUNT(*) FROM transactions
         WHERE assembly_id = ? AND category_id IS NULL AND kind IN ('contribution', 'expense')
       ) AS uncategorised,
       (SELECT COUNT(*) FROM transactions t
         WHERE t.assembly_id = ? AND t.kind = 'expense'
           AND NOT EXISTS (SELECT 1 FROM attachments a
                            WHERE a.transaction_id = t.id AND a.kind = 'receipt_image')
       ) AS missing_receipt_image,
       (SELECT COUNT(*) FROM contributions c
          JOIN transactions t ON t.id = c.transaction_id
         WHERE c.assembly_id = ? AND t.method = 'cash' AND c.receipt_id IS NULL
       ) AS unissued_receipts`,
    [assemblyId, assemblyId, assemblyId],
  )

  const bank = await reconcileStanding(db, assemblyId)

  return [
    {
      key: 'uncategorised',
      count: row?.uncategorised ?? 0,
      label: 'transactions with no category',
      resolvedLabel: 'transactions with no category — all categorised',
      href: '/ledger?uncategorised=1',
    },
    {
      key: 'missing-receipt-image',
      count: row?.missing_receipt_image ?? 0,
      label: 'expenses missing a receipt image',
      resolvedLabel: 'expenses missing a receipt image — all documented',
      href: '/ledger',
    },
    {
      key: 'unissued-receipts',
      count: row?.unissued_receipts ?? 0,
      label: 'receipts not yet issued for cash gifts',
      resolvedLabel: 'cash gifts awaiting a receipt — all issued',
      href: '/receipts',
    },
    bank.lastBalancedOn === null
      ? {
          key: 'unreconciled',
          count: 0,
          tone: 'unknown' as const,
          label: 'the bank has never been reconciled',
          href: '/ledger/reconcile',
        }
      : {
          key: 'unreconciled',
          count: bank.unclearedCount,
          label: `bank items not on a statement, as at ${bank.lastBalancedOn}`,
          resolvedLabel: `every bank item is on a statement, to ${bank.lastBalancedOn}`,
          href: '/ledger/reconcile',
        },
  ]
}
