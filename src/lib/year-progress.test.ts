import { describe, expect, it } from 'vitest'
import { monthsForYear } from '../calendar/badi'
import { yearProgress } from './year-progress'

const periods = monthsForYear(183)

describe('the dashboard headline', () => {
  it('reads as the source design does, from real dates', () => {
    // 28 August 2026 falls in Asmáʼ, the ninth month.
    const progress = yearProgress(periods, '2026-08-28')
    expect(progress.monthsClosed).toBe(8)
    expect(progress.periodsAhead).toBe(11)
    expect(progress.current?.name).toBe('Asmáʼ')
    expect(progress.headline).toBe('Eight months closed, eleven ahead')
  })

  it('degrades at the start of the year', () => {
    expect(yearProgress(periods, periods[0].startDate).headline).toBe(
      'The year is new — nineteen months ahead',
    )
  })

  it('uses the singular after one month has closed', () => {
    expect(yearProgress(periods, periods[1].startDate).headline).toBe(
      'One month closed, eighteen ahead',
    )
  })

  it('degrades during Ayyám-i-Há, which holds no Feast', () => {
    // Counting periods and counting months diverge here: the intercalary days
    // are a period but not a month, so "N months closed, M ahead" would imply
    // a Feast report that never comes.
    const ayyam = periods.find((p) => p.kind === 'ayyam-i-ha')!
    const progress = yearProgress(periods, ayyam.startDate)
    expect(progress.current?.kind).toBe('ayyam-i-ha')
    expect(progress.headline).toBe('Eighteen months closed — Ayyám-i-Há, then the Fast')
  })

  it('degrades in the final month', () => {
    const ala = periods[19]
    const progress = yearProgress(periods, ala.startDate)
    expect(progress.periodsAhead).toBe(0)
    expect(progress.headline).toBe('Eighteen months closed — ʿAláʼ is the last')
  })

  it('handles a date outside the year without inventing a current period', () => {
    const beforeNawRuz = '2026-03-20'
    const progress = yearProgress(periods, beforeNawRuz)
    expect(progress.current).toBeNull()
    expect(progress.headline).toBe('The year has not begun')
  })
})
