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
 * There is no closed-form rule. Everything else in this module — month
 * boundaries, Feast dates, the length of Ayyám-i-Há, the fiscal year — is
 * derived from these entries, so an error here is an error everywhere.
 *
 * PROVENANCE
 * ----------
 * Transcribed from "Badí' dates 172 to 221 BE", prepared by an ad hoc
 * committee at the Bahá'í World Centre using data provided by Her Majesty's
 * Nautical Almanac Office in the United Kingdom, with Tehran taken from the
 * World Geodetic System. Section A, "Dates of Naw-Rúz, the Twin Holy
 * Birthdays, and Ayyám-i-Há".
 *
 * All fifty rows were read from that document and every one matches. Three
 * checks stand behind them:
 *
 *   - The document's own stated Ayyám-i-Há lengths agree with the gaps
 *     between its own Naw-Rúz dates, for all 49 closable years.
 *   - Those stated lengths agree with the lengths this engine derives; see
 *     OFFICIAL_AYYAM_I_HA and the test that uses it.
 *   - Every year yields a legal 4- or 5-day Ayyám-i-Há (38 fours, 12 fives).
 *
 * The table ends at 221 B.E. because the published one does. Past that the
 * engine refuses to guess rather than extrapolating.
 */

export interface NawRuzEntry {
  /** Bahá'í year (B.E.) */
  readonly year: number
  /** Gregorian date of Naw-Rúz, ISO yyyy-mm-dd, in local civil terms. */
  readonly date: string
  /** Reconciled against the official published table. */
  readonly verified: boolean
}

export const NAW_RUZ_TABLE: readonly NawRuzEntry[] = [
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
  { year: 191, date: '2034-03-20', verified: true },
  { year: 192, date: '2035-03-21', verified: true },
  { year: 193, date: '2036-03-20', verified: true },
  { year: 194, date: '2037-03-20', verified: true },
  { year: 195, date: '2038-03-20', verified: true },
  { year: 196, date: '2039-03-21', verified: true },
  { year: 197, date: '2040-03-20', verified: true },
  { year: 198, date: '2041-03-20', verified: true },
  { year: 199, date: '2042-03-20', verified: true },
  { year: 200, date: '2043-03-21', verified: true },
  { year: 201, date: '2044-03-20', verified: true },
  { year: 202, date: '2045-03-20', verified: true },
  { year: 203, date: '2046-03-20', verified: true },
  { year: 204, date: '2047-03-21', verified: true },
  { year: 205, date: '2048-03-20', verified: true },
  { year: 206, date: '2049-03-20', verified: true },
  { year: 207, date: '2050-03-20', verified: true },
  { year: 208, date: '2051-03-21', verified: true },
  { year: 209, date: '2052-03-20', verified: true },
  { year: 210, date: '2053-03-20', verified: true },
  { year: 211, date: '2054-03-20', verified: true },
  { year: 212, date: '2055-03-21', verified: true },
  { year: 213, date: '2056-03-20', verified: true },
  { year: 214, date: '2057-03-20', verified: true },
  { year: 215, date: '2058-03-20', verified: true },
  { year: 216, date: '2059-03-20', verified: true },
  { year: 217, date: '2060-03-20', verified: true },
  { year: 218, date: '2061-03-20', verified: true },
  { year: 219, date: '2062-03-20', verified: true },
  { year: 220, date: '2063-03-20', verified: true },
  { year: 221, date: '2064-03-20', verified: true },
] as const

/**
 * Days of Ayyám-i-Há as the official document states them, kept separately
 * from the dates above.
 *
 * The engine never reads this to do its work — it derives the length from the
 * gap between consecutive Naw-Rúz dates, which is the actual rule. This is
 * here purely so a test can confirm the derivation reproduces what the
 * document says, for all 49 closable years. Two independent statements of the
 * same fact, checked against each other.
 */
export const OFFICIAL_AYYAM_I_HA: Readonly<Record<number, number>> = {
  172: 4,
  173: 4,
  174: 5,
  175: 4,
  176: 4,
  177: 4,
  178: 5,
  179: 4,
  180: 4,
  181: 4,
  182: 5,
  183: 4,
  184: 4,
  185: 4,
  186: 4,
  187: 5,
  188: 4,
  189: 4,
  190: 4,
  191: 5,
  192: 4,
  193: 4,
  194: 4,
  195: 5,
  196: 4,
  197: 4,
  198: 4,
  199: 5,
  200: 4,
  201: 4,
  202: 4,
  203: 5,
  204: 4,
  205: 4,
  206: 4,
  207: 5,
  208: 4,
  209: 4,
  210: 4,
  211: 5,
  212: 4,
  213: 4,
  214: 4,
  215: 4,
  216: 5,
  217: 4,
  218: 4,
  219: 4,
  220: 5,
  221: 4,
}

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

/** Years in the range not yet reconciled against the official table. */
export function unverifiedYearsIn(from: number, to: number): number[] {
  return NAW_RUZ_TABLE.filter((e) => !e.verified && e.year >= from && e.year <= to).map(
    (e) => e.year,
  )
}

/** True when every entry has been read off the official document. */
export function isTableVerified(): boolean {
  return NAW_RUZ_TABLE.every((e) => e.verified)
}

/**
 * Guard for anything that produces a document an Assembly will rely on.
 *
 * Scoped to the years the document covers, so it stays meaningful if the table
 * is ever extended past 221 B.E. with dates that have not yet been reconciled.
 * Today every entry is verified and this passes for any year in range.
 */
export function assertVerifiedYears(from: number, to: number): void {
  const pending = unverifiedYearsIn(from, to)
  if (pending.length > 0) {
    throw new Error(
      `Naw-Rúz dates for ${pending.join(', ')} B.E. have not been reconciled ` +
        `against the official published table. Check them in naw-ruz-table.ts ` +
        `and set verified: true before exporting audit documents for those years.`,
    )
  }
}
