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

export type {
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

export interface Choices {
  accounts: AccountView[]
  categories: CategoryView[]
  funds: FundView[]
}

export const fetchChoices = () => call<Choices>('/api/choices')

export const fetchRules = () => call<RuleView[]>('/api/rules')

export const forgetRule = (id: string) =>
  call<{ forgotten: boolean }>(`/api/rules/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })

// ── writing ──────────────────────────────────────────────────────────────────

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
