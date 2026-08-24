/**
 * Money in Bedrock is always an integer number of cents.
 *
 * Never a float. A treasurer's books have to foot exactly, and 0.1 + 0.2 does
 * not equal 0.3 in binary floating point. Parsing happens once at the edge
 * (CSV import, manual entry); everything inland is integers.
 */

/** An integer number of cents. Negative means money out. */
export type Cents = number

export function assertCents(value: number, context = 'amount'): Cents {
  if (!Number.isInteger(value)) {
    throw new TypeError(
      `${context} must be an integer number of cents, received ${value}. ` +
        `Parse with parseMoney() at the edge rather than using a float.`,
    )
  }
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${context} exceeds the safe integer range: ${value}`)
  }
  return value
}

const MONEY = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const MONEY_WHOLE = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
})

/** 418290 → "$4,182.90". Negatives render as "-$4,182.90". */
export function formatMoney(cents: Cents): string {
  return MONEY.format(cents / 100)
}

/** 418290 → "$4,183". For headline figures where cents are noise. */
export function formatMoneyWhole(cents: Cents): string {
  return MONEY_WHOLE.format(cents / 100)
}

/**
 * Explicitly signed, using a true minus sign (U+2212) rather than a hyphen —
 * it aligns with the digits in Spectral and reads correctly when projected.
 * 163000 → "+$1,630.00";  -60145 → "−$601.45"
 */
export function formatSigned(cents: Cents): string {
  const magnitude = MONEY.format(Math.abs(cents) / 100)
  if (cents > 0) return `+${magnitude}`
  if (cents < 0) return `−${magnitude}`
  return magnitude
}

/**
 * Parse a money string from a bank CSV or a form field into cents.
 * Handles "$1,234.56", "1234.56", "(1,234.56)" for negatives, "-1234.56",
 * and a bare "1234". Returns null when the input is not money at all, so the
 * caller can flag the row rather than silently importing a zero.
 */
export function parseMoney(input: string): Cents | null {
  const raw = input.trim()
  if (raw === '') return null

  // Accounting notation: parentheses mean negative.
  const parenthesised = /^\((.*)\)$/.exec(raw)
  const body = parenthesised ? parenthesised[1] : raw
  const negative = parenthesised !== null || /^-/.test(body)

  const cleaned = body.replace(/[$\s,−-]/g, '')
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null

  const [whole, fraction = ''] = cleaned.split('.')
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  if (!Number.isSafeInteger(cents)) return null
  return negative ? -cents : cents
}

export function sumCents(values: readonly Cents[]): Cents {
  return values.reduce((total, v) => total + v, 0)
}

/**
 * Share of a total, as a 0-1 fraction. Returns 0 rather than NaN when the
 * total is zero — a month with no contributions must not blow up the chart.
 */
export function share(part: Cents, total: Cents): number {
  if (total === 0) return 0
  return part / total
}
