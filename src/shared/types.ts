/**
 * The contract between the Worker and the browser.
 *
 * Imported by both sides, so a change to a view model breaks the type-check on
 * whichever end has not kept up. All money is integer cents; all dates are ISO
 * yyyy-mm-dd civil dates.
 */

export type MonthStatus = 'closed' | 'ready' | 'current' | 'future'
export type ReportStatus = 'draft' | 'ready' | 'presented'

export interface MonthActivityView {
  readonly monthNumber: number
  readonly status: MonthStatus
  readonly contributionsCents: number
  readonly expensesCents: number
  readonly remittedCents: number
}

export interface FundBalanceView {
  readonly key: string
  readonly label: string
  readonly balanceCents: number
  /** Held for another institution and owed upward. */
  readonly isPassthrough: boolean
  /**
   * Money on hand at opening that no fund claimed, and that nobody has yet
   * decided about. Present only when there is some — an Assembly whose books
   * opened clean never sees this row. It is carried separately rather than
   * folded into the Local Fund, which is what would otherwise happen, because
   * the Local Fund is the residual of this partition and would absorb it
   * without saying so.
   */
  readonly isUnexplained?: boolean
}

export interface AttentionView {
  readonly key: string
  readonly count: number
  readonly label: string
  /** Shown in the settled tone when count is zero. */
  readonly resolvedLabel?: string
  /** Where clicking the row takes the treasurer to deal with it. */
  readonly href: string
  /**
   * 'unknown' — the check behind this row has never run, so its count is not
   * a finding. A zero here would be a claim the database cannot support, and
   * reads in neither the settled tone nor the amber one.
   */
  readonly tone?: 'unknown'
}

export interface AssemblyView {
  readonly name: string
  readonly shortName: string
  readonly treasurerInitials: string
}

export interface YearView {
  readonly bahaiYear: number
  readonly today: string
  readonly assembly: AssemblyView
  readonly openingBalanceCents: number
  readonly receivedToDateCents: number
  readonly paidToDateCents: number
  readonly remittedToDateCents: number
  readonly onHandTodayCents: number
  readonly months: readonly MonthActivityView[]
  readonly funds: readonly FundBalanceView[]
  readonly attention: readonly AttentionView[]
}

export interface ReportLineView {
  readonly label: string
  readonly amountCents: number
}

export interface ReportView {
  readonly bahaiYear: number
  readonly monthNumber: number
  /** The reporting window, which may differ from the calendar month. */
  readonly cutoffStart: string
  readonly cutoffEnd: string
  /** The calendar bounds of the month, for showing how far the cutoff moved. */
  readonly calendarStart: string
  readonly calendarEnd: string
  readonly status: ReportStatus
  /** The Feast at which this is presented — the following month. */
  readonly presentedAtMonth: number | null
  readonly openingCents: number
  readonly income: readonly ReportLineView[]
  readonly expenses: readonly ReportLineView[]
  readonly remittedCents: number
  readonly closingBreakdown: readonly ReportLineView[]
  readonly closingCents: number
  readonly contributionCount: number
  readonly householdCount: number
  readonly finalizedAt: string | null
  readonly presentedAt: string | null
  /** Transactions inside the cutoff are locked while the report is closed. */
  readonly locked: boolean
  /**
   * Set when the frozen figures no longer match a live recomputation.
   *
   * A finalised report is a statement already made, so it keeps showing what
   * it said. But if a prior-period correction has since moved the numbers, the
   * treasurer needs to know — silently serving stale figures, or silently
   * updating a presented report, are both worse than saying so.
   */
  readonly drift: ReportDrift | null
}

export interface ReportDrift {
  readonly liveOpeningCents: number
  readonly liveClosingCents: number
  readonly liveIncomeCents: number
  readonly liveExpensesCents: number
}

export interface YearMonthSummary {
  readonly monthNumber: number
  readonly name: string
  readonly contributionsCents: number
  readonly expensesCents: number
  readonly remittedCents: number
  readonly closingCents: number
  readonly status: ReportStatus | 'none'
}

export interface YearSummaryView {
  readonly bahaiYear: number
  readonly nawRuz: string
  readonly yearEnd: string
  readonly assembly: AssemblyView
  readonly openingCents: number
  readonly closingCents: number
  readonly incomeByFund: readonly ReportLineView[]
  readonly expensesByCategory: readonly ReportLineView[]
  readonly remittancesByFund: readonly ReportLineView[]
  readonly months: readonly YearMonthSummary[]
  readonly contributionCount: number
  readonly householdCount: number
  readonly reportsPresented: number
  readonly closingBreakdown: readonly ReportLineView[]
}

export interface ApiError {
  readonly error: string
}
