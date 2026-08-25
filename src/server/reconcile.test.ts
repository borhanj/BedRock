import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from './db/migrate'
import { openNodeDatabase, type NodeSqlDatabase } from './db/node-sqlite'
import {
  completeReconciliation,
  listReconciliations,
  loadReconciliation,
  ReconcileError,
  reconcileStanding,
  reopenReconciliation,
  setCleared,
  setStatement,
  startReconciliation,
} from './repo/reconcile'
import { loadYear } from './repo/year'
import { handleApi } from './api'
import { ASSEMBLY_ID, SEED_TODAY, SEED_YEAR, seed } from './seed'

const ACTOR = 'treasurer@riverbend'
const NOW = '2026-08-28T12:00:00Z'
const SEEDED = 'rec-acct-bank-2026-08-19'

async function freshDatabase(): Promise<NodeSqlDatabase> {
  const db = openNodeDatabase(':memory:')
  await migrate(db)
  await seed(db)
  return db
}

describe('the statement the seed reconciled', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await freshDatabase()
  })

  it('balances to the cent', async () => {
    const view = (await loadReconciliation(db, ASSEMBLY_ID, SEEDED))!
    expect(view.status).toBe('balanced')
    expect(view.differenceCents).toBe(0)
    expect(view.reconciledBalanceCents).toBe(view.statementBalanceCents)
  })

  it('leaves the cheques still in flight outstanding', async () => {
    const view = (await loadReconciliation(db, ASSEMBLY_ID, SEEDED))!
    expect(view.outstandingCount).toBe(2)
    // Both are payments out, so the books hold less than the bank shows.
    expect(view.outstandingCents).toBeLessThan(0)
    expect(view.statementBalanceCents).toBeGreaterThan(0)
  })

  it('clears transactions inside closed, locked periods', async () => {
    // The whole reason clearing lives in its own table. Months 1–7 are
    // presented and their rows are locked; the bank still processed them.
    const locked = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n
         FROM reconciliation_items i
         JOIN transactions t ON t.id = i.transaction_id
        WHERE t.is_locked = 1`,
    )
    expect(locked!.n).toBeGreaterThan(0)
  })
})

describe('reconciling a statement', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await freshDatabase()
  })

  /** A statement covering everything to date, at the true book balance. */
  const startTrue = async (offsetCents = 0) => {
    const truth = await db.get<{ cents: number }>(
      `SELECT (SELECT opening_balance_cents FROM accounts WHERE id = 'acct-bank')
            + COALESCE((SELECT SUM(amount_cents) FROM transactions
                         WHERE account_id = 'acct-bank' AND occurred_on <= '2026-08-28'), 0)
              AS cents`,
    )
    return startReconciliation(
      db, ASSEMBLY_ID,
      {
        accountId: 'acct-bank',
        statementEndedOn: '2026-08-28',
        statementBalanceCents: truth!.cents + offsetCents,
      },
      ACTOR, NOW,
    )
  }

  it('opens with only the rows no statement has claimed', async () => {
    const view = await startTrue()
    // The two cheques left outstanding by the seeded statement, plus whatever
    // has happened since it ended.
    expect(view.items.length).toBeGreaterThanOrEqual(2)
    expect(view.items.every((i) => !i.isCleared)).toBe(true)
    // An outstanding cheque from an earlier month is a candidate here, which
    // is the point: it is exactly what turns up on a later statement.
    expect(view.items.some((i) => i.occurredOn < '2026-08-19')).toBe(true)
  })

  it('counts what earlier statements already cleared', async () => {
    const view = await startTrue()
    expect(view.clearedEarlierCents).not.toBe(0)
    expect(view.reconciledBalanceCents).toBe(view.openingCents + view.clearedEarlierCents)
  })

  it('closes the difference as rows are ticked', async () => {
    let view = await startTrue()
    expect(view.differenceCents).not.toBe(0)

    for (const item of view.items) {
      view = (await setCleared(db, ASSEMBLY_ID, view.id, item.id, true, ACTOR, NOW))!
    }
    expect(view.differenceCents).toBe(0)
    expect(view.outstandingCount).toBe(0)
  })

  it('unticks again, and the difference comes back', async () => {
    let view = await startTrue()
    const first = view.items[0]
    view = (await setCleared(db, ASSEMBLY_ID, view.id, first.id, true, ACTOR, NOW))!
    expect(view.clearedHereCents).toBe(first.amountCents)
    view = (await setCleared(db, ASSEMBLY_ID, view.id, first.id, false, ACTOR, NOW))!
    expect(view.clearedHereCents).toBe(0)
  })

  it('refuses to balance while anything is unexplained', async () => {
    const view = await startTrue()
    await expect(
      completeReconciliation(db, ASSEMBLY_ID, view.id, ACTOR, NOW),
    ).rejects.toThrow(ReconcileError)
  })

  it('names the amount when it refuses, because the amount is the clue', async () => {
    let view = await startTrue()
    for (const item of view.items) {
      view = (await setCleared(db, ASSEMBLY_ID, view.id, item.id, true, ACTOR, NOW))!
    }
    // Now put the statement $9.00 out — the classic transposed digits.
    view = (await setStatement(db, ASSEMBLY_ID, view.id, '2026-08-28',
      view.statementBalanceCents + 900, ACTOR, NOW))!
    await expect(
      completeReconciliation(db, ASSEMBLY_ID, view.id, ACTOR, NOW),
    ).rejects.toThrow(/differ by \$9\.00/)
  })

  it('offers no way to force a balance', async () => {
    // There is no adjustment entry in this module, on purpose. The only route
    // to zero is ticking rows or correcting the statement figure.
    const view = await startTrue()
    const surface = Object.keys(await import('./repo/reconcile'))
    expect(surface.some((k) => /adjust|plug|force/i.test(k))).toBe(false)
    expect(view.differenceCents).not.toBe(0)
  })

  it('balances at exactly zero, and records who said so', async () => {
    let view = await startTrue()
    for (const item of view.items) {
      view = (await setCleared(db, ASSEMBLY_ID, view.id, item.id, true, ACTOR, NOW))!
    }
    view = (await completeReconciliation(db, ASSEMBLY_ID, view.id, ACTOR, NOW))!
    expect(view.status).toBe('balanced')
    expect(view.completedBy).toBe(ACTOR)
  })
})

describe('a transaction clears once', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await freshDatabase()
  })

  it('refuses to tick a row another statement has already cleared', async () => {
    const cleared = await db.get<{ transaction_id: string }>(
      'SELECT transaction_id FROM reconciliation_items LIMIT 1',
    )
    const view = await startReconciliation(
      db, ASSEMBLY_ID,
      { accountId: 'acct-bank', statementEndedOn: '2026-09-18', statementBalanceCents: 1 },
      ACTOR, NOW,
    )
    await expect(
      setCleared(db, ASSEMBLY_ID, view.id, cleared!.transaction_id, true, ACTOR, NOW),
    ).rejects.toThrow(/cannot clear twice/)
  })

  it('refuses a raw double-tick too', async () => {
    const cleared = await db.get<{ transaction_id: string }>(
      'SELECT transaction_id FROM reconciliation_items LIMIT 1',
    )
    await expect(
      db.run(
        `INSERT INTO reconciliation_items (reconciliation_id, transaction_id, cleared_on)
         VALUES ('rec-other', ?, '2026-09-18')`,
        [cleared!.transaction_id],
      ),
    ).rejects.toThrow()
  })

  it('refuses a transaction on a different account', async () => {
    const view = await startReconciliation(
      db, ASSEMBLY_ID,
      { accountId: 'acct-bank', statementEndedOn: '2026-09-18', statementBalanceCents: 1 },
      ACTOR, NOW,
    )
    const cash = await db.get<{ id: string }>(
      "SELECT id FROM transactions WHERE account_id = 'acct-cash' LIMIT 1",
    )
    await expect(
      setCleared(db, ASSEMBLY_ID, view.id, cash!.id, true, ACTOR, NOW),
    ).rejects.toThrow(/not on this account/)
  })
})

describe('a balanced reconciliation holds still', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await freshDatabase()
  })

  it('refuses a tick, a statement change and a second balancing', async () => {
    const untickable = await db.get<{ transaction_id: string }>(
      'SELECT transaction_id FROM reconciliation_items LIMIT 1',
    )
    await expect(
      setCleared(db, ASSEMBLY_ID, SEEDED, untickable!.transaction_id, false, ACTOR, NOW),
    ).rejects.toThrow(/Reopen it/)
    await expect(
      setStatement(db, ASSEMBLY_ID, SEEDED, '2026-08-19', 1, ACTOR, NOW),
    ).rejects.toThrow(/Reopen it/)
    await expect(
      completeReconciliation(db, ASSEMBLY_ID, SEEDED, ACTOR, NOW),
    ).rejects.toThrow(/already balanced/)
  })

  it('refuses a raw SQL untick, and refuses deletion', async () => {
    await expect(
      db.run('DELETE FROM reconciliation_items WHERE reconciliation_id = ?', [SEEDED]),
    ).rejects.toThrow(/balanced/)
    await expect(
      db.run('DELETE FROM reconciliations WHERE id = ?', [SEEDED]),
    ).rejects.toThrow(/cannot be deleted/)
  })

  it('reopens, and can be changed again', async () => {
    const view = (await reopenReconciliation(db, ASSEMBLY_ID, SEEDED, ACTOR, NOW))!
    expect(view.status).toBe('open')
    expect(view.completedAt).toBeNull()
    const changed = (await setStatement(
      db, ASSEMBLY_ID, SEEDED, '2026-08-19', view.statementBalanceCents, ACTOR, NOW,
    ))!
    expect(changed.differenceCents).toBe(0)
  })

  it('refuses to reopen one that is already open', async () => {
    await reopenReconciliation(db, ASSEMBLY_ID, SEEDED, ACTOR, NOW)
    await expect(
      reopenReconciliation(db, ASSEMBLY_ID, SEEDED, ACTOR, NOW),
    ).rejects.toThrow(/already open/)
  })
})

describe('starting one', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await freshDatabase()
  })

  it('refuses a second statement for the same account and date', async () => {
    await expect(
      startReconciliation(
        db, ASSEMBLY_ID,
        { accountId: 'acct-bank', statementEndedOn: '2026-08-19', statementBalanceCents: 1 },
        ACTOR, NOW,
      ),
    ).rejects.toThrow(/already been started/)
  })

  it('accepts an overdrawn closing balance', async () => {
    // A statement can legitimately end negative; that is a fact to reconcile,
    // not an input error.
    const view = await startReconciliation(
      db, ASSEMBLY_ID,
      { accountId: 'acct-bank', statementEndedOn: '2026-09-18', statementBalanceCents: -5_000 },
      ACTOR, NOW,
    )
    expect(view.statementBalanceCents).toBe(-5_000)
  })

  it('refuses a fraction of a cent and an unknown account', async () => {
    await expect(
      startReconciliation(
        db, ASSEMBLY_ID,
        { accountId: 'acct-bank', statementEndedOn: '2026-09-18', statementBalanceCents: 1.5 },
        ACTOR, NOW,
      ),
    ).rejects.toThrow(/whole number of cents/)
    await expect(
      startReconciliation(
        db, ASSEMBLY_ID,
        { accountId: 'acct-elsewhere', statementEndedOn: '2026-09-18', statementBalanceCents: 1 },
        ACTOR, NOW,
      ),
    ).rejects.toThrow(/No such account/)
  })

  it('lists statements newest first', async () => {
    await startReconciliation(
      db, ASSEMBLY_ID,
      { accountId: 'acct-bank', statementEndedOn: '2026-09-18', statementBalanceCents: 1 },
      ACTOR, NOW,
    )
    const list = await listReconciliations(db, ASSEMBLY_ID)
    expect(list).toHaveLength(2)
    expect(list[0].statementEndedOn).toBe('2026-09-18')
    expect(list[1].status).toBe('balanced')
    expect(list[1].differenceCents).toBe(0)
  })
})

describe('the dashboard worklist row', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await freshDatabase()
  })

  it('counts what has not cleared as at the last balanced statement', async () => {
    const standing = await reconcileStanding(db, ASSEMBLY_ID)
    expect(standing.lastBalancedOn).toBe('2026-08-19')
    expect(standing.unclearedCount).toBe(2)

    const year = await loadYear(db, ASSEMBLY_ID, SEED_YEAR, SEED_TODAY)
    const row = year.attention.find((a) => a.key === 'unreconciled')!
    expect(row.count).toBe(2)
    expect(row.tone).toBeUndefined()
    expect(row.href).toBe('/ledger/reconcile')
  })

  it('says the check has never run rather than claiming a zero', async () => {
    // Reopening the only balanced statement leaves nothing ever proved.
    await reopenReconciliation(db, ASSEMBLY_ID, SEEDED, ACTOR, NOW)

    const standing = await reconcileStanding(db, ASSEMBLY_ID)
    expect(standing.lastBalancedOn).toBeNull()

    const year = await loadYear(db, ASSEMBLY_ID, SEED_YEAR, SEED_TODAY)
    const row = year.attention.find((a) => a.key === 'unreconciled')!
    expect(row.tone).toBe('unknown')
    expect(row.label).toMatch(/never been reconciled/)
    // A zero that must not be read as "nothing to find".
    expect(row.count).toBe(0)
    expect(row.resolvedLabel).toBeUndefined()
  })

  it('gives every worklist row somewhere to go', async () => {
    const year = await loadYear(db, ASSEMBLY_ID, SEED_YEAR, SEED_TODAY)
    expect(year.attention).toHaveLength(4)
    expect(year.attention.every((a) => a.href.startsWith('/'))).toBe(true)
  })
})

describe('the reconciliation API', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await freshDatabase()
  })

  const call = (path: string, init?: RequestInit) =>
    handleApi(new Request(`http://localhost${path}`, init), {
      db,
      assemblyId: ASSEMBLY_ID,
      actor: 'test',
      today: SEED_TODAY,
      now: NOW,
    })

  it('lists, and serves one', async () => {
    const list = (await call('/api/reconcile'))!
    expect(list.status).toBe(200)
    expect((await list.json())).toHaveLength(1)

    const one = (await call(`/api/reconcile/${SEEDED}`))!
    expect((await one.json()).differenceCents).toBe(0)
  })

  it('404s a statement that does not exist', async () => {
    expect((await call('/api/reconcile/rec-nope'))!.status).toBe(404)
  })

  it('starts one', async () => {
    const response = (await call('/api/reconcile', {
      method: 'POST',
      body: JSON.stringify({
        accountId: 'acct-bank',
        statementEndedOn: '2026-09-18',
        statementBalanceCents: 400_000,
      }),
    }))!
    expect(response.status).toBe(201)
    expect((await response.json()).status).toBe('open')
  })

  it('answers 409 when asked to balance an unexplained difference', async () => {
    await call('/api/reconcile', {
      method: 'POST',
      body: JSON.stringify({
        accountId: 'acct-bank',
        statementEndedOn: '2026-09-18',
        statementBalanceCents: 400_000,
      }),
    })
    const response = (await call('/api/reconcile/rec-acct-bank-2026-09-18/complete', {
      method: 'POST',
      body: '{}',
    }))!
    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatch(/differ by/)
  })
})
