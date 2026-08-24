import { beforeEach, describe, expect, it } from 'vitest'
import { formatMoney } from '../lib/money'
import { migrate } from './db/migrate'
import { openNodeDatabase, type NodeSqlDatabase } from './db/node-sqlite'
import { detectDelimiter, parseCsv, readTable } from './import/csv'
import {
  applyMapping,
  detectDateFormat,
  guessMapping,
  parseDate,
  type ColumnMapping,
} from './import/mapping'
import { normalizeDescription } from './import/dedupe'
import { commitImport, categorise, previewImport } from './repo/import'
import { createTransaction, loadCashJournal, loadLedger } from './repo/ledger'
import { listRules } from './repo/rules'
import { ASSEMBLY_ID, seed } from './seed'

const NOW = '2026-08-28T12:00:00Z'
const BANK = 'acct-bank'
const CASH = 'acct-cash'

async function freshDatabase(): Promise<NodeSqlDatabase> {
  const db = openNodeDatabase(':memory:')
  await migrate(db)
  await seed(db)
  return db
}

// A statement in the shape credit unions actually export: a preamble, a
// quoted description containing a comma, CRLF endings, and a trailing blank.
const STATEMENT = [
  'Riverbend Credit Union',
  'Statement 01/08/2026 - 19/08/2026',
  '',
  'Date,Description,Debit,Credit',
  '02/08/2026,"HALL RENTAL, RIVERBEND COMMUNITY CTR",450.00,',
  '05/08/2026,CITY WATER UTILITY,72.15,',
  '09/08/2026,ATM WITHDRAWAL,20.00,',
  '09/08/2026,ATM WITHDRAWAL,20.00,',
  '12/08/2026,ONLINE TRANSFER FROM MEMBER,,315.00',
  '',
].join('\r\n')

const MAPPING: ColumnMapping = {
  date: 0,
  dateFormat: 'dmy',
  description: 1,
  amount: { kind: 'debit-credit', debit: 2, credit: 3 },
}

describe('reading a CSV', () => {
  it('handles quotes, embedded commas, CRLF and a BOM', () => {
    const rows = parseCsv('﻿a,b\r\n"x,y",z\r\n')
    expect(rows).toEqual([
      ['a', 'b'],
      ['x,y', 'z'],
    ])
  })

  it('unescapes doubled quotes', () => {
    expect(parseCsv('"he said ""hi""",2')).toEqual([['he said "hi"', '2']])
  })

  it('keeps a newline that is inside a quoted field', () => {
    expect(parseCsv('"line one\nline two",x')).toEqual([['line one\nline two', 'x']])
  })

  it('reads a final row with no trailing newline', () => {
    expect(parseCsv('a,b\nc,d')).toHaveLength(2)
  })

  it('detects semicolon and tab files', () => {
    expect(detectDelimiter('a;b;c\n1;2;3\n4;5;6')).toBe(';')
    expect(detectDelimiter('a\tb\tc\n1\t2\t3\n4\t5\t6')).toBe('\t')
    expect(detectDelimiter('a,b,c\n1,2,3\n4,5,6')).toBe(',')
  })

  it('skips a preamble and finds the real header', () => {
    const table = readTable(STATEMENT)
    // Two preamble lines; the blank between them is dropped before counting.
    expect(table.skipped).toBe(2)
    expect(table.header).toEqual(['Date', 'Description', 'Debit', 'Credit'])
    expect(table.rows).toHaveLength(5)
    // The quoted comma stayed inside its field.
    expect(table.rows[0][1]).toBe('HALL RENTAL, RIVERBEND COMMUNITY CTR')
  })
})

describe('reading dates, which is where imports go wrong', () => {
  it('uses a day over 12 to prove the order', () => {
    expect(detectDateFormat(['02/08/2026', '19/08/2026'])).toEqual({
      kind: 'detected',
      format: 'dmy',
      reason: expect.stringContaining('19'),
    })
    expect(detectDateFormat(['08/19/2026', '08/02/2026'])).toEqual({
      kind: 'detected',
      format: 'mdy',
      reason: expect.stringContaining('19'),
    })
  })

  it('recognises a four-digit year first', () => {
    expect(detectDateFormat(['2026-08-02']).kind).toBe('detected')
    expect(detectDateFormat(['2026/08/02'])).toMatchObject({ format: 'ymd' })
  })

  it('refuses to guess when every sample is 12 or under', () => {
    // 03/04/2026 is 3 April or 4 March and the file does not say which.
    // Guessing here silently moves money between Feast periods.
    expect(detectDateFormat(['03/04/2026', '05/06/2026'])).toEqual({
      kind: 'ambiguous',
      candidates: ['mdy', 'dmy'],
    })
  })

  it('reads the same cell two different ways on demand', () => {
    expect(parseDate('03/04/2026', 'dmy')).toBe('2026-04-03')
    expect(parseDate('03/04/2026', 'mdy')).toBe('2026-03-04')
  })

  it('rejects a date that does not exist', () => {
    // Date would happily roll this into 3 March.
    expect(parseDate('31/02/2026', 'dmy')).toBeNull()
    expect(parseDate('00/01/2026', 'dmy')).toBeNull()
    expect(parseDate('not a date', 'dmy')).toBeNull()
  })

  it('expands two-digit years into this century', () => {
    expect(parseDate('02/08/26', 'dmy')).toBe('2026-08-02')
  })
})

describe('mapping columns', () => {
  it('guesses the columns from the header names', () => {
    const table = readTable(STATEMENT)
    const { mapping } = guessMapping(table.header, table.rows)
    expect(mapping).toMatchObject({
      date: 0,
      description: 1,
      amount: { kind: 'debit-credit', debit: 2, credit: 3 },
    })
  })

  it('reports this statement as date-ambiguous, because it is', () => {
    // Every data row in the fixture is 12-or-under on both sides
    // (02/08, 05/08, 09/08, 12/08). The file cannot say whether it means
    // August or February, so the treasurer has to. This is the common case
    // for a one-month statement, not an edge case.
    const table = readTable(STATEMENT)
    const { dateDetection } = guessMapping(table.header, table.rows)
    expect(dateDetection.kind).toBe('ambiguous')
  })

  it('signs debit and credit columns correctly', () => {
    const table = readTable(STATEMENT)
    const { rows } = applyMapping(table.rows, MAPPING)
    expect(rows[0].amountCents).toBe(-45_000) // a debit is money out
    expect(rows[4].amountCents).toBe(31_500) // a credit is money in
  })

  it('reports unreadable rows instead of importing a wrong number', () => {
    const { rows, problems } = applyMapping(
      [
        ['02/08/2026', 'GOOD', '10.00', ''],
        ['garbage', 'BAD DATE', '10.00', ''],
        ['03/08/2026', 'NO AMOUNT', '', ''],
        ['04/08/2026', 'ZERO', '0.00', ''],
      ],
      MAPPING,
    )
    expect(rows).toHaveLength(1)
    expect(problems.map((p) => p.reason)).toEqual([
      expect.stringContaining('date'),
      expect.stringContaining('amount'),
      'Amount is zero',
    ])
  })
})

describe('importing', () => {
  let db: NodeSqlDatabase

  beforeEach(async () => {
    db = await freshDatabase()
  })

  const preview = () => previewImport(db, ASSEMBLY_ID, BANK, STATEMENT, MAPPING)

  const commitAll = async () => {
    const p = await preview()
    return commitImport(db, ASSEMBLY_ID, {
      accountId: BANK,
      csvText: STATEMENT,
      filename: 'august.csv',
      mapping: MAPPING,
      accept: p.rows.map((r) => r.dedupeHash),
      actor: 'test',
      now: NOW,
    })
  }

  it('reads every row as new the first time', async () => {
    const p = await preview()
    expect(p.counts).toMatchObject({ total: 5, fresh: 5, duplicates: 0, unreadable: 0 })
  })

  it('ADDS NOTHING the second time the same file is imported', async () => {
    // The acceptance test for this phase. A treasurer who exports "last 90
    // days" every month re-uploads most of what they already have.
    const first = await commitAll()
    expect(first.imported).toBe(5)

    const second = await preview()
    expect(second.counts.fresh).toBe(0)
    expect(second.counts.duplicates).toBe(5)

    const secondCommit = await commitAll()
    expect(secondCommit.imported).toBe(0)

    const rows = await loadLedger(db, ASSEMBLY_ID, { bahaiYear: 183, search: 'atm' })
    expect(rows).toHaveLength(2)
  })

  it('keeps two identical withdrawals on the same day as two transactions', async () => {
    // Same date, same amount, same description, and genuinely not duplicates.
    // A key without an ordinal would drop one and leave the books $20 out.
    await commitAll()
    const atm = await loadLedger(db, ASSEMBLY_ID, { bahaiYear: 183, search: 'atm' })
    expect(atm).toHaveLength(2)
    expect(atm.every((r) => r.amountCents === -2_000)).toBe(true)
  })

  it('imports a genuinely new third copy on a later statement', async () => {
    await commitAll()
    const extended = STATEMENT.replace(
      '12/08/2026,ONLINE TRANSFER FROM MEMBER,,315.00',
      '09/08/2026,ATM WITHDRAWAL,20.00,\r\n12/08/2026,ONLINE TRANSFER FROM MEMBER,,315.00',
    )
    const p = await previewImport(db, ASSEMBLY_ID, BANK, extended, MAPPING)

    // The five already on file match exactly. The third ATM row has no
    // matching hash, but a third identical $20 on the same day is ambiguous
    // enough to flag rather than wave through — the treasurer decides.
    expect(p.counts.duplicates).toBe(5)
    expect(p.counts.possible).toBe(1)
    expect(p.counts.fresh).toBe(0)

    const flagged = p.rows.find((r) => r.verdict === 'possible-duplicate')!
    expect(flagged.description).toBe('ATM WITHDRAWAL')
    expect(flagged.nearMatch?.daysApart).toBe(0)

    await commitImport(db, ASSEMBLY_ID, {
      accountId: BANK, csvText: extended, filename: 'sept.csv', mapping: MAPPING,
      accept: [flagged.dedupeHash], actor: 'test', now: NOW,
    })
    const atm = await loadLedger(db, ASSEMBLY_ID, { bahaiYear: 183, search: 'atm' })
    expect(atm).toHaveLength(3)
  })

  it('imports nothing when a flagged row is left unaccepted', async () => {
    await commitAll()
    const extended = STATEMENT.replace(
      '12/08/2026,ONLINE TRANSFER FROM MEMBER,,315.00',
      '09/08/2026,ATM WITHDRAWAL,20.00,\r\n12/08/2026,ONLINE TRANSFER FROM MEMBER,,315.00',
    )
    const result = await commitImport(db, ASSEMBLY_ID, {
      accountId: BANK, csvText: extended, filename: 'sept.csv', mapping: MAPPING,
      accept: [], actor: 'test', now: NOW,
    })
    expect(result.imported).toBe(0)
    const atm = await loadLedger(db, ASSEMBLY_ID, { bahaiYear: 183, search: 'atm' })
    expect(atm).toHaveLength(2)
  })

  it('flags a re-dated row as a possible duplicate rather than importing it', async () => {
    await commitAll()
    // The same rent payment, posted three days later by the bank.
    const redated = STATEMENT.replace('02/08/2026,"HALL RENTAL', '05/08/2026,"HALL RENTAL')
    const p = await previewImport(db, ASSEMBLY_ID, BANK, redated, MAPPING)
    const rent = p.rows.find((r) => r.description.startsWith('HALL RENTAL'))!
    expect(rent.verdict).toBe('possible-duplicate')
    expect(rent.nearMatch?.daysApart).toBe(3)
  })

  it('imports only the rows the treasurer accepted', async () => {
    const p = await preview()
    const keep = p.rows.filter((r) => r.amountCents < 0).map((r) => r.dedupeHash)
    const result = await commitImport(db, ASSEMBLY_ID, {
      accountId: BANK, csvText: STATEMENT, filename: 'august.csv', mapping: MAPPING,
      accept: keep, actor: 'test', now: NOW,
    })
    expect(result.imported).toBe(4)
  })

  it('records the batch, with the mapping that was used', async () => {
    await commitAll()
    const batch = await db.get<{ mapping_json: string; imported_count: number }>(
      'SELECT mapping_json, imported_count FROM import_batches',
    )
    expect(batch!.imported_count).toBe(5)
    expect(JSON.parse(batch!.mapping_json)).toMatchObject({ dateFormat: 'dmy' })
  })

  it('writes an audit entry for every imported row', async () => {
    const before = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_log')
    await commitAll()
    const after = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_log')
    expect(after!.n - before!.n).toBe(5)
  })

  it('arrives uncategorised, so the worklist picks it up', async () => {
    await commitAll()
    const uncategorised = await loadLedger(db, ASSEMBLY_ID, {
      bahaiYear: 183,
      uncategorisedOnly: true,
    })
    expect(uncategorised.length).toBeGreaterThanOrEqual(5)
  })
})

describe('learning a category', () => {
  let db: NodeSqlDatabase

  beforeEach(async () => {
    db = await freshDatabase()
    const p = await previewImport(db, ASSEMBLY_ID, BANK, STATEMENT, MAPPING)
    await commitImport(db, ASSEMBLY_ID, {
      accountId: BANK, csvText: STATEMENT, filename: 'august.csv', mapping: MAPPING,
      accept: p.rows.map((r) => r.dedupeHash), actor: 'test', now: NOW,
    })
  })

  it('suggests nothing before it has been taught', async () => {
    const rows = await loadLedger(db, ASSEMBLY_ID, { bahaiYear: 183, search: 'water' })
    expect(rows[0].suggestion).toBeNull()
  })

  it('suggests the same category for the same payee next month', async () => {
    const [water] = await loadLedger(db, ASSEMBLY_ID, { bahaiYear: 183, search: 'water' })
    await categorise(
      db, ASSEMBLY_ID, water.id,
      { categoryId: 'cat-utilities', fundId: 'fund-local', txnKind: 'expense' },
      'test', NOW,
    )

    const september = 'Date,Description,Debit,Credit\r\n04/09/2026,CITY WATER UTILITY,68.40,'
    const p = await previewImport(db, ASSEMBLY_ID, BANK, september, MAPPING)
    expect(p.rows[0].suggestion).toMatchObject({
      categoryId: 'cat-utilities',
      categoryLabel: 'Utilities',
    })
    expect(p.rows[0].suggestion?.because).toContain('categorised')
  })

  it('suggests but does not apply', async () => {
    // The distinction the whole design turns on: a suggestion the treasurer
    // confirms saves labour; a category applied silently is a number in the
    // books that nobody chose.
    const [water] = await loadLedger(db, ASSEMBLY_ID, { bahaiYear: 183, search: 'water' })
    await categorise(
      db, ASSEMBLY_ID, water.id,
      { categoryId: 'cat-utilities', fundId: 'fund-local', txnKind: 'expense' },
      'test', NOW,
    )

    const september = 'Date,Description,Debit,Credit\r\n04/09/2026,CITY WATER UTILITY,68.40,'
    const p = await previewImport(db, ASSEMBLY_ID, BANK, september, MAPPING)
    await commitImport(db, ASSEMBLY_ID, {
      accountId: BANK, csvText: september, filename: 'sept.csv', mapping: MAPPING,
      accept: p.rows.map((r) => r.dedupeHash), actor: 'test', now: NOW,
    })

    const imported = await db.get<{ category_id: string | null }>(
      "SELECT category_id FROM transactions WHERE occurred_on = '2026-09-04'",
    )
    expect(imported!.category_id).toBeNull()
  })

  it('counts how often a rule has been accepted', async () => {
    const rows = await loadLedger(db, ASSEMBLY_ID, { bahaiYear: 183, search: 'atm' })
    for (const row of rows) {
      await categorise(
        db, ASSEMBLY_ID, row.id,
        { categoryId: 'cat-supplies', fundId: null, txnKind: 'expense' },
        'test', NOW,
      )
    }
    const rules = await listRules(db, ASSEMBLY_ID)
    const atm = rules.find((r) => r.pattern === 'atm withdrawal')!
    expect(atm.hitCount).toBe(2)
    expect(atm.categoryLabel).toBe('Administrative supplies')
  })

  it('normalises payees so punctuation and case do not fork the rule', () => {
    expect(normalizeDescription('CITY WATER UTILITY')).toBe('city water utility')
    expect(normalizeDescription('City  Water,  Utility.')).toBe('city water utility')
  })
})

describe('the cash journal', () => {
  let db: NodeSqlDatabase

  beforeEach(async () => {
    db = await freshDatabase()
  })

  it('runs a balance forward that can be counted against the tin', async () => {
    const journal = await loadCashJournal(db, ASSEMBLY_ID, 183)
    expect(journal.openingCents).toBe(0)
    expect(formatMoney(journal.closingCents)).toBe('$214.50')

    // Each entry's balance is the previous one plus its own amount.
    let running = journal.openingCents
    for (const entry of journal.entries) {
      running += entry.amountCents
      expect(entry.balanceCents).toBe(running)
    }
    expect(running).toBe(journal.closingCents)
  })

  it('is ordered oldest first, unlike the ledger', async () => {
    const journal = await loadCashJournal(db, ASSEMBLY_ID, 183)
    const dates = journal.entries.map((e) => e.occurredOn)
    expect([...dates].sort()).toEqual(dates)
  })

  it('takes hand-entered cash, and the money reaches the reports', async () => {
    await createTransaction(
      db, ASSEMBLY_ID,
      {
        accountId: CASH, occurredOn: '2026-08-26', amountCents: 5_000,
        payee: 'Cash at Feast', memo: null, method: 'cash',
        kind: 'contribution', categoryId: null, fundId: 'fund-local',
      },
      'test', NOW,
    )

    const journal = await loadCashJournal(db, ASSEMBLY_ID, 183)
    expect(formatMoney(journal.closingCents)).toBe('$264.50')

    // A contribution has to create its child row or it never reaches an
    // income total — the reports read `contributions`, not `transactions`.
    const contribution = await db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM contributions WHERE amount_cents = 5000",
    )
    expect(contribution!.n).toBe(1)
  })
})
