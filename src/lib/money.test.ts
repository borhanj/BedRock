import { describe, expect, it } from 'vitest'
import {
  assertCents,
  formatMoney,
  formatMoneyWhole,
  formatSigned,
  parseMoney,
  share,
  sumCents,
} from './money'

describe('formatting', () => {
  it('renders cents as dollars', () => {
    expect(formatMoney(418290)).toBe('$4,182.90')
    expect(formatMoney(0)).toBe('$0.00')
    expect(formatMoney(5)).toBe('$0.05')
  })

  it('rounds nothing — the integer is the truth', () => {
    expect(formatMoney(1)).toBe('$0.01')
    expect(formatMoney(999999999)).toBe('$9,999,999.99')
  })

  it('drops cents for headline figures', () => {
    expect(formatMoneyWhole(1248000)).toBe('$12,480')
  })

  it('signs with a true minus, not a hyphen', () => {
    expect(formatSigned(163000)).toBe('+$1,630.00')
    expect(formatSigned(-60145)).toBe('−$601.45')
    expect(formatSigned(-60145).charCodeAt(0)).toBe(0x2212)
    expect(formatSigned(0)).toBe('$0.00')
  })
})

describe('parsing at the edge', () => {
  it('accepts the shapes banks actually export', () => {
    expect(parseMoney('1234.56')).toBe(123456)
    expect(parseMoney('$1,234.56')).toBe(123456)
    expect(parseMoney('  1234  ')).toBe(123400)
    expect(parseMoney('0.05')).toBe(5)
    expect(parseMoney('-1234.56')).toBe(-123456)
  })

  it('reads accounting parentheses as negative', () => {
    expect(parseMoney('(1,234.56)')).toBe(-123456)
    expect(parseMoney('($350.00)')).toBe(-35000)
  })

  it('handles one-digit cents', () => {
    expect(parseMoney('12.5')).toBe(1250)
  })

  it('returns null rather than zero for junk, so the row can be flagged', () => {
    // Silently importing 0 would foot the books and hide the error.
    expect(parseMoney('')).toBeNull()
    expect(parseMoney('n/a')).toBeNull()
    expect(parseMoney('pending')).toBeNull()
    expect(parseMoney('1.234')).toBeNull()
    expect(parseMoney('12.34.56')).toBeNull()
  })

  it('never loses a cent to floating point', () => {
    // 0.1 + 0.2 !== 0.3 is exactly why this module exists.
    const a = parseMoney('0.10')!
    const b = parseMoney('0.20')!
    expect(a + b).toBe(30)
    expect(formatMoney(a + b)).toBe('$0.30')
  })

  it('round-trips every cent value from 0 to 999', () => {
    for (let c = 0; c < 1000; c++) {
      const text = formatMoney(c)
      expect(parseMoney(text)).toBe(c)
    }
  })
})

describe('arithmetic', () => {
  it('sums exactly', () => {
    // The Kamál expense lines from the Feast report.
    const lines = [35000, 9675, 8420, 6250, 800]
    expect(sumCents(lines)).toBe(60145)
    expect(formatMoney(sumCents(lines))).toBe('$601.45')
  })

  it('sums an empty ledger to zero', () => {
    expect(sumCents([])).toBe(0)
  })

  it('gives a zero share rather than NaN when nothing came in', () => {
    // A month with no contributions must not break the year chart.
    expect(share(0, 0)).toBe(0)
    expect(Number.isNaN(share(0, 0))).toBe(false)
    expect(share(50, 200)).toBe(0.25)
  })

  it('rejects a float before it can enter the ledger', () => {
    expect(() => assertCents(12.5)).toThrow(TypeError)
    expect(() => assertCents(12.5, 'contribution')).toThrow(/contribution/)
    expect(assertCents(1250)).toBe(1250)
  })
})
