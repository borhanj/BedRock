import { beforeEach, describe, expect, it } from 'vitest'
import { sumCents } from '../lib/money'
import { setAuditActor } from './db/adapter'
import { migrate } from './db/migrate'
import { openNodeDatabase, type NodeSqlDatabase } from './db/node-sqlite'
import {
  loadFundLedger,
  loadFunds,
  onHand,
  recordRemittance,
  RemittanceError,
} from './repo/funds'
import { loadYear } from './repo/year'
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

describe('the fund partition', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await freshDatabase()
  })

  it('sums to everything on hand', async () => {
    const view = await loadFunds(db, ASSEMBLY_ID, SEED_YEAR)
    expect(sumCents(view.funds.map((f) => f.balanceCents))).toBe(view.onHandCents)
    expect(view.onHandCents).toBe(517_240)
  })

  it('shows the same figures as the dashboard card', async () => {
    // Not "agrees with" — it is the same function. This test is what keeps it
    // that way if someone later writes a second query for one of the screens.
    const funds = await loadFunds(db, ASSEMBLY_ID, SEED_YEAR)
    const year = await loadYear(db, ASSEMBLY_ID, SEED_YEAR, SEED_TODAY)
    expect(funds.funds.map((f) => [f.key, f.balanceCents])).toEqual(
      year.funds.map((f) => [f.key, f.balanceCents]),
    )
  })

  it('reproduces the balances the design prints', async () => {
    const view = await loadFunds(db, ASSEMBLY_ID, SEED_YEAR)
    const by = new Map(view.funds.map((f) => [f.key, f.balanceCents]))
    expect(by.get('local')).toBe(418_290)
    expect(by.get('national')).toBe(62_500)
    expect(by.get('continental')).toBe(15_000)
    expect(by.get('cash')).toBe(21_450)
  })

  it('holds a pass-through fund at contributions less remittances', async () => {
    const view = await loadFunds(db, ASSEMBLY_ID, SEED_YEAR)
    const national = view.funds.find((f) => f.key === 'national')!
    expect(national.receivedCents - national.forwardedCents).toBe(national.balanceCents)
    expect(national.spentCents).toBe(0)
  })

  it('counts a cash gift to another fund once, not twice', async () => {
    // The cash box is a place, the National Fund is an owner, and a National
    // Fund note in the tin belongs to both. Counted in both rows it would be
    // double-counted, and the Local Fund — being the residual — would show a
    // $75 shortfall that never happened.
    const before = await loadFunds(db, ASSEMBLY_ID, SEED_YEAR)
    const local = before.funds.find((f) => f.key === 'local')!.balanceCents

    await setAuditActor(db, ACTOR)
    await db.run(
      `INSERT INTO transactions
         (id, assembly_id, account_id, fund_id, category_id, occurred_on, amount_cents,
          payee, memo, method, source, kind, dedupe_hash, is_locked, created_at, updated_at)
       VALUES ('txn-tin', ?, 'acct-cash', 'fund-national', NULL, '2026-08-25', 7500,
               'Cash at Feast', NULL, 'cash', 'cash', 'contribution', NULL, 0, ?, ?)`,
      [ASSEMBLY_ID, NOW, NOW],
    )
    await db.run(
      `INSERT INTO contributions
         (id, assembly_id, transaction_id, donor_id, fund_id, amount_cents, receipt_id)
       VALUES ('con-tin', ?, 'txn-tin', NULL, 'fund-national', 7500, NULL)`,
      [ASSEMBLY_ID],
    )

    const after = await loadFunds(db, ASSEMBLY_ID, SEED_YEAR)
    const by = new Map(after.funds.map((f) => [f.key, f.balanceCents]))
    expect(by.get('national')).toBe(70_000)
    // The tin is $75 heavier, but none of it is the Assembly's.
    expect(by.get('cash')).toBe(21_450)
    expect(by.get('local')).toBe(local)
    expect(sumCents(after.funds.map((f) => f.balanceCents))).toBe(after.onHandCents)
  })
})

describe('a fund sub-ledger', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await freshDatabase()
  })

  it('runs the balance forward to what the fund holds', async () => {
    const ledger = (await loadFundLedger(db, ASSEMBLY_ID, 'national', SEED_YEAR))!
    const funds = await loadFunds(db, ASSEMBLY_ID, SEED_YEAR)
    const national = funds.funds.find((f) => f.key === 'national')!
    expect(ledger.closingCents).toBe(national.balanceCents)
    expect(ledger.entries.at(-1)!.balanceCents).toBe(ledger.closingCents)
  })

  it('opens at nothing in the first year the fund saw money', async () => {
    const ledger = (await loadFundLedger(db, ASSEMBLY_ID, 'national', SEED_YEAR))!
    expect(ledger.openingCents).toBe(0)
  })

  it('rolls a deposit up to one line rather than one per gift', async () => {
    // Kamál's National Fund deposit is six gifts in one bank line, and the
    // sub-ledger has to read beside the bank statement.
    const ledger = (await loadFundLedger(db, ASSEMBLY_ID, 'national', SEED_YEAR))!
    const received = ledger.entries.filter((e) => e.movement === 'received')
    expect(received).toHaveLength(9)
    expect(received.some((e) => e.amountCents === 42_500)).toBe(true)
  })

  it('shows what was forwarded as money leaving the fund', async () => {
    const ledger = (await loadFundLedger(db, ASSEMBLY_ID, 'national', SEED_YEAR))!
    const forwarded = ledger.entries.filter((e) => e.movement === 'forwarded')
    expect(forwarded).toHaveLength(3)
    expect(sumCents(forwarded.map((e) => e.amountCents))).toBe(-105_000)
    expect(forwarded[0].description).toContain('NF-2026-0417')
  })

  it('charges expenses to the Local Fund, including unassigned ones', async () => {
    const ledger = (await loadFundLedger(db, ASSEMBLY_ID, 'local', SEED_YEAR))!
    const spent = ledger.entries.filter((e) => e.movement === 'spent')
    // Every expense row in the seed, the five uncategorised ones included.
    expect(spent).toHaveLength(52)
    expect(spent.every((e) => e.amountCents < 0)).toBe(true)
  })

  it('returns null for a fund that does not exist', async () => {
    expect(await loadFundLedger(db, ASSEMBLY_ID, 'endowment', SEED_YEAR)).toBeNull()
  })
})

describe('forwarding money upward', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await freshDatabase()
  })

  it('writes the withdrawal and the discharge together', async () => {
    const before = await onHand(db, ASSEMBLY_ID)

    const remittance = await recordRemittance(
      db, ASSEMBLY_ID,
      {
        fundKey: 'national',
        accountId: 'acct-bank',
        sentOn: '2026-08-26',
        amountCents: 40_000,
        reference: 'NF-2026-0826',
      },
      ACTOR, NOW,
    )

    // The account is lighter and the fund is discharged, by the same amount.
    expect(await onHand(db, ASSEMBLY_ID)).toBe(before - 40_000)
    const view = await loadFunds(db, ASSEMBLY_ID, SEED_YEAR)
    expect(view.funds.find((f) => f.key === 'national')!.balanceCents).toBe(22_500)

    const txn = await db.get<{ amount_cents: number; kind: string }>(
      'SELECT amount_cents, kind FROM transactions WHERE id = ?',
      [remittance.transactionId!],
    )
    expect(txn!.amount_cents).toBe(-40_000)
    expect(txn!.kind).toBe('remittance')
  })

  it('keeps the partition footing afterwards', async () => {
    await recordRemittance(
      db, ASSEMBLY_ID,
      { fundKey: 'national', accountId: 'acct-bank', sentOn: '2026-08-26', amountCents: 40_000, reference: null },
      ACTOR, NOW,
    )
    const view = await loadFunds(db, ASSEMBLY_ID, SEED_YEAR)
    expect(sumCents(view.funds.map((f) => f.balanceCents))).toBe(view.onHandCents)
  })

  it('records who forwarded it', async () => {
    const remittance = await recordRemittance(
      db, ASSEMBLY_ID,
      { fundKey: 'continental', accountId: 'acct-bank', sentOn: '2026-08-26', amountCents: 5_000, reference: 'CF-1' },
      ACTOR, NOW,
    )
    const logged = await db.get<{ actor: string }>(
      "SELECT actor FROM audit_log WHERE entity = 'remittances' AND entity_id = ?",
      [remittance.id],
    )
    expect(logged!.actor).toBe(ACTOR)
  })

  it('refuses to forward more than the fund holds', async () => {
    // The National Fund holds $625.00 in the seed.
    await expect(
      recordRemittance(
        db, ASSEMBLY_ID,
        { fundKey: 'national', accountId: 'acct-bank', sentOn: '2026-08-26', amountCents: 62_501, reference: null },
        ACTOR, NOW,
      ),
    ).rejects.toThrow(RemittanceError)

    // And nothing was written on the way to refusing.
    const view = await loadFunds(db, ASSEMBLY_ID, SEED_YEAR)
    expect(view.funds.find((f) => f.key === 'national')!.balanceCents).toBe(62_500)
  })

  it('allows forwarding the whole outstanding balance', async () => {
    await recordRemittance(
      db, ASSEMBLY_ID,
      { fundKey: 'national', accountId: 'acct-bank', sentOn: '2026-08-26', amountCents: 62_500, reference: null },
      ACTOR, NOW,
    )
    const view = await loadFunds(db, ASSEMBLY_ID, SEED_YEAR)
    expect(view.funds.find((f) => f.key === 'national')!.balanceCents).toBe(0)
    expect(view.owedUpwardCents).toBe(15_000)
  })

  it('refuses the Local Fund, which is not held for anyone else', async () => {
    await expect(
      recordRemittance(
        db, ASSEMBLY_ID,
        { fundKey: 'local', accountId: 'acct-bank', sentOn: '2026-08-26', amountCents: 1_000, reference: null },
        ACTOR, NOW,
      ),
    ).rejects.toThrow(/own money/)
  })

  it('refuses a zero, a negative and a fraction of a cent', async () => {
    for (const amountCents of [0, -100, 12.5]) {
      await expect(
        recordRemittance(
          db, ASSEMBLY_ID,
          { fundKey: 'national', accountId: 'acct-bank', sentOn: '2026-08-26', amountCents, reference: null },
          ACTOR, NOW,
        ),
      ).rejects.toThrow(RemittanceError)
    }
  })

  it('refuses an account that is not the Assembly’s', async () => {
    await expect(
      recordRemittance(
        db, ASSEMBLY_ID,
        { fundKey: 'national', accountId: 'acct-elsewhere', sentOn: '2026-08-26', amountCents: 1_000, reference: null },
        ACTOR, NOW,
      ),
    ).rejects.toThrow(/No such account/)
  })

  it('lists what was forwarded this year, newest first', async () => {
    const view = await loadFunds(db, ASSEMBLY_ID, SEED_YEAR)
    expect(view.remittances).toHaveLength(4)
    expect(view.remittances[0].sentOn >= view.remittances[1].sentOn).toBe(true)
    expect(sumCents(view.remittances.map((r) => r.amountCents))).toBe(120_000)
  })
})

describe('the funds API', () => {
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

  it('serves the funds for the current year', async () => {
    const response = (await call('/api/funds/current'))!
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.bahaiYear).toBe(SEED_YEAR)
    expect(body.owedUpwardCents).toBe(77_500)
  })

  it('serves one fund’s sub-ledger, and 404s one that does not exist', async () => {
    const ok = (await call('/api/funds/183/national'))!
    expect(ok.status).toBe(200)
    expect((await ok.json()).label).toBe('National Fund')

    const missing = (await call('/api/funds/183/endowment'))!
    expect(missing.status).toBe(404)
  })

  it('records a remittance', async () => {
    const response = (await call('/api/remittances', {
      method: 'POST',
      body: JSON.stringify({
        fundKey: 'continental',
        accountId: 'acct-bank',
        sentOn: '2026-08-26',
        amountCents: 10_000,
        reference: 'CF-2026-0826',
      }),
    }))!
    expect(response.status).toBe(201)
    expect((await response.json()).amountCents).toBe(10_000)
  })

  it('answers 409 when more is forwarded than is held', async () => {
    const response = (await call('/api/remittances', {
      method: 'POST',
      body: JSON.stringify({
        fundKey: 'continental',
        accountId: 'acct-bank',
        sentOn: '2026-08-26',
        amountCents: 100_000,
        reference: null,
      }),
    }))!
    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatch(/cannot be forwarded/)
  })

  it('answers 400 when the fund is not named', async () => {
    const response = (await call('/api/remittances', {
      method: 'POST',
      body: JSON.stringify({ accountId: 'acct-bank', amountCents: 100 }),
    }))!
    expect(response.status).toBe(400)
  })
})
