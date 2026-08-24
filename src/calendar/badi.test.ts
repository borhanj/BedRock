import { describe, expect, it } from 'vitest'
import {
  ayyamIHaLength,
  bahaiYear,
  CalendarRangeError,
  feastDate,
  formatDateRange,
  formatFeast,
  formatLongDate,
  formatPeriod,
  monthsForYear,
  nawRuz,
  nextFeastAfter,
  periodFor,
  toDayIndex,
  yearLength,
} from './badi'
import {
  FIRST_TABULATED_YEAR,
  LAST_COMPLETE_YEAR,
  LAST_TABULATED_YEAR,
  NAW_RUZ_TABLE,
  isTableVerified,
  assertVerifiedYears,
  unverifiedYearsIn,
} from './naw-ruz-table'

describe('the Naw-Rúz table', () => {
  it('is strictly ordered by year with no gaps', () => {
    NAW_RUZ_TABLE.forEach((entry, i) => {
      if (i > 0) expect(entry.year).toBe(NAW_RUZ_TABLE[i - 1].year + 1)
    })
  })

  it('yields a legal Ayyám-i-Há length for every closable year', () => {
    // The strongest available check on the table: any bad entry makes one of
    // its two adjacent years produce something other than 4 or 5 days.
    for (let year = FIRST_TABULATED_YEAR; year <= LAST_COMPLETE_YEAR; year++) {
      expect([4, 5]).toContain(ayyamIHaLength(year))
    }
  })

  it('covers the full official range of 172-221 B.E.', () => {
    expect(FIRST_TABULATED_YEAR).toBe(172)
    expect(LAST_TABULATED_YEAR).toBe(221)
    expect(NAW_RUZ_TABLE).toHaveLength(50)
  })

  it('lets a report run for a corroborated year', () => {
    // The years an Assembly is actually using today are agreed by more than
    // one independent published source.
    expect(() => assertVerifiedYears(183, 183)).not.toThrow()
    expect(() => assertVerifiedYears(172, 190)).not.toThrow()
  })

  it('still blocks the years that rest on a single source', () => {
    // Flip these once the tail is read off the official document. The
    // failure is the reminder.
    expect(isTableVerified()).toBe(false)
    expect(unverifiedYearsIn(172, 221)).toEqual(
      Array.from({ length: 31 }, (_, i) => 191 + i),
    )
    expect(() => assertVerifiedYears(183, 200)).toThrow(/single published source/)
  })

  it('agrees with the published dates on the years that moved', () => {
    // 21 March rather than 20 March. Cross-checked against Wikipedia's
    // 2024-2031 table, which lists exactly 2026, 2027 and 2031.
    const marchTwentyFirst = NAW_RUZ_TABLE.filter((e) => e.date.endsWith('-03-21')).map(
      (e) => e.year,
    )
    expect(marchTwentyFirst).toEqual([
      172, 175, 176, 179, 180, 183, 184, 188, 192, 196, 200, 204, 208, 212,
    ])
  })
})

describe('year structure', () => {
  it('lays out 19 months plus Ayyám-i-Há, in calendar order', () => {
    const periods = monthsForYear(183)
    expect(periods).toHaveLength(20)
    expect(periods.map((p) => p.monthNumber).slice(0, 18)).toEqual(
      Array.from({ length: 18 }, (_, i) => i + 1),
    )
    // Ayyám-i-Há sits between Mulk (18) and ʿAláʼ (19), not at the year's end.
    expect(periods[17].name).toBe('Mulk')
    expect(periods[18].kind).toBe('ayyam-i-ha')
    expect(periods[19].name).toBe('ʿAláʼ')
  })

  it('tiles the year exactly — no gaps, no overlaps', () => {
    for (let year = FIRST_TABULATED_YEAR; year <= LAST_COMPLETE_YEAR; year++) {
      const periods = monthsForYear(year)
      expect(periods[0].startDate).toBe(nawRuz(year))
      periods.forEach((p, i) => {
        if (i > 0) {
          expect(toDayIndex(p.startDate)).toBe(toDayIndex(periods[i - 1].endDate) + 1)
        }
      })
      // The last day of ʿAláʼ is the day before the next Naw-Rúz.
      const lastDay = toDayIndex(periods[19].endDate)
      expect(lastDay).toBe(toDayIndex(nawRuz(year + 1)) - 1)
      // And the parts sum to the whole.
      const total = periods.reduce((sum, p) => sum + p.dayCount, 0)
      expect(total).toBe(yearLength(year))
    }
  })

  it('gives Ayyám-i-Há 4 days in 183 B.E. and 5 in 182 B.E.', () => {
    // 182 runs 20 Mar 2025 to 20 Mar 2026 (366 days); 183 runs 21 Mar 2026 to
    // 21 Mar 2027 (365). Both branches of the intercalary rule are exercised.
    expect(yearLength(182)).toBe(366)
    expect(ayyamIHaLength(182)).toBe(5)
    expect(yearLength(183)).toBe(365)
    expect(ayyamIHaLength(183)).toBe(4)
  })

  it('gives every month exactly 19 days regardless of the intercalary length', () => {
    for (const year of [182, 183]) {
      for (const p of monthsForYear(year)) {
        if (p.kind === 'month') expect(p.dayCount).toBe(19)
      }
    }
  })
})

describe('Naw-Rúz is not fixed to 21 March', () => {
  it('starts 183 B.E. on 21 March 2026 but 182 B.E. on 20 March 2025', () => {
    expect(nawRuz(183)).toBe('2026-03-21')
    expect(nawRuz(182)).toBe('2025-03-20')
  })

  it('places the equinox-shifted years on 20 March', () => {
    // A hardcoded 21 March would silently misdate every period in these years.
    expect(nawRuz(173)).toBe('2016-03-20')
    expect(nawRuz(181)).toBe('2024-03-20')
    expect(monthsForYear(181)[0].startDate).toBe('2024-03-20')
  })
})

describe('cross-check against the source design', () => {
  // The mockup this app implements states three derived dates for 183 B.E.
  // They are only reproducible from a 21 March 2026 Naw-Rúz, which is how that
  // table entry was corroborated. If these fail, the table moved.
  it('runs Kamál from 1 to 19 August 2026', () => {
    const kamal = monthsForYear(183).find((p) => p.name === 'Kamál')!
    expect(kamal.startDate).toBe('2026-08-01')
    expect(kamal.endDate).toBe('2026-08-19')
    expect(formatDateRange(kamal.startDate, kamal.endDate)).toBe('1 – 19 August 2026')
    expect(formatPeriod(kamal)).toBe('Month of Kamál, 183 B.E.')
  })

  it('holds the Feast of ʿIzzat on Tuesday 8 September 2026', () => {
    expect(feastDate(183, 10)).toBe('2026-09-08')
    expect(formatLongDate('2026-09-08')).toBe('Tuesday 8 September 2026')
  })

  it('closes the month of Asmáʼ on 7 September 2026', () => {
    const asma = monthsForYear(183).find((p) => p.name === 'Asmáʼ')!
    expect(asma.endDate).toBe('2026-09-07')
  })
})

describe('locating a date', () => {
  it('resolves a date to its Baháʼí year and period', () => {
    expect(bahaiYear('2026-08-05')).toBe(183)
    expect(periodFor('2026-08-05').name).toBe('Kamál')
  })

  it('treats Naw-Rúz as the first day of the new year, not the last of the old', () => {
    expect(bahaiYear('2026-03-20')).toBe(182)
    expect(bahaiYear('2026-03-21')).toBe(183)
    expect(periodFor('2026-03-21').monthNumber).toBe(1)
  })

  it('resolves dates inside Ayyám-i-Há', () => {
    const ayyam = monthsForYear(183).find((p) => p.kind === 'ayyam-i-ha')!
    const period = periodFor(ayyam.startDate)
    expect(period.kind).toBe('ayyam-i-ha')
    expect(period.feastDate).toBeNull()
    expect(formatFeast(period)).toBeNull()
    expect(formatPeriod(period)).toBe('Ayyám-i-Há, 183 B.E.')
  })

  it('accepts a Date as well as an ISO string, ignoring the clock', () => {
    expect(bahaiYear(new Date(2026, 7, 5, 23, 30))).toBe(183)
  })
})

describe('next Feast', () => {
  it('finds the Feast that opens the following month', () => {
    const next = nextFeastAfter('2026-09-01')
    expect(next.name).toBe('ʿIzzat')
    expect(next.feastDate).toBe('2026-09-08')
  })

  it('skips Ayyám-i-Há, which has no Feast', () => {
    const mulk = monthsForYear(183).find((p) => p.name === 'Mulk')!
    const next = nextFeastAfter(mulk.startDate)
    expect(next.name).toBe('ʿAláʼ')
  })

  it('rolls into the next year after the final Feast', () => {
    const ala = monthsForYear(183).find((p) => p.name === 'ʿAláʼ')!
    const next = nextFeastAfter(ala.startDate)
    expect(next.year).toBe(184)
    expect(next.name).toBe('Bahá')
    expect(next.feastDate).toBe(nawRuz(184))
  })
})

describe('refusing to guess', () => {
  it('throws before the table begins', () => {
    expect(() => nawRuz(FIRST_TABULATED_YEAR - 1)).toThrow(CalendarRangeError)
    expect(() => bahaiYear('2014-06-01')).toThrow(CalendarRangeError)
  })

  it('throws after the table ends', () => {
    expect(() => nawRuz(LAST_TABULATED_YEAR + 1)).toThrow(CalendarRangeError)
    expect(() => bahaiYear('2099-01-01')).toThrow(CalendarRangeError)
  })

  it('refuses to close the final tabulated year, whose Ayyám-i-Há is unknown', () => {
    // The last entry can open a year but not close one — the intercalary
    // length needs the following Naw-Rúz.
    expect(() => monthsForYear(LAST_TABULATED_YEAR)).toThrow(CalendarRangeError)
    expect(() => monthsForYear(LAST_COMPLETE_YEAR)).not.toThrow()
  })

  it('names the file to edit in the error', () => {
    expect(() => nawRuz(300)).toThrow(/naw-ruz-table\.ts/)
  })

  it('rejects an out-of-range month', () => {
    expect(() => feastDate(183, 0)).toThrow(RangeError)
    expect(() => feastDate(183, 20)).toThrow(RangeError)
  })
})

describe('formatting', () => {
  it('collapses a shared month name in a range', () => {
    expect(formatDateRange('2026-08-01', '2026-08-19')).toBe('1 – 19 August 2026')
  })

  it('keeps both month names when a range spans two months', () => {
    expect(formatDateRange('2026-08-20', '2026-09-07')).toBe('20 August – 7 September 2026')
  })

  it('keeps both years when a range spans the new year', () => {
    expect(formatDateRange('2026-12-20', '2027-01-07')).toBe(
      '20 December 2026 – 7 January 2027',
    )
  })
})
