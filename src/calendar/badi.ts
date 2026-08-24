/**
 * Badí calendar engine.
 *
 * Every boundary in Bedrock — Feast periods, report cutoffs, the fiscal year —
 * derives from ./naw-ruz-table.ts. Nothing here guesses a date.
 *
 * Dates are handled as civil days (no clock time, no timezone). Internally that
 * is a UTC day index, so arithmetic never crosses a DST seam.
 */

import {
  BADI_MONTHS,
  DAYS_PER_MONTH,
  AYYAM_I_HA_NAME,
  AYYAM_I_HA_SHORT,
} from './months'
import {
  CalendarRangeError,
  FIRST_TABULATED_YEAR,
  LAST_COMPLETE_YEAR,
  nawRuzEntry,
} from './naw-ruz-table'

export { CalendarRangeError }
export type { BadiMonth } from './months'

/** Days occupied by months 1-18, before Ayyám-i-Há begins. */
const DAYS_BEFORE_AYYAM_I_HA = 18 * DAYS_PER_MONTH // 342
/** Months 1-18 plus the final month, ʿAláʼ; the remainder is Ayyám-i-Há. */
const FIXED_DAYS_PER_YEAR = DAYS_BEFORE_AYYAM_I_HA + DAYS_PER_MONTH // 361

// ── civil-day helpers ────────────────────────────────────────────────────────

const MS_PER_DAY = 86_400_000

/** yyyy-mm-dd to UTC day index. */
export function toDayIndex(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) throw new TypeError(`Expected an ISO date (yyyy-mm-dd), received "${iso}"`)
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / MS_PER_DAY
}

/** UTC day index to yyyy-mm-dd. */
export function toISODate(dayIndex: number): string {
  return new Date(dayIndex * MS_PER_DAY).toISOString().slice(0, 10)
}

/** Accepts an ISO string or a Date, discarding any time component. */
export function asDayIndex(value: string | Date): number {
  if (typeof value === 'string') return toDayIndex(value)
  return Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) / MS_PER_DAY
}

// ── periods ──────────────────────────────────────────────────────────────────

export type PeriodKind = 'month' | 'ayyam-i-ha'

export interface BadiPeriod {
  readonly kind: PeriodKind
  /** Bahá'í year (B.E.) */
  readonly year: number
  /** 1-19 for a month; null for Ayyám-i-Há. */
  readonly monthNumber: number | null
  /** Transliterated name, e.g. Kamál, or Ayyám-i-Há. */
  readonly name: string
  /** Compact label for the year chart. */
  readonly shortName: string
  readonly translation: string | null
  /** Inclusive Gregorian bounds, ISO. */
  readonly startDate: string
  readonly endDate: string
  readonly dayCount: number
  /**
   * The Nineteen Day Feast that opens this month, held on its first day.
   * Null for Ayyám-i-Há, which has no Feast.
   */
  readonly feastDate: string | null
}

/** Naw-Rúz for a Bahá'í year, as an ISO date. */
export function nawRuz(year: number): string {
  return nawRuzEntry(year).date
}

/**
 * Length of the Bahá'í year in days — the gap between consecutive Naw-Rúz
 * dates. Requires the FOLLOWING year to be tabulated.
 */
export function yearLength(year: number): number {
  if (year > LAST_COMPLETE_YEAR) {
    throw new CalendarRangeError(
      `${year} B.E. cannot be closed: the length of Ayyám-i-Há depends on ` +
        `Naw-Rúz ${year + 1}, which is not in the table. Complete years run ` +
        `${FIRST_TABULATED_YEAR}-${LAST_COMPLETE_YEAR} B.E.`,
    )
  }
  return toDayIndex(nawRuz(year + 1)) - toDayIndex(nawRuz(year))
}

/**
 * Days in Ayyám-i-Há for a given year — 4 or 5, never anything else.
 * A different result means the underlying table is wrong, so we refuse it.
 */
export function ayyamIHaLength(year: number): number {
  const length = yearLength(year) - FIXED_DAYS_PER_YEAR
  if (length !== 4 && length !== 5) {
    throw new Error(
      `Ayyám-i-Há for ${year} B.E. computed to ${length} days, which is ` +
        `impossible (it is always 4 or 5). Naw-Rúz ${year} or ${year + 1} is ` +
        `wrong in naw-ruz-table.ts.`,
    )
  }
  return length
}

/**
 * Every period of a Bahá'í year in calendar order: months 1-18, Ayyám-i-Há,
 * then month 19 (ʿAláʼ, the month of the Fast).
 */
export function monthsForYear(year: number): BadiPeriod[] {
  const start = toDayIndex(nawRuz(year))
  const intercalary = ayyamIHaLength(year)
  const periods: BadiPeriod[] = []

  const pushMonth = (month: (typeof BADI_MONTHS)[number], offset: number) => {
    const from = start + offset
    periods.push({
      kind: 'month',
      year,
      monthNumber: month.number,
      name: month.name,
      shortName: month.name,
      translation: month.translation,
      startDate: toISODate(from),
      endDate: toISODate(from + DAYS_PER_MONTH - 1),
      dayCount: DAYS_PER_MONTH,
      // The Feast opens the month, so it falls on the month's first day.
      feastDate: toISODate(from),
    })
  }

  for (let i = 0; i < 18; i++) pushMonth(BADI_MONTHS[i], i * DAYS_PER_MONTH)

  const ayyamStart = start + DAYS_BEFORE_AYYAM_I_HA
  periods.push({
    kind: 'ayyam-i-ha',
    year,
    monthNumber: null,
    name: AYYAM_I_HA_NAME,
    shortName: AYYAM_I_HA_SHORT,
    translation: 'Days of Há',
    startDate: toISODate(ayyamStart),
    endDate: toISODate(ayyamStart + intercalary - 1),
    dayCount: intercalary,
    feastDate: null,
  })

  pushMonth(BADI_MONTHS[18], DAYS_BEFORE_AYYAM_I_HA + intercalary)

  return periods
}

/** The Bahá'í year containing a given Gregorian date. */
export function bahaiYear(date: string | Date): number {
  const day = asDayIndex(date)
  for (let year = FIRST_TABULATED_YEAR; year <= LAST_COMPLETE_YEAR; year++) {
    const from = toDayIndex(nawRuz(year))
    const to = toDayIndex(nawRuz(year + 1))
    if (day >= from && day < to) return year
  }
  throw new CalendarRangeError(
    `${toISODate(day)} falls outside the tabulated range (Naw-Rúz ` +
      `${FIRST_TABULATED_YEAR} to Naw-Rúz ${LAST_COMPLETE_YEAR + 1} B.E.). ` +
      `Extend naw-ruz-table.ts.`,
  )
}

/** The period — month or Ayyám-i-Há — containing a given Gregorian date. */
export function periodFor(date: string | Date): BadiPeriod {
  const day = asDayIndex(date)
  const found = monthsForYear(bahaiYear(date)).find(
    (p) => day >= toDayIndex(p.startDate) && day <= toDayIndex(p.endDate),
  )
  // bahaiYear() already proved the date is inside the year, and the periods
  // tile the year exactly, so this is unreachable unless the table is corrupt.
  if (!found) throw new Error(`No period contains ${toISODate(day)} — table is inconsistent.`)
  return found
}

/** Date of the Nineteen Day Feast that opens a given month. */
export function feastDate(year: number, monthNumber: number): string {
  if (!Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 19) {
    throw new RangeError(`Month must be 1-19, received ${monthNumber}`)
  }
  const period = monthsForYear(year).find((p) => p.monthNumber === monthNumber)
  return period!.feastDate!
}

/** The next Feast strictly after a given date, rolling into the next year if needed. */
export function nextFeastAfter(date: string | Date): BadiPeriod {
  const day = asDayIndex(date)
  const year = bahaiYear(date)
  const upcoming = monthsForYear(year).find(
    (p) => p.feastDate !== null && toDayIndex(p.feastDate) > day,
  )
  if (upcoming) return upcoming
  // Past the Feast of ʿAláʼ — the next one opens the following year.
  return monthsForYear(year + 1)[0]
}

// ── formatting ───────────────────────────────────────────────────────────────

/** "Month of Kamál, 183 B.E." — the canonical report title. */
export function formatPeriod(period: BadiPeriod): string {
  if (period.kind === 'ayyam-i-ha') return `${AYYAM_I_HA_NAME}, ${period.year} B.E.`
  return `Month of ${period.name}, ${period.year} B.E.`
}

/** "Feast of ʿIzzat" — Ayyám-i-Há has no Feast and returns null. */
export function formatFeast(period: BadiPeriod): string | null {
  if (period.kind === 'ayyam-i-ha') return null
  return `Feast of ${period.name}`
}

const LONG_DATE = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
})

const RANGE_DATE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
})

/** "Tuesday 8 September 2026" */
export function formatLongDate(iso: string): string {
  return LONG_DATE.format(new Date(toDayIndex(iso) * MS_PER_DAY)).replace(',', '')
}

/** "1 - 19 August 2026", collapsing the month name when both ends share it. */
export function formatDateRange(startISO: string, endISO: string): string {
  const start = new Date(toDayIndex(startISO) * MS_PER_DAY)
  const end = new Date(toDayIndex(endISO) * MS_PER_DAY)
  const endLabel = `${RANGE_DATE.format(end)} ${end.getUTCFullYear()}`
  if (
    start.getUTCMonth() === end.getUTCMonth() &&
    start.getUTCFullYear() === end.getUTCFullYear()
  ) {
    return `${start.getUTCDate()} – ${endLabel}`
  }
  const startLabel =
    start.getUTCFullYear() === end.getUTCFullYear()
      ? RANGE_DATE.format(start)
      : `${RANGE_DATE.format(start)} ${start.getUTCFullYear()}`
  return `${startLabel} – ${endLabel}`
}
