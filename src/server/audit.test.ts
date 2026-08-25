import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from './db/migrate'
import { openNodeDatabase, type NodeSqlDatabase } from './db/node-sqlite'
import { loadAuditPackage } from './repo/audit'
import { loadYearSummary } from './repo/report'
import { loadFunds } from './repo/funds'
import { setBudgetLine, reopenBudget } from './repo/budget'
import { createDonor, setupVault } from './repo/donors'
import { reopenReconciliation } from './repo/reconcile'
import { createTransaction } from './repo/ledger'
import { handleApi } from './api'
import { ASSEMBLY_ID, SEED_TODAY, SEED_YEAR, seed } from './seed'

const ACTOR = 'treasurer@riverbend'
const NOW = '2026-08-28T12:00:00Z'

async function freshDatabase(): Promise<NodeSqlDatabase> {
  const db = openNodeDatabase(':memory:')
  await migrate(db)
  await seed(db)
  return db
}

const pack = (db: NodeSqlDatabase, year = SEED_YEAR, today = SEED_TODAY) =>
  loadAuditPackage(db, ASSEMBLY_ID, year, today, ACTOR)

describe('the audit package', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await freshDatabase()
  })

  it('says who drew it, when, and whether the year is over', async () => {
    const view = (await pack(db))!
    expect(view.preparedBy).toBe(ACTOR)
    expect(view.preparedOn).toBe(SEED_TODAY)
    expect(view.yearComplete).toBe(false)

    const after = (await pack(db, SEED_YEAR, '2027-04-01'))!
    expect(after.yearComplete).toBe(true)
  })

  it('returns nothing for an assembly that does not exist', async () => {
    expect(await loadAuditPackage(db, 'nowhere', SEED_YEAR, SEED_TODAY, ACTOR)).toBeNull()
  })
})

describe('the package cannot disagree with the app', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await freshDatabase()
  })

  it('carries the year summary the summary screen shows', async () => {
    const view = (await pack(db))!
    const summary = (await loadYearSummary(db, ASSEMBLY_ID, SEED_YEAR))!
    // Not "matches" — it is the same object, from the same function. This test
    // is what keeps it that way if someone writes a print-only query later.
    expect(view.summary).toEqual(summary)
  })

  it('carries the fund figures the funds screen shows', async () => {
    const view = (await pack(db))!
    const funds = await loadFunds(db, ASSEMBLY_ID, SEED_YEAR)
    expect(view.funds.funds).toEqual(funds.funds)
    expect(view.funds.onHandCents).toBe(funds.onHandCents)
  })

  it('holds the whole year’s ledger, not a page of it', async () => {
    const view = (await pack(db))!
    const counted = await db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM transactions WHERE assembly_id = ?',
      [ASSEMBLY_ID],
    )
    expect(view.ledger).toHaveLength(counted!.n)
  })
})

describe('the checks', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await freshDatabase()
  })

  const check = async (key: string, database = db) =>
    (await pack(database))!.checks.find((c) => c.key === key)!

  it('all hold on a clean set of books', async () => {
    const view = (await pack(db))!
    expect(view.checks.filter((c) => !c.holds)).toEqual([])
    expect(view.checks).toHaveLength(5)
  })

  it('proves the fund partition rather than asserting it', async () => {
    expect((await check('funds-foot')).holds).toBe(true)
    expect((await check('funds-foot')).detail).toContain('$5,172.40')
  })

  it('proves receipt numbering has no holes', async () => {
    const before = await check('receipts-gapless')
    expect(before.holds).toBe(true)

    // A receipt book starting at 4 is a book with three numbers missing, and
    // the check has to catch it however it got that way.
    await db.run(
      `INSERT INTO receipts (id, assembly_id, number, issued_on, amount_cents, method, fund_id)
       VALUES ('r-4', ?, 4, '2026-08-01', 1000, 'cash', 'fund-local')`,
      [ASSEMBLY_ID],
    )
    expect((await check('receipts-gapless')).holds).toBe(false)
  })

  it('notices a report that no longer matches the ledger', async () => {
    expect((await check('reports-stable')).holds).toBe(true)

    // Post a late correction into a month already presented. The lock stops
    // an existing row being edited, but a genuinely new row can still land
    // inside the cutoff — which is exactly the case drift exists to catch.
    // The report keeps saying what it said, and the pack has to carry the
    // divergence rather than let it go unremarked.
    await createTransaction(
      db, ASSEMBLY_ID,
      {
        accountId: 'acct-bank', occurredOn: '2026-05-05', amountCents: -12_345,
        payee: 'Late invoice', memo: null, method: 'bank', kind: 'expense',
        categoryId: 'cat-rent', fundId: 'fund-local',
      },
      ACTOR, NOW,
    )
    const after = await check('reports-stable')
    expect(after.holds).toBe(false)
    expect(after.detail).toMatch(/Fiḍál|diverge/)
  })

  it('states that money is whole cents', async () => {
    expect((await check('integer-money')).holds).toBe(true)
  })
})

describe('the gaps', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await freshDatabase()
  })

  const gap = async (key: string) => (await pack(db))!.gaps.find((g) => g.key === key)!

  it('counts what the dashboard counts', async () => {
    expect((await gap('uncategorised')).count).toBe(7)
    expect((await gap('no-image')).count).toBe(3)
  })

  it('counts every bank row never proved against a statement', async () => {
    // Over the whole year, not to the last statement date. For an audit the
    // question is what has never been proved, not what is merely in flight.
    const unreconciled = await gap('unreconciled')
    expect(unreconciled.count).toBe(10)
    expect(unreconciled.consequence).toContain('$191.60')
  })

  it('counts the Feast reports still to be presented', async () => {
    // Seven presented in the seed, twelve to go.
    expect((await gap('unpresented')).count).toBe(12)
  })

  it('says a gap of nothing is a gap of nothing', async () => {
    const view = (await pack(db))!
    // Every gap carries a count, so the page can show only what is outstanding
    // without the repo deciding what is worth mentioning.
    expect(view.gaps.every((g) => typeof g.count === 'number')).toBe(true)
    expect(view.gaps).toHaveLength(5)
  })
})

describe('what the package does not contain', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await freshDatabase()
  })

  it('carries no donor name, in plaintext or ciphertext', async () => {
    // The pack does read the donors table — for `is_anonymous`, which is a
    // flag and not an identity. What it must never do is carry a name, so the
    // test puts a real one in the vault and looks for it in the output.
    await setupVault(db, ASSEMBLY_ID, 'correct-horse-battery', ACTOR, NOW)
    const id = await createDonor(
      db, ASSEMBLY_ID,
      { name: 'Ruhiyyih Nakhjavani', contact: 'ruhiyyih@example.org', secret: 'correct-horse-battery' },
      ACTOR, NOW,
    )
    const stored = await db.get<{ name_encrypted: string }>(
      'SELECT name_encrypted FROM donors WHERE id = ?',
      [id],
    )

    const serialised = JSON.stringify(await pack(db))
    expect(serialised).not.toContain('Ruhiyyih')
    expect(serialised).not.toContain('example.org')
    expect(serialised).not.toContain(stored!.name_encrypted)
  })

  it('is drawn without decrypting anything, and the log proves it', async () => {
    await setupVault(db, ASSEMBLY_ID, 'correct-horse-battery', ACTOR, NOW)
    await createDonor(
      db, ASSEMBLY_ID,
      { name: 'Ruhiyyih Nakhjavani', contact: null, secret: 'correct-horse-battery' },
      ACTOR, NOW,
    )
    // Drawing the pack is not an act of looking at donor detail, and the log
    // — which the pack itself prints — is where that claim is checkable.
    const view = (await pack(db))!
    expect(view.donorAccess).toEqual([])
    expect(view.summary.householdCount).toBeGreaterThan(0)
  })

  it('records that no name was decrypted to produce it', async () => {
    const view = (await pack(db))!
    expect(view.donorAccess).toEqual([])
  })
})

describe('the audit API', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await freshDatabase()
  })

  const call = (path: string) =>
    handleApi(new Request(`http://localhost${path}`), {
      db,
      assemblyId: ASSEMBLY_ID,
      actor: 'test',
      today: SEED_TODAY,
      now: NOW,
    })

  it('serves the package for the current year', async () => {
    const response = (await call('/api/audit/current'))!
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json()
    expect(body.bahaiYear).toBe(SEED_YEAR)
    expect(body.preparedBy).toBe('test')
    expect(body.checks).toHaveLength(5)
  })

  it('explains a year outside the Naw-Rúz table rather than crashing', async () => {
    const response = (await call('/api/audit/500'))!
    expect(response.status).toBe(422)
  })
})

describe('a budget that was never approved', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await freshDatabase()
  })

  it('is carried with its status, not quietly presented as adopted', async () => {
    await reopenBudget(db, ASSEMBLY_ID, SEED_YEAR, ACTOR, NOW)
    await setBudgetLine(db, ASSEMBLY_ID, SEED_YEAR, 'cat-rent', 700_000, null, ACTOR, NOW)
    const view = (await pack(db))!
    expect(view.budget.status).toBe('draft')
    expect(view.budget.approvedOn).toBeNull()
  })
})

describe('a book with nothing reconciled', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await freshDatabase()
  })

  it('says the ledger is unproved against the bank', async () => {
    await reopenReconciliation(db, ASSEMBLY_ID, 'rec-acct-bank-2026-08-19', ACTOR, NOW)
    const view = (await pack(db))!
    expect(view.reconciliations.every((r) => r.status === 'open')).toBe(true)
    // Reopening does not untick, so the count is unchanged — what changed is
    // that no statement is balanced, which the reconciliation table shows.
    expect(view.reconciliations).toHaveLength(1)
  })
})
