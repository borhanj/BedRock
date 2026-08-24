/**
 * Naw-Rúz — the first day of each Bahá'í year — as Gregorian dates.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  DO NOT COMPUTE THESE. DO NOT EXTRAPOLATE PAST THE END OF THE TABLE.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * From 172 B.E. (2015) the Badí calendar is astronomical: Naw-Rúz falls on the
 * day of the vernal equinox as observed in Tehran. Because the Bahá'í day
 * begins at sunset, an equinox that lands after sunset in Tehran pushes
 * Naw-Rúz to the following Gregorian date. 2018, 2022 and 2026 are all near
 * that boundary.
 *
 * There is no closed-form rule. The authority is "Bahá'í Dates 172 to 221
 * B.E.", prepared at the Bahá'í World Centre from data supplied by HM
 * Nautical Almanac Office, covering 172–221 B.E. (2015–2064). Everything else
 * in this module — month boundaries, Feast dates, the length of Ayyám-i-Há,
 * the fiscal year — is derived from these entries, so an error here is an
 * error everywhere.
 *
 * PROVENANCE
 * ----------
 * These dates were transcribed from public reproductions of that table, not
 * machine-read from the World Centre document itself. What was checked:
 *
 *   - A full 172–221 B.E. listing (reciteye.com/bahai_dates).
 *   - Wikipedia's Bahá'í calendar table for 2024–2031, which agrees on all
 *     eight years, including the 21 March starts in 2026, 2027 and 2031.
 *   - bahaidailycalendar.com, which agrees that 183 B.E. runs from
 *     21 March 2026 to 20 March 2027.
 *   - The structural invariant below: every one of the 49 closable years
 *     yields an Ayyám-i-Há of 4 or 5 days (37 fours, 12 fives). A mistyped
 *     date almost always produces a 3 or a 6, so this catches most slips.
 *
 * `verified: true` therefore means "agreed by more than one independent
 * published source", NOT "read from the World Centre PDF". The years beyond
 * the range those cross-checks covered are marked false: they are almost
 * certainly right and they work, but they rest on a single listing.
 *
 * TO FINISH THE JOB: open the official document, read down the Naw-Rúz
 * column, and flip the remaining flags. Nothing else needs to change.
 */

export interface NawRuzEntry {
  /** Bahá'í year (B.E.) */
  readonly year: number
  /** Gregorian date of Naw-Rúz, ISO yyyy-mm-dd, in local civil terms. */
  readonly date: string
  /** True when more than one independent published source agrees. */
  readonly verified: boolean
}

export const NAW_RUZ_TABLE: readonly NawRuzEntry[] = [
  // ── corroborated by two or more independent sources ──────────────────────
  { year: 172, date: '2015-03-21', verified: true },
  { year: 173, date: '2016-03-20', verified: true },
  { year: 174, date: '2017-03-20', verified: true },
  { year: 175, date: '2018-03-21', verified: true },
  { year: 176, date: '2019-03-21', verified: true },
  { year: 177, date: '2020-03-20', verified: true },
  { year: 178, date: '2021-03-20', verified: true },
  { year: 179, date: '2022-03-21', verified: true },
  { year: 180, date: '2023-03-21', verified: true },
  { year: 181, date: '2024-03-20', verified: true },
  { year: 182, date: '2025-03-20', verified: true },
  { year: 183, date: '2026-03-21', verified: true },
  { year: 184, date: '2027-03-21', verified: true },
  { year: 185, date: '2028-03-20', verified: true },
  { year: 186, date: '2029-03-20', verified: true },
  { year: 187, date: '2030-03-20', verified: true },
  { year: 188, date: '2031-03-21', verified: true },
  { year: 189, date: '2032-03-20', verified: true },
  { year: 190, date: '2033-03-20', verified: true },

  // ── single published listing, plus the structural invariant ──────────────
  { year: 191, date: '2034-03-20', verified: false },
  { year: 192, date: '2035-03-21', verified: false },
  { year: 193, date: '2036-03-20', verified: false },
  { year: 194, date: '2037-03-20', verified: false },
  { year: 195, date: '2038-03-20', verified: false },
  { year: 196, date: '2039-03-21', verified: false },
  { year: 197, date: '2040-03-20', verified: false },
  { year: 198, date: '2041-03-20', verified: false },
  { year: 199, date: '2042-03-20', verified: false },
  { year: 200, date: '2043-03-21', verified: false },
  { year: 201, date: '2044-03-20', verified: false },
  { year: 202, date: '2045-03-20', verified: false },
  { year: 203, date: '2046-03-20', verified: false },
  { year: 204, date: '2047-03-21', verified: false },
  { year: 205, date: '2048-03-20', verified: false },
  { year: 206, date: '2049-03-20', verified: false },
  { year: 207, date: '2050-03-20', verified: false },
  { year: 208, date: '2051-03-21', verified: false },
  { year: 209, date: '2052-03-20', verified: false },
  { year: 210, date: '2053-03-20', verified: false },
  { year: 211, date: '2054-03-20', verified: false },
  { year: 212, date: '2055-03-21', verified: false },
  { year: 213, date: '2056-03-20', verified: false },
  { year: 214, date: '2057-03-20', verified: false },
  { year: 215, date: '2058-03-20', verified: false },
  { year: 216, date: '2059-03-20', verified: false },
  { year: 217, date: '2060-03-20', verified: false },
  { year: 218, date: '2061-03-20', verified: false },
  { year: 219, date: '2062-03-20', verified: false },
  { year: 220, date: '2063-03-20', verified: false },
  { year: 221, date: '2064-03-20', verified: false },
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

/** Years in the given inclusive range that rest on a single source. */
export function unverifiedYearsIn(from: number, to: number): number[] {
  return NAW_RUZ_TABLE.filter((e) => !e.verified && e.year >= from && e.year <= to).map(
    (e) => e.year,
  )
}

/** True when every entry in the whole table is corroborated. */
export function isTableVerified(): boolean {
  return NAW_RUZ_TABLE.every((e) => e.verified)
}

/**
 * Guard for anything that produces a document an Assembly will rely on.
 *
 * Scoped to the years the document actually covers. A whole-table check would
 * block a report for 183 B.E. because 2064 has not been double-checked, which
 * helps nobody — the question is only ever whether the dates THIS report
 * depends on are sound.
 */
export function assertVerifiedYears(from: number, to: number): void {
  const pending = unverifiedYearsIn(from, to)
  if (pending.length > 0) {
    throw new Error(
      `Naw-Rúz dates for ${pending.join(', ')} B.E. rest on a single published ` +
        `source and have not been reconciled against the official table. ` +
        `Check them in naw-ruz-table.ts and set verified: true before exporting ` +
        `audit documents for those years.`,
    )
  }
}
