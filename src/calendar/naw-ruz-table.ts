/**
 * Naw-Rúz — the first day of each Bahá'í year — as Gregorian dates.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  DO NOT COMPUTE THESE. DO NOT EXTRAPOLATE PAST THE END OF THE TABLE.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * From 172 B.E. (2015) the Badí' calendar is astronomical: Naw-Rúz falls on the
 * day of the vernal equinox as observed in Tehran. Because the Bahá'í day begins
 * at sunset, an equinox that lands after sunset in Tehran pushes Naw-Rúz to the
 * following Gregorian date. 2018, 2022 and 2026 are all near that boundary.
 *
 * There is no closed-form rule. The dates are published by the Universal House
 * of Justice in a table extending to 221 B.E. Everything else in this module —
 * month boundaries, Feast dates, the length of Ayyám-i-Há, the fiscal year — is
 * derived from these entries, so an error here is an error everywhere.
 *
 * PROVENANCE
 * ----------
 * The entries below are marked `verified: false`. They agree with the commonly
 * published dates and are internally consistent (see the cross-check note on
 * 183 B.E. below), but they have NOT been reconciled line-by-line against the
 * official published table. Do that before this app keeps anyone's real books,
 * flip the flags, and extend the range to 221 B.E.
 *
 * `assertVerifiedTable()` is called by the audit-package export so an unverified
 * table cannot silently reach a document an Assembly relies on.
 *
 * CROSS-CHECK — 183 B.E.
 * ----------------------
 * 21 March 2026 is corroborated by the design mockup this app implements:
 * with that start, month 8 (Kamál) runs 1–19 August 2026 and the Feast of
 * ʿIzzat falls on Tuesday 8 September 2026 — both exactly as the mockup states.
 * A 20 March start reproduces neither.
 */

export interface NawRuzEntry {
  /** Bahá'í year (B.E.) */
  readonly year: number
  /** Gregorian date of Naw-Rúz, ISO yyyy-mm-dd, in local civil terms. */
  readonly date: string
  /** True once reconciled against the official published table. */
  readonly verified: boolean
}

export const NAW_RUZ_TABLE: readonly NawRuzEntry[] = [
  { year: 172, date: '2015-03-21', verified: false },
  { year: 173, date: '2016-03-20', verified: false },
  { year: 174, date: '2017-03-20', verified: false },
  { year: 175, date: '2018-03-21', verified: false },
  { year: 176, date: '2019-03-21', verified: false },
  { year: 177, date: '2020-03-20', verified: false },
  { year: 178, date: '2021-03-20', verified: false },
  { year: 179, date: '2022-03-21', verified: false },
  { year: 180, date: '2023-03-21', verified: false },
  { year: 181, date: '2024-03-20', verified: false },
  { year: 182, date: '2025-03-20', verified: false },
  { year: 183, date: '2026-03-21', verified: false },
  { year: 184, date: '2027-03-21', verified: false },
  { year: 185, date: '2028-03-20', verified: false },
  { year: 186, date: '2029-03-20', verified: false },
  { year: 187, date: '2030-03-20', verified: false },
  { year: 188, date: '2031-03-21', verified: false },
  { year: 189, date: '2032-03-20', verified: false },
  { year: 190, date: '2033-03-20', verified: false },
] as const

/**
 * A year is usable only if the NEXT year is also tabulated — the length of
 * Ayyám-i-Há is the gap between consecutive Naw-Rúz dates, so the final entry
 * can start a year but cannot close one.
 */
export const FIRST_TABULATED_YEAR = NAW_RUZ_TABLE[0].year
export const LAST_TABULATED_YEAR = NAW_RUZ_TABLE[NAW_RUZ_TABLE.length - 1].year
export const LAST_COMPLETE_YEAR = LAST_TABULATED_YEAR - 1

const BY_YEAR = new Map(NAW_RUZ_TABLE.map((e) => [e.year, e]))

export class CalendarRangeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CalendarRangeError'
  }
}

/** Raw table lookup. Throws rather than guessing. */
export function nawRuzEntry(year: number): NawRuzEntry {
  const entry = BY_YEAR.get(year)
  if (!entry) {
    throw new CalendarRangeError(
      `No Naw-Rúz date on file for ${year} B.E. The table covers ` +
        `${FIRST_TABULATED_YEAR}–${LAST_TABULATED_YEAR} B.E. Extend ` +
        `naw-ruz-table.ts from the official published dates — these cannot be calculated.`,
    )
  }
  return entry
}

/** True when every entry has been reconciled against the official table. */
export function isTableVerified(): boolean {
  return NAW_RUZ_TABLE.every((e) => e.verified)
}

/** Guard for anything that produces a document an Assembly will rely on. */
export function assertVerifiedTable(): void {
  if (!isTableVerified()) {
    const pending = NAW_RUZ_TABLE.filter((e) => !e.verified).map((e) => e.year)
    throw new Error(
      `The Naw-Rúz table has not been verified against the official published ` +
        `dates. Unverified years: ${pending.join(', ')}. Reconcile them and set ` +
        `verified: true in naw-ruz-table.ts before exporting audit documents.`,
    )
  }
}
