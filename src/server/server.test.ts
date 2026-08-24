import { beforeAll, describe, expect, it } from 'vitest'
import { formatMoney, sumCents } from '../lib/money'
import { setAuditActor, type SqlDatabase } from './db/adapter'
import { loadMigrations, migrate } from './db/migrate'
import { openNodeDatabase, type NodeSqlDatabase } from './db/node-sqlite'
import { loadYear } from './repo/year'
import { loadReport } from './repo/report'
import { handleApi } from './api'
import { ASSEMBLY_ID, SEED_TODAY, SEED_YEAR, seed, splitAmount } from './seed'

async function freshDatabase(): Promise<NodeSqlDatabase> {
  const db = openNodeDatabase(':memory:')
  await migrate(db)
  await seed(db)
  return db
}

describe('migrations', () => {
  it('apply once and are idempotent', async () => {
    const db = openNodeDatabase(':memory:')
    // Named from the directory rather than hard-coded, so adding a migration
    // does not fail a test about the runner.
    const expected = loadMigrations().map((m) => m.name)
    expect(expected[0]).toBe('0001_core')
    expect(await migrate(db)).toEqual(expected)
    expect(await migrate(db)).toEqual([])
    db.close()
  })

  it('store money only as integers', async () => {
    // A REAL column anywhere in the ledger is a rounding bug waiting to happen.
    const db = openNodeDatabase(':memory:')
    await migrate(db)
    const columns = await db.all<{ name: string; type: string }>(
      `SELECT p.name, p.type FROM pragma_table_info('transactions') p`,
    )
    const amount = columns.find((c) => c.name === 'amount_cents')
    expect(amount?.type).toBe('INTEGER')
    expect(columns.some((c) => c.type.toUpperCase().includes('REAL'))).toBe(false)
    db.close()
  })
})

describe('the audit trail is enforced by the database', () => {
  let db: NodeSqlDatabase

  beforeAll(async () => {
    db = await freshDatabase()
  })

  it('records every seeded transaction', async () => {
    const rows = await db.get<{ txns: number; logged: number }>(
      `SELECT (SELECT COUNT(*) FROM transactions) AS txns,
              (SELECT COUNT(*) FROM audit_log WHERE entity = 'transactions' AND action = 'insert') AS logged`,
    )
    expect(rows!.txns).toBeGreaterThan(0)
    expect(rows!.logged).toBe(rows!.txns)
  })

  it('attributes every entry to an actor', async () => {
    const orphans = await db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM audit_log WHERE actor IS NULL OR actor = ''",
    )
    expect(orphans!.n).toBe(0)
  })

  it('logs a raw INSERT that bypasses the application entirely', async () => {
    // The point of using triggers rather than an application convention.
    await db.run(
      `INSERT INTO transactions
        (id, assembly_id, account_id, occurred_on, amount_cents, method, source, kind, created_at, updated_at)
       VALUES ('txn-raw', ?, 'acct-bank', '2026-08-25', -500, 'bank', 'manual', 'expense', ?, ?)`,
      [ASSEMBLY_ID, '2026-08-25T00:00:00Z', '2026-08-25T00:00:00Z'],
    )
    const entry = await db.get<{ action: string; actor: string }>(
      "SELECT action, actor FROM audit_log WHERE entity_id = 'txn-raw'",
    )
    expect(entry).not.toBeNull()
    expect(entry!.action).toBe('insert')
  })

  it('refuses a write when no actor has been established', async () => {
    const bare = openNodeDatabase(':memory:')
    await migrate(bare)
    await expect(
      bare.run(
        `INSERT INTO assemblies (id, name, short_name, created_at) VALUES ('a', 'A', 'A', 'x')`,
      ),
    ).resolves.toBeTruthy()
    await bare.run(
      `INSERT INTO accounts (id, assembly_id, name, kind) VALUES ('acc', 'a', 'Bank', 'bank')`,
    )
    await expect(
      bare.run(
        `INSERT INTO transactions
          (id, assembly_id, account_id, occurred_on, amount_cents, method, source, kind, created_at, updated_at)
         VALUES ('t', 'a', 'acc', '2026-01-01', 100, 'bank', 'manual', 'expense', 'x', 'x')`,
      ),
    ).rejects.toThrow(/No audit actor set/)
    bare.close()
  })

  it('will not delete a receipt, because the numbering must stay gapless', async () => {
    await setAuditActor(db, 'test')
    await db.run(
      `INSERT INTO receipts (id, assembly_id, number, issued_on, amount_cents, method, fund_id)
       VALUES ('r1', ?, 1, '2026-08-01', 5000, 'cash', 'fund-local')`,
      [ASSEMBLY_ID],
    )
    await expect(db.run("DELETE FROM receipts WHERE id = 'r1'")).rejects.toThrow(
      /cannot be deleted/,
    )
    // Voiding is the supported path, and is itself audited.
    await db.run("UPDATE receipts SET voided_at = '2026-08-02' WHERE id = 'r1'")
    const logged = await db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'receipts' AND action = 'update'",
    )
    expect(logged!.n).toBe(1)
  })

  it('will not edit a transaction inside a closed period', async () => {
    await setAuditActor(db, 'test')
    await db.run("UPDATE transactions SET is_locked = 1 WHERE id = 'txn-raw'")
    await expect(
      db.run("UPDATE transactions SET amount_cents = -999 WHERE id = 'txn-raw'"),
    ).rejects.toThrow(/period is closed/)
    // Unlocking is permitted, and leaves its own audit entry.
    await db.run("UPDATE transactions SET is_locked = 0 WHERE id = 'txn-raw'")
    await db.run("UPDATE transactions SET amount_cents = -999 WHERE id = 'txn-raw'")
  })
})

describe('the year, read from the database', () => {
  let db: SqlDatabase

  beforeAll(async () => {
    db = await freshDatabase()
  })

  it('reports the same totals the design prints', async () => {
    const view = await loadYear(db, ASSEMBLY_ID, SEED_YEAR, SEED_TODAY)
    expect(formatMoney(view.receivedToDateCents)).toBe('$10,640.00')
    expect(formatMoney(view.paidToDateCents)).toBe('$5,915.40')
    expect(formatMoney(view.onHandTodayCents)).toBe('$5,172.40')
  })

  it('splits the balance into funds that sum back to it', async () => {
    const view = await loadYear(db, ASSEMBLY_ID, SEED_YEAR, SEED_TODAY)
    expect(sumCents(view.funds.map((f) => f.balanceCents))).toBe(view.onHandTodayCents)
    expect(view.funds.map((f) => [f.label, formatMoney(f.balanceCents)])).toEqual([
      ['Local Fund', '$4,182.90'],
      ['National Fund', '$625.00'],
      ['Continental Fund', '$150.00'],
      ['Cash box', '$214.50'],
    ])
  })

  it('buckets contributions into the right Baháʼí months', async () => {
    const view = await loadYear(db, ASSEMBLY_ID, SEED_YEAR, SEED_TODAY)
    expect(view.months).toHaveLength(19)
    const kamal = view.months.find((m) => m.monthNumber === 8)!
    expect(formatMoney(kamal.contributionsCents)).toBe('$1,630.00')
    expect(formatMoney(kamal.expensesCents)).toBe('$601.45')
    // Months are bucketed by the calendar, so every month's flows must add up
    // to the year total with nothing lost at a boundary.
    expect(sumCents(view.months.map((m) => m.contributionsCents))).toBe(
      view.receivedToDateCents,
    )
    expect(sumCents(view.months.map((m) => m.expensesCents))).toBe(view.paidToDateCents)
  })

  it('marks months closed, ready, current and future', async () => {
    const view = await loadYear(db, ASSEMBLY_ID, SEED_YEAR, SEED_TODAY)
    const status = (n: number) => view.months.find((m) => m.monthNumber === n)!.status
    expect(status(7)).toBe('closed')
    // Kamál's report is built but not presented, so it is not closed.
    expect(status(8)).toBe('ready')
    expect(status(9)).toBe('current')
    expect(status(10)).toBe('future')
  })

  it('counts the worklist from the data rather than a constant', async () => {
    const view = await loadYear(db, ASSEMBLY_ID, SEED_YEAR, SEED_TODAY)
    const counts = Object.fromEntries(view.attention.map((a) => [a.key, a.count]))
    expect(counts).toEqual({
      uncategorised: 7,
      'missing-receipt-image': 3,
      'unissued-receipts': 2,
    })
  })
})

describe('the Kamál Feast report, read from the database', () => {
  let db: SqlDatabase

  beforeAll(async () => {
    db = await freshDatabase()
  })

  it('opens where the prior month closed', async () => {
    const report = (await loadReport(db, ASSEMBLY_ID, SEED_YEAR, 8))!
    expect(formatMoney(report.openingCents)).toBe('$4,274.25')
  })

  it('uses the calendar bounds as its default cutoff', async () => {
    const report = (await loadReport(db, ASSEMBLY_ID, SEED_YEAR, 8))!
    expect(report.cutoffStart).toBe('2026-08-01')
    expect(report.cutoffEnd).toBe('2026-08-19')
    expect(report.presentedAtMonth).toBe(9)
  })

  it('lists income by fund and expenses by category', async () => {
    const report = (await loadReport(db, ASSEMBLY_ID, SEED_YEAR, 8))!
    expect(report.income.map((l) => [l.label, formatMoney(l.amountCents)])).toEqual([
      ['Local Fund', '$1,105.00'],
      ['National Fund', '$425.00'],
      ['Continental Fund', '$100.00'],
    ])
    expect(report.expenses.map((l) => [l.label, formatMoney(l.amountCents)])).toEqual([
      ['Rent / facility use', '$350.00'],
      ['Feast hospitality', '$96.75'],
      ['Utilities', '$84.20'],
      ['Children’s classes', '$62.50'],
      ['Bank fees', '$8.00'],
    ])
  })

  it('reports 23 contributions from 11 households', async () => {
    const report = (await loadReport(db, ASSEMBLY_ID, SEED_YEAR, 8))!
    expect(report.contributionCount).toBe(23)
    expect(report.householdCount).toBe(11)
  })

  it('has a closing breakdown that sums to the closing balance', async () => {
    // The source mockup failed exactly this check, by the value of the cash box.
    const report = (await loadReport(db, ASSEMBLY_ID, SEED_YEAR, 8))!
    const income = sumCents(report.income.map((l) => l.amountCents))
    const expenses = sumCents(report.expenses.map((l) => l.amountCents))
    const closing = report.openingCents + income - expenses - report.remittedCents
    expect(formatMoney(closing)).toBe('$5,002.80')
    expect(sumCents(report.closingBreakdown.map((l) => l.amountCents))).toBe(closing)
  })

  it('returns nothing for a month whose report has not been built', async () => {
    expect(await loadReport(db, ASSEMBLY_ID, SEED_YEAR, 12)).toBeNull()
  })
})

describe('the HTTP surface', () => {
  let db: SqlDatabase

  beforeAll(async () => {
    db = await freshDatabase()
  })

  const call = (path: string) =>
    handleApi(new Request(`http://localhost${path}`), {
      db,
      assemblyId: ASSEMBLY_ID,
      actor: 'test',
      today: SEED_TODAY,
      now: '2026-08-28T12:00:00Z',
    })

  it('serves the year', async () => {
    const response = (await call('/api/year/183'))!
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json()
    expect(body.onHandTodayCents).toBe(517_240)
  })

  it('serves a report, and 404s one that does not exist', async () => {
    expect((await call('/api/report/183/8'))!.status).toBe(200)
    expect((await call('/api/report/183/12'))!.status).toBe(404)
  })

  it('explains a year outside the Naw-Rúz table instead of crashing', async () => {
    const response = (await call('/api/year/300'))!
    expect(response.status).toBe(422)
    expect((await response.json()).error).toMatch(/naw-ruz-table\.ts/)
  })

  it('leaves non-API paths to the asset handler', async () => {
    expect(await handleApi(new Request('http://localhost/report/183/8'), {
      db, assemblyId: ASSEMBLY_ID, actor: 'test', today: SEED_TODAY,
      now: '2026-08-28T12:00:00Z',
    })).toBeNull()
  })
})

describe('splitAmount', () => {
  it('always sums to the original', async () => {
    for (const total of [163_000, 1, 999, 42_000, 2_500]) {
      for (const parts of [1, 2, 3, 7, 15]) {
        const parts_ = splitAmount(total, Math.min(parts, Math.floor(total / 100) || 1))
        expect(sumCents(parts_)).toBe(total)
      }
    }
  })
})
