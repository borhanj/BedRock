/**
 * The nineteen months of the Badí' calendar, plus Ayyám-i-Há.
 *
 * Order is significant: index 0 is Bahá (month 1). Ayyám-i-Há is NOT in this
 * list — it is an intercalary period that sits between month 18 (Mulk) and
 * month 19 (ʿAláʼ), and its length varies year to year. See ./badi.ts.
 */

export interface BadiMonth {
  /** 1-19 */
  readonly number: number
  /** Transliterated Arabic name, as shown throughout the UI. */
  readonly name: string
  /** English rendering, used in tooltips and the audit package. */
  readonly translation: string
}

export const BADI_MONTHS: readonly BadiMonth[] = [
  { number: 1, name: 'Bahá', translation: 'Splendour' },
  { number: 2, name: 'Jalál', translation: 'Glory' },
  { number: 3, name: 'Jamál', translation: 'Beauty' },
  { number: 4, name: 'ʿAẓamat', translation: 'Grandeur' },
  { number: 5, name: 'Núr', translation: 'Light' },
  { number: 6, name: 'Raḥmat', translation: 'Mercy' },
  { number: 7, name: 'Kalimát', translation: 'Words' },
  { number: 8, name: 'Kamál', translation: 'Perfection' },
  { number: 9, name: 'Asmáʼ', translation: 'Names' },
  { number: 10, name: 'ʿIzzat', translation: 'Might' },
  { number: 11, name: 'Mashíyyat', translation: 'Will' },
  { number: 12, name: 'ʿIlm', translation: 'Knowledge' },
  { number: 13, name: 'Qudrat', translation: 'Power' },
  { number: 14, name: 'Qawl', translation: 'Speech' },
  { number: 15, name: 'Masáʼil', translation: 'Questions' },
  { number: 16, name: 'Sharaf', translation: 'Honour' },
  { number: 17, name: 'Sulṭán', translation: 'Sovereignty' },
  { number: 18, name: 'Mulk', translation: 'Dominion' },
  { number: 19, name: 'ʿAláʼ', translation: 'Loftiness' },
] as const

/** Days in each of the nineteen months. Invariant, unlike Ayyám-i-Há. */
export const DAYS_PER_MONTH = 19

/** Short label for the Ayyám-i-Há column in the year chart. */
export const AYYAM_I_HA_SHORT = 'Há'
export const AYYAM_I_HA_NAME = 'Ayyám-i-Há'
