/**
 * Browser-side access to the Worker.
 *
 * Deliberately thin: no cache, no client-side derivation of anything the
 * server already computed. Every figure the treasurer reads was calculated in
 * one place, against the database, so there is no second arithmetic path that
 * could disagree with the audit trail.
 */

import type { ApiError, ReportView, YearSummaryView, YearView } from '../shared/types'
import type { ImportPreview } from '../server/repo/import'
import type {
  CashJournal,
  CategoryView,
  FundView,
  AccountView,
  LedgerRow,
} from '../server/repo/ledger'
import type { ColumnMapping } from '../server/import/mapping'
import type { RuleView } from '../server/repo/rules'
import type {
  ReceiptView,
  ReceiptLogSummary,
  UnreceiptedGift,
} from '../server/repo/receipts'
import type { AccessLogEntry, DonorView, VaultStatus } from '../server/repo/donors'
import type {
  FundLedgerView,
  FundsView,
  RemittanceView,
} from '../server/repo/funds'
import type { BudgetLineView, BudgetView } from '../server/repo/budget'
import type {
  ReconcileItemView,
  ReconciliationSummary,
  ReconciliationView,
} from '../server/repo/reconcile'
import type {
  AuditCheck,
  AuditGap,
  AuditPackageView,
} from '../server/repo/audit'
import type { HandoffStep, HandoffView } from '../server/repo/handoff'
import type {
  CheckpointView,
  OpeningPosition,
  ResolveRequest,
  RestateRequest,
  RestateResult,
} from '../server/repo/opening'
import type { SetupRequest, SetupResult } from '../server/repo/setup'
import type { ResetResult, SettingsView } from '../server/repo/settings'
import type { BundleReport, RestoreResult } from '../server/repo/restore'

export type {
  SettingsView,
  ResetResult,
  OpeningPosition,
  CheckpointView,
  RestateRequest,
  RestateResult,
  SetupRequest,
  SetupResult,
  AuditPackageView,
  AuditCheck,
  AuditGap,
  HandoffView,
  HandoffStep,
  BundleReport,
  RestoreResult,
  ReconciliationView,
  ReconciliationSummary,
  ReconcileItemView,
  FundsView,
  FundLedgerView,
  RemittanceView,
  BudgetView,
  BudgetLineView,
  ReceiptView,
  ReceiptLogSummary,
  UnreceiptedGift,
  DonorView,
  VaultStatus,
  AccessLogEntry,
  ImportPreview,
  CashJournal,
  LedgerRow,
  CategoryView,
  FundView,
  AccountView,
  ColumnMapping,
  RuleView,
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiRequestError'
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`
    try {
      const body = (await response.json()) as ApiError
      if (body?.error) message = body.error
    } catch {
      // Non-JSON error body; the status line is all we have.
    }
    throw new ApiRequestError(message, response.status)
  }
  return (await response.json()) as T
}

const post = <T>(path: string, body: unknown) =>
  call<T>(path, { method: 'POST', body: JSON.stringify(body) })

// ── reading ──────────────────────────────────────────────────────────────────

/** The Baháʼí year containing the server's today. */
export const fetchCurrentYear = () => call<YearView>('/api/year/current')

export const fetchYear = (bahaiYear: number) => call<YearView>(`/api/year/${bahaiYear}`)

export const fetchReport = (bahaiYear: number, monthNumber: number) =>
  call<ReportView>(`/api/report/${bahaiYear}/${monthNumber}`)

export const fetchYearSummary = (bahaiYear: number | 'current' = 'current') =>
  call<YearSummaryView>(`/api/summary/${bahaiYear}`)

export interface LedgerQuery {
  year?: number | 'current'
  month?: number
  account?: string
  uncategorisedOnly?: boolean
  search?: string
}

export function fetchLedger(query: LedgerQuery = {}): Promise<LedgerRow[]> {
  const params = new URLSearchParams()
  if (query.year !== undefined) params.set('year', String(query.year))
  if (query.month !== undefined) params.set('month', String(query.month))
  if (query.account) params.set('account', query.account)
  if (query.uncategorisedOnly) params.set('uncategorised', '1')
  if (query.search) params.set('search', query.search)
  return call<LedgerRow[]>(`/api/ledger?${params}`)
}

export const fetchCashJournal = (year: number | 'current' = 'current') =>
  call<CashJournal>(`/api/cash/${year}`)

/** Everything an auditor asks for, drawn against the database on request. */
export const fetchAuditPackage = (year: number | 'current' = 'current') =>
  call<AuditPackageView>(`/api/audit/${year}`)

export const fetchHandoff = (year: number | 'current' = 'current') =>
  call<HandoffView>(`/api/handoff/${year}`)

/** A dry run. Writes nothing, so a file can be examined before anything is decided. */
export const inspectBundle = (bundle: unknown) =>
  post<BundleReport>('/api/handoff/inspect', bundle)

export const restoreBundle = (bundle: unknown) =>
  post<RestoreResult>('/api/handoff/restore', bundle)

/**
 * The whole book as one file, saved to disk.
 *
 * Fetched rather than linked so a failure surfaces as an error the treasurer
 * can read, instead of a browser tab that quietly shows JSON.
 */
export async function downloadHandoffExport(): Promise<string> {
  const response = await fetch('/api/handoff/export', {
    headers: { accept: 'application/json' },
  })
  if (!response.ok) {
    throw new ApiRequestError(
      `The export could not be produced (${response.status}).`,
      response.status,
    )
  }

  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const name =
    /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ??
    'bedrock-export.json'

  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Revoked on the next tick: doing it synchronously can beat the download.
  setTimeout(() => URL.revokeObjectURL(url), 0)
  return name
}

// ── bank reconciliation ──────────────────────────────────────────────────────

export const fetchReconciliations = () =>
  call<ReconciliationSummary[]>('/api/reconcile')

export const fetchReconciliation = (id: string) =>
  call<ReconciliationView>(`/api/reconcile/${encodeURIComponent(id)}`)

export const startReconciliation = (body: {
  accountId: string
  statementEndedOn: string
  statementBalanceCents: number
}) => post<ReconciliationView>('/api/reconcile', body)

export const setCleared = (id: string, transactionId: string, cleared: boolean) =>
  post<ReconciliationView>(`/api/reconcile/${encodeURIComponent(id)}/cleared`, {
    transactionId,
    cleared,
  })

export const setStatement = (
  id: string,
  statementEndedOn: string,
  statementBalanceCents: number,
) =>
  post<ReconciliationView>(`/api/reconcile/${encodeURIComponent(id)}/statement`, {
    statementEndedOn,
    statementBalanceCents,
  })

/** Only ever succeeds at a difference of exactly zero. */
export const completeReconciliation = (id: string) =>
  post<ReconciliationView>(`/api/reconcile/${encodeURIComponent(id)}/complete`, {})

export const reopenReconciliation = (id: string) =>
  post<ReconciliationView>(`/api/reconcile/${encodeURIComponent(id)}/reopen`, {})

/** "next" is resolved by the server, which owns the Naw-Rúz table. */
export type BudgetYear = number | 'current' | 'next'

export const fetchBudget = (year: BudgetYear = 'current') =>
  call<BudgetView>(`/api/budget/${year}`)

/** null clears the line; 0 records a decision to spend nothing. */
export const setBudgetLine = (
  year: BudgetYear,
  body: { categoryId: string; amountCents: number | null; note: string | null },
) => call<BudgetView>(`/api/budget/${year}/line`, {
  method: 'PUT',
  body: JSON.stringify(body),
})

/** Draft a year's figures from another year's actuals, for the Assembly to weigh. */
export const proposeBudget = (year: BudgetYear, fromYear?: number) =>
  post<BudgetView>(`/api/budget/${year}/propose`, { fromYear })

export const approveBudget = (year: BudgetYear, note: string | null) =>
  post<BudgetView>(`/api/budget/${year}/approve`, { note })

export const reopenBudget = (year: BudgetYear) =>
  post<BudgetView>(`/api/budget/${year}/reopen`, {})

export const fetchFunds = (year: number | 'current' = 'current') =>
  call<FundsView>(`/api/funds/${year}`)

export const fetchFundLedger = (fundKey: string, year: number | 'current' = 'current') =>
  call<FundLedgerView>(`/api/funds/${year}/${encodeURIComponent(fundKey)}`)

export interface Choices {
  accounts: AccountView[]
  categories: CategoryView[]
  funds: FundView[]
}

export const fetchChoices = () => call<Choices>('/api/choices')

export const fetchRules = () => call<RuleView[]>('/api/rules')

export interface SetupStatus {
  assemblyId: string
  isSetUp: boolean
  assemblyName: string | null
  openedOn: string | null
  suggestedFunds: ReadonlyArray<{
    key: string
    label: string
    isPassthrough: boolean
    note: string
  }>
  suggestedCategories: ReadonlyArray<{ label: string; kind: 'income' | 'expense' }>
  letterheadMaxBytes: number
}

/**
 * The one call that answers before there are any books.
 *
 * Everything else on this page assumes an Assembly exists. This is how the
 * shell finds out whether one does.
 */
export const fetchSetupStatus = () => call<SetupStatus>('/api/setup')

export interface OpeningView extends OpeningPosition {
  checkpoints: CheckpointView[]
}

export const fetchOpeningPosition = () => call<OpeningView>('/api/opening')

export const fetchSettings = () => call<SettingsView>('/api/settings')

export const forgetRule = (id: string) =>
  call<{ forgotten: boolean }>(`/api/rules/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })

// ── writing ──────────────────────────────────────────────────────────────────

export const openBooks = (body: SetupRequest) => post<SetupResult>('/api/setup', body)

export const resolveOpeningDifference = (body: ResolveRequest) =>
  post<OpeningPosition>('/api/opening/resolve', body)

export const restateOpening = (body: RestateRequest) =>
  post<RestateResult>('/api/opening/restate', body)

const patch = <T>(path: string, body: unknown) =>
  call<T>(path, { method: 'PATCH', body: JSON.stringify(body) })

export const renameAssembly = (name: string, shortName: string) =>
  post<SettingsView>('/api/settings/assembly', { name, shortName })

export const addAccount = (body: {
  name: string
  kind: 'bank' | 'cash'
  openingBalanceCents: number
}) => post<SettingsView>('/api/settings/accounts', body)

export const updateAccount = (id: string, body: { name?: string; isActive?: boolean }) =>
  patch<SettingsView>(`/api/settings/accounts/${encodeURIComponent(id)}`, body)

export const addFund = (body: { key: string; label: string }) =>
  post<SettingsView>('/api/settings/funds', body)

export const renameFund = (id: string, label: string) =>
  patch<SettingsView>(`/api/settings/funds/${encodeURIComponent(id)}`, { label })

export const addCategory = (body: {
  label: string
  kind: 'income' | 'expense'
  fundKey?: string | null
}) => post<SettingsView>('/api/settings/categories', body)

export const updateCategory = (
  id: string,
  body: { label?: string; isArchived?: boolean },
) => patch<SettingsView>(`/api/settings/categories/${encodeURIComponent(id)}`, body)

export const setLetterhead = (dataUrl: string, filename: string | null) =>
  post<SettingsView>('/api/settings/letterhead', { dataUrl, filename })

export const clearLetterhead = () =>
  call<SettingsView>('/api/settings/letterhead', { method: 'DELETE' })

/** Destroys everything. The confirmation is the Assembly's name, checked server-side. */
export const resetEverything = (confirmation: string) =>
  post<ResetResult>('/api/settings/reset', { confirmation })

export const previewImport = (
  accountId: string,
  csvText: string,
  mapping?: ColumnMapping,
) => post<ImportPreview>('/api/import/preview', { accountId, csvText, mapping })

export const commitImport = (body: {
  accountId: string
  csvText: string
  filename: string | null
  mapping: ColumnMapping
  accept: string[]
}) => post<{ batchId: string; imported: number; skipped: number }>(
  '/api/import/commit',
  body,
)

/** Start a draft report for a month, or return the one already there. */
export const startReport = (bahaiYear: number, monthNumber: number) =>
  post<ReportView>(`/api/report/${bahaiYear}/${monthNumber}`, {})

export const setReportCutoff = (
  bahaiYear: number,
  monthNumber: number,
  start: string,
  end: string,
) => post<ReportView>(`/api/report/${bahaiYear}/${monthNumber}/cutoff`, { start, end })

/** Close the books: freeze the figures and lock the period. */
export const finalizeReport = (bahaiYear: number, monthNumber: number) =>
  post<ReportView>(`/api/report/${bahaiYear}/${monthNumber}/finalize`, {})

/** Record that the report was read out at Feast. */
export const presentReport = (bahaiYear: number, monthNumber: number) =>
  post<ReportView>(`/api/report/${bahaiYear}/${monthNumber}/present`, {})

/** Reopen closed books. Deliberate, and audited. */
export const unlockReport = (bahaiYear: number, monthNumber: number) =>
  post<ReportView>(`/api/report/${bahaiYear}/${monthNumber}/unlock`, {})

/**
 * Record money forwarded to another institution's fund.
 *
 * The server writes both the bank withdrawal and the remittance row; there is
 * no way to record one without the other.
 */
export const recordRemittance = (body: {
  fundKey: string
  accountId: string
  sentOn: string
  amountCents: number
  reference: string | null
}) => post<RemittanceView>('/api/remittances', body)

// ── the donor vault ──────────────────────────────────────────────────────────
//
// The PIN is passed in from the caller's session and never cached here.

export const fetchVaultStatus = () => call<VaultStatus>('/api/vault')

export const setupVault = (pin: string) => post<VaultStatus>('/api/vault/setup', { pin })

export const unlockVault = (pin: string) =>
  post<{ unlocked: boolean }>('/api/vault/unlock', { pin })

export const changeVaultPin = (pin: string, newPin: string) =>
  post<{ rekeyed: number }>('/api/vault/pin', { pin, newPin })

/** Readable without the PIN: oversight the overseen cannot inspect is not oversight. */
export const fetchAccessLog = () => call<AccessLogEntry[]>('/api/vault/access-log')

export const listDonors = (pin: string, reason: string) =>
  post<DonorView[]>('/api/donors/list', { pin, reason })

export const createDonor = (pin: string, name: string, contact?: string) =>
  post<{ id: string }>('/api/donors', { pin, name, contact })

export const createAnonymousDonor = () =>
  post<{ id: string }>('/api/donors', { anonymous: true })

// ── receipts ─────────────────────────────────────────────────────────────────

export interface ReceiptBook {
  receipts: ReceiptView[]
  summary: ReceiptLogSummary
  awaiting: UnreceiptedGift[]
}

export const fetchReceipts = () => call<ReceiptBook>('/api/receipts')

/** One receipt and the Assembly's name, enough to print a document. */
export interface ReceiptDocument {
  receipt: ReceiptView
  assemblyName: string
  /** The Assembly's letterhead, if one has been uploaded. */
  letterhead: string | null
}

export const fetchReceipt = (id: string) =>
  call<ReceiptDocument>(`/api/receipts/${encodeURIComponent(id)}`)

export const issueReceipt = (body: {
  contributionId: string
  donorId: string | null
  note: string | null
  issuedOn?: string
}) => post<ReceiptView>('/api/receipts', body)

export const voidReceipt = (id: string, reason: string) =>
  post<ReceiptView>(`/api/receipts/${encodeURIComponent(id)}/void`, { reason })

export const createTransaction = (body: {
  accountId: string
  occurredOn: string
  amountCents: number
  payee: string
  memo: string | null
  method: string
  kind: string
  categoryId: string | null
  fundId: string | null
}) => post<{ id: string }>('/api/transactions', body)

export const setCategory = (
  transactionId: string,
  body: { categoryId: string | null; fundId: string | null; txnKind: string | null },
) =>
  call<{ categorised: boolean }>(
    `/api/transactions/${encodeURIComponent(transactionId)}/category`,
    { method: 'PATCH', body: JSON.stringify(body) },
  )
