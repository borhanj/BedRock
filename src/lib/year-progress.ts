/**
 * The dashboard headline — "Eight months closed, eleven ahead".
 *
 * The mockup showed this sentence mid-year only. It has to hold at both ends of
 * the year and during Ayyám-i-Há, which is a period but not a month and has no
 * Feast, so counting periods and counting months give different answers.
 */

import { asDayIndex, toDayIndex, type BadiPeriod } from '../calendar/badi'

const WORDS = [
  'No',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
  'Twenty',
]

function word(n: number): string {
  return WORDS[n] ?? String(n)
}

function lower(n: number): string {
  return word(n).toLowerCase()
}

export interface YearProgress {
  /** Months (never Ayyám-i-Há) whose period has ended. */
  readonly monthsClosed: number
  /** Periods, including Ayyám-i-Há, that have not begun. */
  readonly periodsAhead: number
  readonly current: BadiPeriod | null
  readonly headline: string
}

export function yearProgress(periods: readonly BadiPeriod[], today: string): YearProgress {
  const now = asDayIndex(today)

  const monthsClosed = periods.filter(
    (p) => p.kind === 'month' && toDayIndex(p.endDate) < now,
  ).length
  const periodsAhead = periods.filter((p) => toDayIndex(p.startDate) > now).length
  const current =
    periods.find(
      (p) => toDayIndex(p.startDate) <= now && toDayIndex(p.endDate) >= now,
    ) ?? null

  return { monthsClosed, periodsAhead, current, headline: headlineFor(monthsClosed, periodsAhead, current) }
}

function headlineFor(
  monthsClosed: number,
  periodsAhead: number,
  current: BadiPeriod | null,
): string {
  // Before Naw-Rúz, or after the last day of ʿAláʼ — the date is outside the year.
  if (!current) {
    return monthsClosed === 0 ? 'The year has not begun' : 'The year is complete'
  }

  if (monthsClosed === 0) {
    return 'The year is new — nineteen months ahead'
  }

  // Ayyám-i-Há is not a month and holds no Feast, so "N months closed,
  // M ahead" would quietly imply a Feast report that never comes.
  if (current.kind === 'ayyam-i-ha') {
    return `${word(monthsClosed)} months closed — Ayyám-i-Há, then the Fast`
  }

  if (periodsAhead === 0) {
    return `${word(monthsClosed)} months closed — ${current.name} is the last`
  }

  const closed = monthsClosed === 1 ? `${word(1)} month closed` : `${word(monthsClosed)} months closed`
  return `${closed}, ${lower(periodsAhead)} ahead`
}
