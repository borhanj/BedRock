/**
 * The Audit Package: everything an auditor asks for, in one document.
 *
 * Two principles hold this together.
 *
 * It composes the same functions the screens read — `loadYearSummary`,
 * `loadFunds`, `loadBudget`, `listReconciliations`, `listReceipts`. Not
 * equivalent queries written again for print, but the same ones. A package
 * that could disagree with the app would be worse than no package, because the
 * disagreement would surface in front of the auditor and neither figure could
 * then be trusted.
 *
 * And it states what it cannot vouch for. A tidy pack that omits eleven
 * uncategorised rows and a bank account last reconciled in Jalál is not a
 * clean audit; it is the same audit with the findings removed, discovered
 * later and worse. The gaps below are printed on the face of the document, and
 * the integrity checks say plainly which ones failed.
 */

import { monthsForYear, nawRuz } from '../../calendar/badi'
import { BADI_MONTHS } from '../../calendar/months'
import type { Cents } from '../../lib/money'
import type { AssemblyView, YearSummaryView } from '../../shared/types'
import type { SqlDatabase } from '../db/adapter'
import { loadYearSummary, loadReport } from './report'
import { loadFunds, onHand, type FundsView } from './funds'
import {
  loadCheckpoints,
  loadOpeningPosition,
  type CheckpointView,
} from './opening'
import { loadBudget, type BudgetView } from './budget'
import { listReconciliations, type ReconciliationSummary } from './reconcile'
import { listReceipts, receiptSummary, type ReceiptLogSummary, type ReceiptView } from './receipts'
import { readAccessLog, type AccessLogEntry } from './donors'
import { loadLedger, type LedgerRow } from './ledger'

/**
 * A check that either holds or does not.
 *
 * `holds: false` is not an error condition — it is a finding, which is what an
 * audit is for. The wording is written to be read by someone who did not build
 * this and is deciding whether to trust it.
 */
export interface AuditCheck {
  readonly key: string
  readonly holds: boolean
  readonly label: string
  /** What was actually found, in the auditor's terms. */
  readonly detail: string
}

/** Work not finished, disclosed rather than omitted. */
export interface AuditGap {
  readonly key: string
  readonly count: number
  readonly label: string
  /** Why it matters to someone checking the books. */
  readonly consequence: string
}

export interface AuditPackageView {
  readonly bahaiYear: number
  readonly nawRuz: string
  readonly yearEnd: string
  readonly assembly: AssemblyView
  readonly preparedOn: string
  readonly preparedBy: string
  /** True once the Bahá'í year has ended; a mid-year pack says so. */
  readonly yearComplete: boolean
  readonly summary: YearSummaryView
  readonly funds: FundsView
  readonly budget: BudgetView
  readonly reconciliations: readonly ReconciliationSummary[]
  readonly receiptSummary: ReceiptLogSummary
  readonly receipts: readonly ReceiptView[]
  readonly donorAccess: readonly AccessLogEntry[]
  readonly ledger: readonly LedgerRow[]
  readonly checks: readonly AuditCheck[]
  readonly gaps: readonly AuditGap[]
  /**
   * Figures the Assembly accepted before the books were restated backwards,
   * and whether the history loaded since reproduces them. Empty for books
   * whose opening date has never moved, which is most of them.
   */
  readonly checkpoints: readonly CheckpointView[]
}

export async function loadAuditPackage(
  db: SqlDatabase,
  assemblyId: string,
  bahaiYear: number,
  today: string,
  preparedBy: string,
): Promise<AuditPackageView | null> {
  const summary = await loadYearSummary(db, assemblyId, bahaiYear)
  if (!summary) return null

  const periods = monthsForYear(bahaiYear)
  const from = nawRuz(bahaiYear)
  const to = periods[periods.length - 1].endDate

  const [funds, budget, reconciliations, receipts, receipts_, donorAccess, ledger] =
    await Promise.all([
      loadFunds(db, assemblyId, bahaiYear),
      loadBudget(db, assemblyId, bahaiYear, today),
      listReconciliations(db, assemblyId),
      receiptSummary(db, assemblyId),
      listReceipts(db, assemblyId),
      readAccessLog(db, assemblyId, 500),
      // Every row in the year. An auditor wants the ledger, not a page of it.
      loadLedger(db, assemblyId, { bahaiYear, limit: 2000 }),
    ])

  return {
    bahaiYear,
    nawRuz: from,
    yearEnd: to,
    assembly: summary.assembly,
    preparedOn: today,
    preparedBy,
    yearComplete: today > to,
    summary,
    funds,
    budget,
    reconciliations,
    receiptSummary: receipts,
    receipts: receipts_,
    donorAccess,
    ledger,
    checks: await runChecks(db, assemblyId, bahaiYear, funds, receipts),
    gaps: await findGaps(db, assemblyId, bahaiYear, from, to),
    checkpoints: await loadCheckpoints(db, assemblyId),
  }
}

/**
 * The checks that make this an audit package rather than a print-out.
 *
 * Each one is something an auditor would otherwise have to establish by hand,
 * and each is computed against the database at the moment the pack is drawn —
 * never cached, never asserted from a flag someone set.
 */
async function runChecks(
  db: SqlDatabase,
  assemblyId: string,
  bahaiYear: number,
  funds: FundsView,
  receipts: ReceiptLogSummary,
): Promise<AuditCheck[]> {
  const checks: AuditCheck[] = []

  // ── the receipt book has no holes ────────────────────────────────────────
  //
  // Counted against MAX rather than trusting the sequence: a gap in a receipt
  // book reads to an auditor as a destroyed record, so the pack proves the
  // absence of one instead of asserting it.
  const numbering = await db.get<{ highest: number; issued: number; lowest: number }>(
    `SELECT COALESCE(MAX(number), 0) AS highest, COUNT(*) AS issued,
            COALESCE(MIN(number), 1) AS lowest
       FROM receipts WHERE assembly_id = ?`,
    [assemblyId],
  )
  const highest = numbering?.highest ?? 0
  const issued = numbering?.issued ?? 0
  checks.push({
    key: 'receipts-gapless',
    holds: highest === issued && (issued === 0 || numbering?.lowest === 1),
    label: 'Receipt numbering is gapless',
    detail:
      issued === 0
        ? 'No receipts have been issued.'
        : `${issued} receipt${issued === 1 ? '' : 's'} numbered 1 to ${highest}` +
          `${receipts.voided > 0 ? `, ${receipts.voided} voided and retained` : ''}.`,
  })

  // ── nothing moved without an actor ───────────────────────────────────────
  const attribution = await db.get<{ txns: number; logged: number; blank: number }>(
    `SELECT
       (SELECT COUNT(*) FROM transactions WHERE assembly_id = ?) AS txns,
       (SELECT COUNT(DISTINCT entity_id) FROM audit_log
         WHERE assembly_id = ? AND entity = 'transactions' AND action = 'insert') AS logged,
       (SELECT COUNT(*) FROM audit_log WHERE assembly_id = ? AND TRIM(actor) = '') AS blank`,
    [assemblyId, assemblyId, assemblyId],
  )
  const txns = attribution?.txns ?? 0
  const logged = attribution?.logged ?? 0
  checks.push({
    key: 'audit-trail',
    holds: logged >= txns && (attribution?.blank ?? 0) === 0,
    label: 'Every transaction is in the audit trail, attributed',
    // Across the whole book, not just this year: the trail is only worth
    // anything if it has no holes anywhere, and a year-scoped count would let
    // a gap in an earlier year pass unremarked.
    detail:
      `${logged} of ${txns} transaction${txns === 1 ? '' : 's'} on record across all ` +
      `years were logged on entry, ${attribution?.blank ?? 0} with no actor. ` +
      'The trail is written by database triggers, so a write from outside this ' +
      'application is recorded on the same terms.',
  })

  // ── the fund balances are a partition of what is on hand ─────────────────
  const partition = funds.funds.reduce((sum, f) => sum + f.balanceCents, 0)
  const held = await onHand(db, assemblyId)
  checks.push({
    key: 'funds-foot',
    holds: partition === held,
    label: 'Fund balances account for every cent on hand',
    detail:
      partition === held
        ? `${funds.funds.length} funds summing to ${money(held)}.`
        : `Funds sum to ${money(partition)} against ${money(held)} on hand — ` +
          `a difference of ${money(Math.abs(partition - held))}.`,
  })

  // ── no presented report has quietly moved ────────────────────────────────
  //
  // A finalised report is a statement already made to the community. If a
  // later correction has moved the figures it still shows what was presented,
  // and the divergence belongs in the audit pack rather than only on screen.
  // Only a report with a frozen snapshot can diverge from one: drift is the
  // difference between what was presented and what the ledger now says, and a
  // month that was never closed has nothing frozen to differ from. Asking the
  // database which months those are costs one query and saves a recomputation
  // of every month that has not been closed yet — eleven of nineteen on a
  // year still running, and each of those is eight round trips against D1.
  //
  // The rest are recomputed together rather than one after another. They are
  // reads, they do not depend on each other, and in sequence they were most of
  // what made this document slow to draw.
  const closed = await db.all<{ month_number: number }>(
    `SELECT month_number FROM reports
      WHERE assembly_id = ? AND bahai_year = ? AND snapshot_json IS NOT NULL
      ORDER BY month_number`,
    [assemblyId, bahaiYear],
  )
  const checked = await Promise.all(
    closed.map((r) => loadReport(db, assemblyId, bahaiYear, r.month_number)),
  )
  const drifted = closed
    .filter((_, i) => checked[i]?.drift)
    .map((r) => r.month_number)
  checks.push({
    key: 'reports-stable',
    holds: drifted.length === 0,
    label: 'Presented reports still match the ledger',
    detail:
      drifted.length === 0
        ? 'No closed report diverges from a live recomputation.'
        : `${drifted.length} report${drifted.length === 1 ? '' : 's'} diverge: ` +
          `${drifted.map((m) => BADI_MONTHS[m - 1].name).join(', ')}. ` +
          'Each still shows the figures presented, with the divergence beside them.',
  })

  // ── money is integers, all the way down ──────────────────────────────────
  //
  // Cheap to check and worth stating: a REAL column anywhere in the ledger is
  // a rounding error waiting for the year it matters.
  const reals = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM pragma_table_info('transactions')
      WHERE UPPER(type) LIKE '%REAL%'`,
  )
  checks.push({
    key: 'integer-money',
    holds: (reals?.n ?? 0) === 0,
    label: 'Money is stored as whole cents',
    detail:
      (reals?.n ?? 0) === 0
        ? 'No floating-point column in the ledger; every figure foots exactly.'
        : `${reals?.n} floating-point column(s) found in transactions.`,
  })

  return checks
}

/**
 * What is not finished.
 *
 * Printed on the face of the pack. Omitting these would not make the books
 * cleaner, only make the same findings arrive later and from someone else.
 */
async function findGaps(
  db: SqlDatabase,
  assemblyId: string,
  bahaiYear: number,
  from: string,
  to: string,
): Promise<AuditGap[]> {
  // Disclosed rather than left to be noticed. An opening difference nobody has
  // accounted for is exactly the kind of thing an auditor finds and the pack
  // should have said first — and unlike the counts below it is not a tidiness
  // problem but money whose ownership is unknown.
  const position = await loadOpeningPosition(db, assemblyId)
  const checkpoints = await loadCheckpoints(db, assemblyId)
  const broken = checkpoints.filter((c) => !c.holds)

  const row = await db.get<{
    uncategorised: number
    no_image: number
    no_receipt: number
    unpresented: number
  }>(
    `SELECT
       (SELECT COUNT(*) FROM transactions
         WHERE assembly_id = ? AND category_id IS NULL
           AND kind IN ('contribution', 'expense')
           AND occurred_on BETWEEN ? AND ?) AS uncategorised,
       (SELECT COUNT(*) FROM transactions t
         WHERE t.assembly_id = ? AND t.kind = 'expense'
           AND t.occurred_on BETWEEN ? AND ?
           AND NOT EXISTS (SELECT 1 FROM attachments a
                            WHERE a.transaction_id = t.id AND a.kind = 'receipt_image')) AS no_image,
       (SELECT COUNT(*) FROM contributions c
          JOIN transactions t ON t.id = c.transaction_id
         WHERE c.assembly_id = ? AND c.receipt_id IS NULL
           AND t.occurred_on BETWEEN ? AND ?) AS no_receipt,
       (SELECT 19 - COUNT(*) FROM reports
         WHERE assembly_id = ? AND bahai_year = ? AND status = 'presented') AS unpresented`,
    [
      assemblyId, from, to,
      assemblyId, from, to,
      assemblyId, from, to,
      assemblyId, bahaiYear,
    ],
  )

  // Bank rows never matched to a statement. Counted over the whole year rather
  // than to the last statement date: for an audit the question is what has
  // never been proved, not what is merely in flight this month.
  const unreconciled = await db.get<{ n: number; cents: number }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(t.amount_cents), 0) AS cents
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
      WHERE t.assembly_id = ? AND a.kind = 'bank'
        AND t.occurred_on BETWEEN ? AND ?
        AND NOT EXISTS (SELECT 1 FROM reconciliation_items i
                         WHERE i.transaction_id = t.id)`,
    [assemblyId, from, to],
  )

  return [
    ...(position.unexplainedCents !== 0
      ? [
          {
            key: 'opening-unexplained',
            count: 1,
            label:
              position.unexplainedCents > 0
                ? `${money(position.unexplainedCents)} was on hand when the books opened and no fund claims it`
                : `the funds claim ${money(-position.unexplainedCents)} more than the Assembly holds`,
            consequence:
              position.unexplainedCents > 0
                ? 'The books balance and the money is real, but nobody has established whose ' +
                  'it is. Until the Assembly decides, it is deliberately kept out of the ' +
                  'Local Fund rather than counted as money available to spend.'
                : 'Money earmarked for another institution appears to have been spent on ' +
                  'something else before these books opened. The shortfall is carried openly ' +
                  'rather than netted away, and the amount is the size of what is missing.',
          },
        ]
      : []),
    ...(broken.length > 0
      ? [
          {
            key: 'opening-checkpoint',
            count: broken.length,
            label:
              broken.length === 1
                ? `the books no longer reproduce the ${money(broken[0].expectedCents)} they held on ${broken[0].asOf}`
                : 'restated opening figures no longer reproduce what the books once held',
            consequence:
              'The opening date was moved backwards and history loaded in behind it. That ' +
              'history does not add up to the figure the Assembly had already accepted for ' +
              'the old opening date, so transactions in between are missing or duplicated. ' +
              'The difference is the size of the error.',
          },
        ]
      : []),
    {
      key: 'uncategorised',
      count: row?.uncategorised ?? 0,
      label: 'transactions carry no category',
      consequence:
        'They are in the totals but against no line, so the category summaries ' +
        'understate by that much.',
    },
    {
      key: 'no-image',
      count: row?.no_image ?? 0,
      label: 'expenses have no receipt image on file',
      consequence:
        'The payment is recorded and attributed; the supporting document is not ' +
        'attached and would have to be produced separately.',
    },
    {
      key: 'no-receipt',
      count: row?.no_receipt ?? 0,
      label: 'contributions have no receipt issued',
      consequence:
        'The gift is recorded in full; the donor has not been sent an acknowledgement.',
    },
    {
      key: 'unreconciled',
      count: unreconciled?.n ?? 0,
      label: 'bank transactions have never appeared on a reconciled statement',
      consequence:
        `Worth ${money(Math.abs(unreconciled?.cents ?? 0))} in total. Until a statement ` +
        'covering them is balanced, the ledger is unproved against the bank for those rows.',
    },
    {
      key: 'unpresented',
      count: Math.max(0, row?.unpresented ?? 19),
      label: 'of the nineteen Feast reports have not been presented',
      consequence:
        'Months still open, or closed but not yet read out to the community. ' +
        'A month still to come is the ordinary reason.',
    },
  ]
}

/** Money inside prose. The UI formats its own with Intl. */
function money(cents: Cents): string {
  const sign = cents < 0 ? '−' : ''
  const abs = Math.abs(cents)
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`
}
