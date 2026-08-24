/**
 * Turning a bank's columns into transactions.
 *
 * The dangerous part is the date. 03/04/2026 is 3 April to a British bank and
 * 4 March to an American one, and nothing in the file says which. Getting it
 * wrong moves transactions between Feast periods and silently changes what a
 * report says. So the format is never assumed: it is detected from the data
 * where the data can prove it, and reported as AMBIGUOUS where it cannot, for
 * the treasurer to resolve.
 */

import { parseMoney, type Cents } from '../../lib/money'

export type DateFormat = 'ymd' | 'mdy' | 'dmy'

export type AmountMapping =
  /** One signed column: negatives are money out. */
  | { readonly kind: 'single'; readonly column: number; readonly flipSign?: boolean }
  /** Separate columns, both holding positive magnitudes. */
  | { readonly kind: 'debit-credit'; readonly debit: number; readonly credit: number }

export interface ColumnMapping {
  readonly date: number
  readonly dateFormat: DateFormat
  readonly description: number
  readonly amount: AmountMapping
  readonly memo?: number
}

export interface MappedRow {
  /** 1-based row number in the file, for error messages. */
  readonly line: number
  readonly occurredOn: string
  readonly description: string
  readonly memo: string | null
  readonly amountCents: Cents
}

export interface RowProblem {
  readonly line: number
  readonly reason: string
  readonly cells: readonly string[]
}

export interface MappingResult {
  readonly rows: readonly MappedRow[]
  readonly problems: readonly RowProblem[]
}

// ── dates ────────────────────────────────────────────────────────────────────

const SEPARATED = /^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})$/

export type DateDetection =
  | { readonly kind: 'detected'; readonly format: DateFormat; readonly reason: string }
  /** Both day-first and month-first parse cleanly; only a human can choose. */
  | { readonly kind: 'ambiguous'; readonly candidates: readonly DateFormat[] }
  | { readonly kind: 'unrecognised' }

/**
 * Work out the date format from a column of samples.
 *
 * A value with a first part above 12 can only be a day; a second part above 12
 * can only be a month. When every sample is 12-or-under in both positions the
 * file genuinely cannot be disambiguated, and saying so is the only honest
 * answer.
 */
export function detectDateFormat(samples: readonly string[]): DateDetection {
  const parsed = samples
    .map((s) => SEPARATED.exec(s.trim()))
    .filter((m): m is RegExpExecArray => m !== null)

  if (parsed.length === 0) {
    // ISO with a time component, or a written month, still counts as ISO-ish.
    const iso = samples.filter((s) => /^\d{4}-\d{2}-\d{2}/.test(s.trim()))
    if (iso.length > 0) {
      return { kind: 'detected', format: 'ymd', reason: 'ISO dates (yyyy-mm-dd)' }
    }
    return { kind: 'unrecognised' }
  }

  // A four-digit leading part is unambiguously a year.
  if (parsed.every((m) => m[1].length === 4)) {
    return { kind: 'detected', format: 'ymd', reason: 'four-digit year first' }
  }

  const firstOver12 = parsed.find((m) => Number(m[1]) > 12)
  const secondOver12 = parsed.find((m) => Number(m[2]) > 12)

  if (firstOver12 && secondOver12) {
    return { kind: 'unrecognised' }
  }
  if (firstOver12) {
    return {
      kind: 'detected',
      format: 'dmy',
      reason: `"${firstOver12[0]}" has ${firstOver12[1]} first, which can only be a day`,
    }
  }
  if (secondOver12) {
    return {
      kind: 'detected',
      format: 'mdy',
      reason: `"${secondOver12[0]}" has ${secondOver12[2]} second, which can only be a day`,
    }
  }

  // Every sample is 12-or-under on both sides. Unknowable from the file.
  return { kind: 'ambiguous', candidates: ['mdy', 'dmy'] }
}

/** Parse one cell to an ISO civil date, or null if it is not a date. */
export function parseDate(value: string, format: DateFormat): string | null {
  const raw = value.trim()
  if (raw === '') return null

  // ISO with an optional time — take the date part and trust it.
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw)
  if (iso) return validate(Number(iso[1]), Number(iso[2]), Number(iso[3]))

  const m = SEPARATED.exec(raw)
  if (!m) return null

  const a = Number(m[1])
  const b = Number(m[2])
  const c = Number(m[3])

  let year: number
  let month: number
  let day: number
  if (format === 'ymd') {
    ;[year, month, day] = [a, b, c]
  } else if (format === 'mdy') {
    ;[month, day, year] = [a, b, c]
  } else {
    ;[day, month, year] = [a, b, c]
  }

  // Two-digit years: banks do not export statements from the 1930s, so a
  // small number is this century.
  if (year < 100) year += year < 70 ? 2000 : 1900

  return validate(year, month, day)
}

/** Rejects 31 February rather than letting Date roll it into March. */
function validate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null
  }
  return date.toISOString().slice(0, 10)
}

// ── rows ─────────────────────────────────────────────────────────────────────

/** Apply a mapping to the data rows, separating what parsed from what did not. */
export function applyMapping(
  rows: readonly (readonly string[])[],
  mapping: ColumnMapping,
): MappingResult {
  const out: MappedRow[] = []
  const problems: RowProblem[] = []

  rows.forEach((cells, index) => {
    // +2: one for the header, one because humans count from 1.
    const line = index + 2
    const fail = (reason: string) => problems.push({ line, reason, cells })

    const occurredOn = parseDate(cells[mapping.date] ?? '', mapping.dateFormat)
    if (!occurredOn) {
      fail(`Could not read "${cells[mapping.date] ?? ''}" as a date`)
      return
    }

    const amountCents = readAmount(cells, mapping.amount)
    if (amountCents === null) {
      fail('Could not read an amount')
      return
    }
    if (amountCents === 0) {
      // Zero-value rows are usually a bank's own placeholder and carry no
      // money; importing them adds noise to every report.
      fail('Amount is zero')
      return
    }

    const description = (cells[mapping.description] ?? '').trim()
    const memo =
      mapping.memo === undefined ? null : (cells[mapping.memo] ?? '').trim() || null

    out.push({ line, occurredOn, description, memo, amountCents })
  })

  return { rows: out, problems }
}

function readAmount(
  cells: readonly string[],
  mapping: AmountMapping,
): Cents | null {
  if (mapping.kind === 'single') {
    const cents = parseMoney(cells[mapping.column] ?? '')
    if (cents === null) return null
    return mapping.flipSign ? -cents : cents
  }

  // Debit/credit columns: exactly one is normally filled. Both columns carry
  // positive magnitudes, so the sign comes from which column it landed in.
  const debit = parseMoney(cells[mapping.debit] ?? '')
  const credit = parseMoney(cells[mapping.credit] ?? '')
  if (debit === null && credit === null) return null
  return (credit ?? 0) - Math.abs(debit ?? 0)
}

/**
 * A first guess at the mapping, from the header names. The treasurer confirms
 * or corrects it — this only saves clicks, it never decides anything.
 */
export function guessMapping(
  header: readonly string[],
  sampleRows: readonly (readonly string[])[],
): { mapping: ColumnMapping | null; dateDetection: DateDetection } {
  const find = (...needles: string[]) =>
    header.findIndex((h) => {
      const name = h.toLowerCase()
      return needles.some((n) => name.includes(n))
    })

  const date = find('date', 'posted', 'transaction date')
  const description = find('description', 'payee', 'name', 'memo', 'details', 'narrative')
  const single = find('amount', 'value')
  const debit = find('debit', 'withdrawal', 'paid out', 'money out')
  const credit = find('credit', 'deposit', 'paid in', 'money in')

  const dateSamples = date >= 0 ? sampleRows.map((r) => r[date] ?? '') : []
  const dateDetection = detectDateFormat(dateSamples)

  if (date < 0 || description < 0) return { mapping: null, dateDetection }

  const amount: AmountMapping | null =
    debit >= 0 && credit >= 0
      ? { kind: 'debit-credit', debit, credit }
      : single >= 0
        ? { kind: 'single', column: single }
        : null
  if (!amount) return { mapping: null, dateDetection }

  return {
    mapping: {
      date,
      // Falls back to ISO; the caller must surface an ambiguous detection
      // rather than let this default stand unexamined.
      dateFormat: dateDetection.kind === 'detected' ? dateDetection.format : 'ymd',
      description,
      amount,
    },
    dateDetection,
  }
}
