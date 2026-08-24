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
}

export interface AttentionView {
  readonly key: string
  readonly count: number
  readonly label: string
  /** Shown in the settled tone when count is zero. */
  readonly resolvedLabel?: string
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
  readonly status: ReportStatus
  /** The Feast at which this is presented — the following month. */
  readonly presentedAtMonth: number | null
  readonly openingCents: number
  readonly income: readonly ReportLineView[]
  readonly expenses: readonly ReportLineView[]
  readonly remittedCents: number
  readonly closingBreakdown: readonly ReportLineView[]
  readonly contributionCount: number
  readonly householdCount: number
}

export interface ApiError {
  readonly error: string
}
