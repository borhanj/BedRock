/**
 * A CSV reader for bank exports.
 *
 * Written rather than pulled in because the requirement is narrow and the
 * failure mode is expensive: a parser that quietly mis-splits one row puts a
 * wrong number in someone's books. This follows RFC 4180 — quoted fields,
 * doubled quotes to escape a quote, embedded commas and newlines — and handles
 * the things real bank files add on top: a UTF-8 BOM, CRLF endings, trailing
 * blank lines, and preamble rows before the header.
 */

/** Parse CSV text into rows of raw string cells. Never throws on ragged rows. */
export function parseCsv(text: string, delimiter = ','): string[][] {
  // Excel writes a BOM; left in place it becomes part of the first header name.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0

  const endField = () => {
    row.push(field)
    field = ''
  }
  const endRow = () => {
    endField()
    rows.push(row)
    row = []
  }

  while (i < input.length) {
    const char = input[i]

    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
        i++
        continue
      }
      field += char
      i++
      continue
    }

    if (char === '"' && field === '') {
      quoted = true
      i++
      continue
    }
    if (char === delimiter) {
      endField()
      i++
      continue
    }
    if (char === '\r') {
      // Swallow CR; the LF that follows ends the row.
      i++
      if (input[i] === '\n') i++
      endRow()
      continue
    }
    if (char === '\n') {
      i++
      endRow()
      continue
    }

    field += char
    i++
  }

  // A file not ending in a newline still has a final row.
  if (field !== '' || row.length > 0) endRow()

  // Drop trailing blank lines, which every export seems to have.
  while (rows.length > 0 && isBlank(rows[rows.length - 1])) rows.pop()

  return rows
}

function isBlank(row: readonly string[]): boolean {
  return row.every((cell) => cell.trim() === '')
}

/**
 * Guess the delimiter. Some European exports are semicolon-separated, and a
 * few credit unions still emit tab-separated files with a .csv extension.
 */
export function detectDelimiter(text: string): string {
  const sample = text.slice(0, 4000)
  const counts = [',', ';', '\t', '|'].map((d) => ({
    delimiter: d,
    // Count only outside quotes, cheaply: split on lines and take the median
    // field count rather than the raw character count.
    score: consistency(sample, d),
  }))
  counts.sort((a, b) => b.score - a.score)
  return counts[0].score > 0 ? counts[0].delimiter : ','
}

/** How consistently a delimiter yields the same number of fields per row. */
function consistency(sample: string, delimiter: string): number {
  const rows = parseCsv(sample, delimiter).slice(0, 20)
  if (rows.length < 2) return 0
  const widths = rows.map((r) => r.length)
  const modal = widths.sort((a, b) => a - b)[Math.floor(widths.length / 2)]
  if (modal < 2) return 0
  const agreeing = widths.filter((w) => w === modal).length
  return modal * (agreeing / widths.length)
}

export interface CsvTable {
  readonly header: readonly string[]
  readonly rows: readonly (readonly string[])[]
  /** Rows skipped before the header, e.g. an account summary preamble. */
  readonly skipped: number
  readonly delimiter: string
}

/**
 * Split a file into a header and its data rows.
 *
 * Bank exports often begin with a few preamble lines — account number, date
 * range, a blank. The header is taken to be the first row that has the modal
 * field count and at least two non-empty cells.
 */
export function readTable(text: string, delimiter = detectDelimiter(text)): CsvTable {
  const rows = parseCsv(text, delimiter).filter((r) => !isBlank(r))
  if (rows.length === 0) {
    return { header: [], rows: [], skipped: 0, delimiter }
  }

  const widths = rows.map((r) => r.length)
  const modal = mode(widths)

  let headerIndex = rows.findIndex(
    (r) => r.length === modal && r.filter((c) => c.trim() !== '').length >= 2,
  )
  if (headerIndex === -1) headerIndex = 0

  return {
    header: rows[headerIndex].map((cell) => cell.trim()),
    rows: rows.slice(headerIndex + 1).filter((r) => r.length === modal),
    skipped: headerIndex,
    delimiter,
  }
}

function mode(values: readonly number[]): number {
  const counts = new Map<number, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  let best = values[0]
  let bestCount = 0
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value
      bestCount = count
    }
  }
  return best
}
