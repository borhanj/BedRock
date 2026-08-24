import { beforeEach, describe, expect, it } from 'vitest'
import { formatMoney } from '../lib/money'
import { migrate } from './db/migrate'
import { openNodeDatabase, type NodeSqlDatabase } from './db/node-sqlite'
import {
  ensureReport,
  finalizeReport,
  loadReport,
  loadYearSummary,
  presentReport,
  ReportStateError,
  setCutoff,
  unlockReport,
} from './repo/report'
import { createTransaction } from './repo/ledger'
import { ASSEMBLY_ID, SEED_YEAR, seed } from './seed'

const NOW = '2026-09-08T12:00:00Z'
const ACTOR = 'treasurer@riverbend'

async function freshDatabase(): Promise<NodeSqlDatabase> {
  const db = openNodeDatabase(':memory:')
  await migrate(db)
  await seed(db)
  return db
}

const sum = (lines: readonly { amountCents: number }[]) =>
  lines.reduce((t, l) => t + l.amountCents, 0)

describe('starting a report', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await freshDatabase()
  })

  it('defaults the cutoff to the calendar bounds of the month', async () => {
    // Asmáʼ, the ninth month, has no report in the seed.
    const report = (await ensureReport(db, ASSEMBLY_ID, SEED_YEAR, 9, ACTOR))!
    expect(report.cutoffStart).toBe('2026-08-20')
    expect(report.cutoffEnd).toBe('2026-09-07')
    expect(report.calendarStart).toBe('2026-08-20')
    expect(report.status).toBe('draft')
    expect(report.locked).toBe(false)
  })

  it('is idempotent, and never disturbs an existing report', async () => {
    const first = (await ensureReport(db, ASSEMBLY_ID, SEED_YEAR, 8, ACTOR))!
    expect(first.status).toBe('ready')
    const again = (await ensureReport(db, ASSEMBLY_ID, SEED_YEAR, 8, ACTOR))!
    expect(again.status).toBe('ready')
    const count = await db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM reports WHERE bahai_year = ? AND month_number = 8',
      [SEED_YEAR],
    )
    expect(count!.n).toBe(1)
  })

  it('refuses a month that does not exist', async () => {
    expect(await ensureReport(db, ASSEMBLY_ID, SEED_YEAR, 20, ACTOR)).toBeNull()
  })
})

describe('moving the reporting cutoff', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await freshDatabase()
    await ensureReport(db, ASSEMBLY_ID, SEED_YEAR, 9, ACTOR)
  })

  it('keeps the Feast name while changing what the window covers', async () => {
    const before = (await loadReport(db, ASSEMBLY_ID, SEED_YEAR, 9))!
    // The statement posted late; pull the cutoff back four days.
    const after = (await setCutoff(
      db, ASSEMBLY_ID, SEED_YEAR, 9, '2026-08-20', '2026-09-03', ACTOR,
    ))!

    expect(after.monthNumber).toBe(9) // the Feast is still Asmáʼ
    expect(after.calendarEnd).toBe('2026-09-07') // the calendar did not move
    expect(after.cutoffEnd).toBe('2026-09-03') // the window did
    expect(sum(after.income)).toBeLessThanOrEqual(sum(before.income))
  })

  it('recomputes the figures against the new window', async () => {
    // A window covering nothing yields a report of nothing, opening and
    // closing at the same balance.
    const empty = (await setCutoff(
      db, ASSEMBLY_ID, SEED_YEAR, 9, '2026-09-06', '2026-09-07', ACTOR,
    ))!
    expect(sum(empty.income)).toBe(0)
    expect(empty.openingCents).toBe(empty.closingCents)
  })

  it('rejects a window that ends before it starts', async () => {
    await expect(
      setCutoff(db, ASSEMBLY_ID, SEED_YEAR, 9, '2026-09-07', '2026-08-20', ACTOR),
    ).rejects.toThrow(ReportStateError)
  })

  it('refuses to move a closed report', async () => {
    await finalizeReport(db, ASSEMBLY_ID, SEED_YEAR, 9, ACTOR, NOW)
    await expect(
      setCutoff(db, ASSEMBLY_ID, SEED_YEAR, 9, '2026-08-20', '2026-09-01', ACTOR),
    ).rejects.toThrow(/Unlock it/)
  })
})

describe('closing the books', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await freshDatabase()
    await ensureReport(db, ASSEMBLY_ID, SEED_YEAR, 9, ACTOR)
  })

  it('freezes the figures and locks the period', async () => {
    const report = (await finalizeReport(db, ASSEMBLY_ID, SEED_YEAR, 9, ACTOR, NOW))!
    expect(report.status).toBe('ready')
    expect(report.finalizedAt).toBe(NOW)
    expect(report.locked).toBe(true)

    const unlocked = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM transactions
        WHERE occurred_on BETWEEN '2026-08-20' AND '2026-09-07' AND is_locked = 0`,
    )
    expect(unlocked!.n).toBe(0)
  })

  it('makes the locked transactions uneditable', async () => {
    await finalizeReport(db, ASSEMBLY_ID, SEED_YEAR, 9, ACTOR, NOW)
    const row = await db.get<{ id: string }>(
      `SELECT id FROM transactions WHERE occurred_on BETWEEN '2026-08-20' AND '2026-09-07' LIMIT 1`,
    )
    await expect(
      db.run('UPDATE transactions SET amount_cents = 1 WHERE id = ?', [row!.id]),
    ).rejects.toThrow(/period is closed/)
  })

  it('keeps saying what it said when a later correction moves the numbers', async () => {
    const closed = (await finalizeReport(db, ASSEMBLY_ID, SEED_YEAR, 9, ACTOR, NOW))!
    const frozenIncome = sum(closed.income)
    expect(closed.drift).toBeNull()

    // A gift from the closed period turns up afterwards and is entered.
    await createTransaction(
      db, ASSEMBLY_ID,
      {
        accountId: 'acct-cash', occurredOn: '2026-09-01', amountCents: 7_500,
        payee: 'Late cash gift', memo: null, method: 'cash',
        kind: 'contribution', categoryId: null, fundId: 'fund-local',
      },
      ACTOR, NOW,
    )

    const after = (await loadReport(db, ASSEMBLY_ID, SEED_YEAR, 9))!
    // The report still shows what was presented...
    expect(sum(after.income)).toBe(frozenIncome)
    // ...and says plainly that the live figures have moved.
    expect(after.drift).not.toBeNull()
    expect(after.drift!.liveIncomeCents).toBe(frozenIncome + 7_500)
  })

  it('will not close a report twice', async () => {
    await finalizeReport(db, ASSEMBLY_ID, SEED_YEAR, 9, ACTOR, NOW)
    await expect(
      finalizeReport(db, ASSEMBLY_ID, SEED_YEAR, 9, ACTOR, NOW),
    ).rejects.toThrow(/already closed/)
  })
})

describe('presenting at Feast', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await freshDatabase()
    await ensureReport(db, ASSEMBLY_ID, SEED_YEAR, 9, ACTOR)
  })

  it('requires the report to be built first', async () => {
    await expect(
      presentReport(db, ASSEMBLY_ID, SEED_YEAR, 9, ACTOR, NOW),
    ).rejects.toThrow(/Build the report/)
  })

  it('records when it was read out', async () => {
    await finalizeReport(db, ASSEMBLY_ID, SEED_YEAR, 9, ACTOR, NOW)
    const presented = (await presentReport(db, ASSEMBLY_ID, SEED_YEAR, 9, ACTOR, NOW))!
    expect(presented.status).toBe('presented')
    expect(presented.presentedAt).toBe(NOW)
  })

  it('cannot have its cutoff changed once presented, even in raw SQL', async () => {
    await finalizeReport(db, ASSEMBLY_ID, SEED_YEAR, 9, ACTOR, NOW)
    await presentReport(db, ASSEMBLY_ID, SEED_YEAR, 9, ACTOR, NOW)
    await expect(
      db.run(
        `UPDATE reports SET cutoff_end = '2026-09-01'
          WHERE bahai_year = ? AND month_number = 9`,
        [SEED_YEAR],
      ),
    ).rejects.toThrow(/presented at Feast/)
  })
})

describe('reopening closed books', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await freshDatabase()
    await ensureReport(db, ASSEMBLY_ID, SEED_YEAR, 9, ACTOR)
    await finalizeReport(db, ASSEMBLY_ID, SEED_YEAR, 9, ACTOR, NOW)
  })

  it('returns the report to draft and discards the frozen figures', async () => {
    const open = (await unlockReport(db, ASSEMBLY_ID, SEED_YEAR, 9, ACTOR, NOW))!
    expect(open.status).toBe('draft')
    expect(open.finalizedAt).toBeNull()
    expect(open.drift).toBeNull()
    expect(open.locked).toBe(false)
  })

  it('unlocks the transactions so they can be corrected', async () => {
    await unlockReport(db, ASSEMBLY_ID, SEED_YEAR, 9, ACTOR, NOW)
    const row = await db.get<{ id: string }>(
      `SELECT id FROM transactions WHERE occurred_on BETWEEN '2026-08-20' AND '2026-09-07' LIMIT 1`,
    )
    await expect(
      db.run("UPDATE transactions SET memo = 'corrected' WHERE id = ?", [row!.id]),
    ).resolves.toBeTruthy()
  })

  it('leaves rows locked when another closed report still covers them', async () => {
    // Kamál is already 'ready' in the seed, covering 1-19 August. Give Asmáʼ's
    // report an overlapping window, close it, then reopen it: the overlap
    // stays locked because Kamál has not been reopened.
    await unlockReport(db, ASSEMBLY_ID, SEED_YEAR, 9, ACTOR, NOW)
    await setCutoff(db, ASSEMBLY_ID, SEED_YEAR, 9, '2026-08-10', '2026-09-07', ACTOR)
    await finalizeReport(db, ASSEMBLY_ID, SEED_YEAR, 9, ACTOR, NOW)
    await unlockReport(db, ASSEMBLY_ID, SEED_YEAR, 9, ACTOR, NOW)

    const overlap = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM transactions
        WHERE occurred_on BETWEEN '2026-08-10' AND '2026-08-19' AND is_locked = 0`,
    )
    expect(overlap!.n).toBe(0)

    const beyond = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM transactions
        WHERE occurred_on BETWEEN '2026-08-20' AND '2026-09-07' AND is_locked = 1`,
    )
    expect(beyond!.n).toBe(0)
  })

  it('will not reopen a report that is already open', async () => {
    await unlockReport(db, ASSEMBLY_ID, SEED_YEAR, 9, ACTOR, NOW)
    await expect(
      unlockReport(db, ASSEMBLY_ID, SEED_YEAR, 9, ACTOR, NOW),
    ).rejects.toThrow(/already open/)
  })

  it('leaves an audit trail of the whole lifecycle', async () => {
    await unlockReport(db, ASSEMBLY_ID, SEED_YEAR, 9, ACTOR, NOW)
    const entries = await db.all<{ action: string; actor: string }>(
      `SELECT action, actor FROM audit_log
        WHERE entity = 'reports' AND entity_id LIKE '%-183-9' ORDER BY id`,
    )
    // created, finalised, reopened.
    expect(entries.map((e) => e.action)).toEqual(['insert', 'update', 'update'])
    expect(entries.every((e) => e.actor === ACTOR)).toBe(true)
  })
})

describe('the year-end summary', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await freshDatabase()
  })

  it('foots to the same totals as the year dashboard', async () => {
    const summary = (await loadYearSummary(db, ASSEMBLY_ID, SEED_YEAR))!
    expect(formatMoney(sum(summary.incomeByFund))).toBe('$10,640.00')
    expect(formatMoney(sum(summary.expensesByCategory))).toBe('$5,915.40')
    expect(formatMoney(sum(summary.remittancesByFund))).toBe('$1,200.00')
    expect(formatMoney(summary.closingCents)).toBe('$5,172.40')
  })

  it('reconciles opening plus flows to closing', async () => {
    const s = (await loadYearSummary(db, ASSEMBLY_ID, SEED_YEAR))!
    expect(
      s.openingCents +
        sum(s.incomeByFund) -
        sum(s.expensesByCategory) -
        sum(s.remittancesByFund),
    ).toBe(s.closingCents)
  })

  it('has a closing breakdown that sums to the closing balance', async () => {
    const s = (await loadYearSummary(db, ASSEMBLY_ID, SEED_YEAR))!
    expect(sum(s.closingBreakdown)).toBe(s.closingCents)
  })

  it('lists all nineteen months with their report status', async () => {
    const s = (await loadYearSummary(db, ASSEMBLY_ID, SEED_YEAR))!
    expect(s.months).toHaveLength(19)
    expect(s.months.find((m) => m.monthNumber === 7)!.status).toBe('presented')
    expect(s.months.find((m) => m.monthNumber === 8)!.status).toBe('ready')
    expect(s.months.find((m) => m.monthNumber === 12)!.status).toBe('none')
    expect(s.reportsPresented).toBe(7)
  })

  it('counts money that fell outside every monthly cutoff', async () => {
    // The summary runs over the whole Baháʼí year, not the union of the
    // reports. A gift on a day no report happens to cover must still appear,
    // or the annual figures would quietly disagree with the ledger.
    const before = (await loadYearSummary(db, ASSEMBLY_ID, SEED_YEAR))!
    await createTransaction(
      db, ASSEMBLY_ID,
      {
        // Well past every seeded report, still inside 183 B.E.
        accountId: 'acct-cash', occurredOn: '2026-12-01', amountCents: 4_200,
        payee: 'Winter gift', memo: null, method: 'cash',
        kind: 'contribution', categoryId: null, fundId: 'fund-local',
      },
      ACTOR, NOW,
    )
    const after = (await loadYearSummary(db, ASSEMBLY_ID, SEED_YEAR))!
    expect(sum(after.incomeByFund)).toBe(sum(before.incomeByFund) + 4_200)
    expect(after.closingCents).toBe(before.closingCents + 4_200)
  })

  it('sums its per-month rows to the year totals', async () => {
    const s = (await loadYearSummary(db, ASSEMBLY_ID, SEED_YEAR))!
    const monthly = s.months.reduce((t, m) => t + m.contributionsCents, 0)
    expect(monthly).toBe(sum(s.incomeByFund))
  })
})
