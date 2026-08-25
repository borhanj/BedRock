import { beforeEach, describe, expect, it } from 'vitest'
import { bahaiYear as bahaiYearFor } from '../calendar/badi'
import { sumCents } from '../lib/money'
import { migrate } from './db/migrate'
import { openNodeDatabase, type NodeSqlDatabase } from './db/node-sqlite'
import {
  loadCheckpoints,
  loadOpeningPosition,
  resolveUnexplained,
  restateOpening,
} from './repo/opening'
import {
  setUpAssembly,
  setupStatus,
  SUGGESTED_FUNDS,
  type SetupRequest,
} from './repo/setup'
import { loadFunds, recordRemittance } from './repo/funds'
import { commitImport, previewImport } from './repo/import'
import { loadAuditPackage } from './repo/audit'
import type { ColumnMapping } from './import/mapping'
import { loadYear } from './repo/year'
import { exportEverything } from './repo/handoff'
import { restore } from './repo/restore'
import { handleApi } from './api'

const ID = 'riverbend'
const ACTOR = 'treasurer@riverbend'
const NOW = '2026-08-28T12:00:00Z'
const TODAY = '2026-08-28'
const OPENED = '2026-08-01'
const YEAR = bahaiYearFor(TODAY)

/** A deployment with the schema and nothing in it — a first install. */
async function fresh(): Promise<NodeSqlDatabase> {
  const db = openNodeDatabase(':memory:')
  await migrate(db)
  return db
}

const FUNDS = [
  { key: 'local', label: 'Local Fund', isPassthrough: false },
  { key: 'national', label: 'National Fund', isPassthrough: true },
]

/**
 * The awkward case, and the ordinary one.
 *
 * The bank says $4,312.18 and the tin holds $87.50, so $4,399.68 is on hand.
 * The page from the outgoing treasurer says the Local Fund holds $4,000 and
 * the National Fund $250 — $4,250. Nobody can say what the other $149.68 is.
 */
const BANK_CENTS = 431_218
const CASH_CENTS = 8_750
const ON_HAND = BANK_CENTS + CASH_CENTS
const DECLARED_LOCAL = 400_000
const DECLARED_NATIONAL = 25_000
const GAP = ON_HAND - DECLARED_LOCAL - DECLARED_NATIONAL
/** The Local Fund on 1 July: its 1 August figure, back across the July rows. */
const RESTATED_LOCAL = DECLARED_LOCAL - 12_000 + 35_000

const REQUEST: SetupRequest = {
  assemblyName: 'Riverbend Local Spiritual Assembly',
  shortName: 'Riverbend',
  openedOn: OPENED,
  funds: FUNDS,
  accounts: [
    { name: 'Community Credit Union', kind: 'bank' as const, openingBalanceCents: BANK_CENTS },
    { name: 'Cash box', kind: 'cash' as const, openingBalanceCents: CASH_CENTS },
  ],
  categories: [
    { label: 'Local Fund contributions', kind: 'income' as const, fundKey: 'local' },
    { label: 'Rent / facility use', kind: 'expense' as const },
  ],
  declared: { local: DECLARED_LOCAL, national: DECLARED_NATIONAL },
  declaredBy: 'outgoing@riverbend',
}

const open = (db: NodeSqlDatabase, overrides: Partial<typeof REQUEST> = {}) =>
  setUpAssembly(db, ID, { ...REQUEST, ...overrides }, ACTOR, NOW)

describe('a deployment with no books in it', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await fresh()
  })

  it('says so, rather than failing', async () => {
    const status = await setupStatus(db, ID)
    expect(status.isSetUp).toBe(false)
    expect(status.openedOn).toBeNull()
  })

  // The route has to answer before there is an Assembly, because it is how the
  // browser knows to offer setup instead of a dashboard of nothing. Every
  // other route 404s or 500s here, which is correct for them and useless as a
  // signal.
  it('answers GET /api/setup where the rest of the API cannot', async () => {
    const ctx = { db, assemblyId: ID, actor: ACTOR, today: TODAY, now: NOW }
    const setup = await handleApi(new Request('http://x/api/setup'), ctx)
    expect(setup?.status).toBe(200)

    const year = await handleApi(new Request('http://x/api/year/current'), ctx)
    expect(year?.status).toBe(500)
  })

  it('suggests funds without creating any', async () => {
    const status = await setupStatus(db, ID)
    expect(status.suggestedFunds).toBe(SUGGESTED_FUNDS)
    const funds = await db.all('SELECT id FROM funds')
    expect(funds).toHaveLength(0)
  })
})

describe('opening the books', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await fresh()
  })

  it('leaves a dashboard that loads', async () => {
    await open(db)
    const year = await loadYear(db, ID, YEAR, TODAY)
    expect(year.onHandTodayCents).toBe(ON_HAND)
  })

  it('carries what the funds were declared to hold', async () => {
    const result = await open(db)
    expect(result.onHandCents).toBe(ON_HAND)
    expect(result.declaredCents).toBe(DECLARED_LOCAL + DECLARED_NATIONAL)
    expect(result.unexplainedCents).toBe(GAP)
  })

  it('refuses to open over books that already exist', async () => {
    await open(db)
    await expect(open(db)).rejects.toThrow(/already exist/)
  })

  // Structural, not a preference. loadFundBalances derives the Assembly's own
  // balance as the residual of the partition, so a second fund marked the same
  // way would never appear in it and its money would be silently absorbed by
  // the first. There is no error a treasurer could see afterwards.
  it('refuses two funds that are both the Assembly’s own', async () => {
    await expect(
      open(db, {
        funds: [
          { key: 'local', label: 'Local Fund', isPassthrough: false },
          { key: 'building', label: 'Building Fund', isPassthrough: false },
        ],
      }),
    ).rejects.toThrow(/Only one fund can be the Assembly's own/)
  })

  it('refuses an Assembly with no fund of its own', async () => {
    await expect(
      open(db, { funds: [{ key: 'national', label: 'National Fund', isPassthrough: true }] }),
    ).rejects.toThrow(/has to be the Assembly’s own/)
  })

  it('refuses somewhere with no money in it at all', async () => {
    await expect(open(db, { accounts: [] })).rejects.toThrow(/somewhere to keep money/)
  })

  it('refuses to open without saying what the Assembly’s own fund holds', async () => {
    await expect(open(db, { declared: { national: DECLARED_NATIONAL } })).rejects.toThrow(
      /Say what the Local Fund held as well/,
    )
  })

  it('refuses a balance declared for a fund that is not there', async () => {
    await expect(
      open(db, { declared: { local: 100, imaginary: 500 } }),
    ).rejects.toThrow(/not a fund here/)
  })

  it('writes nothing at all when it refuses', async () => {
    await expect(open(db, { accounts: [] })).rejects.toThrow()
    expect(await db.all('SELECT id FROM assemblies')).toHaveLength(0)
    expect(await db.all('SELECT id FROM funds')).toHaveLength(0)
  })
})

describe('the difference between what is on hand and what the funds claim', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await fresh()
    await open(db)
  })

  it('is carried under its own name, not absorbed by the Local Fund', async () => {
    const view = await loadFunds(db, ID, YEAR)
    const unexplained = view.funds.find((f) => f.key === 'unexplained')
    expect(unexplained?.balanceCents).toBe(GAP)
  })

  // The property the card exists to have. If the rows do not sum to what is on
  // hand, the dashboard is lying about where the money is.
  it('leaves the partition summing to what is on hand', async () => {
    const view = await loadFunds(db, ID, YEAR)
    expect(sumCents(view.funds.map((f) => f.balanceCents))).toBe(view.onHandCents)
    expect(view.onHandCents).toBe(ON_HAND)
  })

  // The declared Local figure is split across two rows by the partition — the
  // part in the bank and the part in the tin — and has to survive the split.
  it('leaves the Local Fund holding exactly what was declared for it', async () => {
    const view = await loadFunds(db, ID, YEAR)
    const local = view.funds.find((f) => f.key === 'local')!
    const cash = view.funds.find((f) => f.key === 'cash')!
    expect(local.balanceCents + cash.balanceCents).toBe(DECLARED_LOCAL)
  })

  it('is absent, not zero, when the figures agreed', async () => {
    const clean = await fresh()
    await open(clean, {
      accounts: [
        { name: 'Bank', kind: 'bank' as const, openingBalanceCents: 100_000 },
      ],
      declared: { local: 75_000, national: 25_000 },
    })
    const view = await loadFunds(clean, ID, YEAR)
    expect(view.funds.map((f) => f.key)).not.toContain('unexplained')
    expect(sumCents(view.funds.map((f) => f.balanceCents))).toBe(view.onHandCents)
  })

  // Both signs happen and they mean opposite things. Positive is money nobody
  // has accounted for; negative is money that was earmarked and is not there.
  it('says which way round it is', async () => {
    const short = await fresh()
    const result = await open(short, {
      accounts: [{ name: 'Bank', kind: 'bank' as const, openingBalanceCents: 100_000 }],
      declared: { local: 90_000, national: 25_000 },
    })
    expect(result.unexplainedCents).toBe(-15_000)
    const view = await loadFunds(short, ID, YEAR)
    expect(view.funds.find((f) => f.key === 'unexplained')?.balanceCents).toBe(-15_000)
  })
})

describe('money a pass-through fund held before these books existed', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await fresh()
    await open(db)
  })

  // The bug this whole table was added for. Forwarding refuses to send more
  // than a fund holds, and a fund's balance used to be built only from
  // contributions recorded here — so the first time a new Assembly forwarded
  // money it had received before installing Bedrock, it was told it had never
  // received it.
  it('can be forwarded upward', async () => {
    const account = await db.get<{ id: string }>(
      "SELECT id FROM accounts WHERE assembly_id = ? AND kind = 'bank'",
      [ID],
    )
    const remittance = await recordRemittance(
      db, ID,
      {
        fundKey: 'national',
        accountId: account!.id,
        sentOn: TODAY,
        amountCents: DECLARED_NATIONAL,
        reference: 'cheque 1041',
      },
      ACTOR, NOW,
    )
    expect(remittance.amountCents).toBe(DECLARED_NATIONAL)

    const view = await loadFunds(db, ID, YEAR)
    expect(view.funds.find((f) => f.key === 'national')?.balanceCents).toBe(0)
    expect(sumCents(view.funds.map((f) => f.balanceCents))).toBe(view.onHandCents)
  })

  it('still cannot be over-forwarded', async () => {
    const account = await db.get<{ id: string }>(
      "SELECT id FROM accounts WHERE assembly_id = ? AND kind = 'bank'",
      [ID],
    )
    await expect(
      recordRemittance(
        db, ID,
        {
          fundKey: 'national',
          accountId: account!.id,
          sentOn: TODAY,
          amountCents: DECLARED_NATIONAL + 1,
          reference: null,
        },
        ACTOR, NOW,
      ),
    ).rejects.toThrow()
  })
})

describe('accounting for the difference later', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await fresh()
    await open(db)
  })

  const resolve = (over: Partial<Parameters<typeof resolveUnexplained>[2]> = {}) =>
    resolveUnexplained(
      db, ID,
      {
        amountCents: GAP,
        toFundKey: null,
        reason: 'Assembly minuted 12 Kamál: an unrecorded deposit, treated as Local Fund.',
        decidedBy: 'the Assembly, minuted 12 Kamál',
        occurredOn: TODAY,
        ...over,
      },
      ACTOR, NOW,
    )

  it('moves it to the Local Fund without a row of its own', async () => {
    const before = await loadFunds(db, ID, YEAR)
    const localBefore = before.funds.find((f) => f.key === 'local')!.balanceCents

    const position = await resolve()
    expect(position.unexplainedCents).toBe(0)

    const after = await loadFunds(db, ID, YEAR)
    expect(after.funds.map((f) => f.key)).not.toContain('unexplained')
    expect(after.funds.find((f) => f.key === 'local')!.balanceCents).toBe(localBefore + GAP)
    expect(sumCents(after.funds.map((f) => f.balanceCents))).toBe(after.onHandCents)
  })

  it('moves it to a pass-through fund when that is the decision', async () => {
    await resolve({ toFundKey: 'national' })

    const after = await loadFunds(db, ID, YEAR)
    expect(after.funds.find((f) => f.key === 'national')!.balanceCents).toBe(
      DECLARED_NATIONAL + GAP,
    )
    expect(sumCents(after.funds.map((f) => f.balanceCents))).toBe(after.onHandCents)
  })

  // An Assembly that finds the missing deposit and still cannot explain the
  // rest should be able to record the part it knows.
  it('takes part of it', async () => {
    const position = await resolve({ amountCents: 12_000 })
    expect(position.unexplainedCents).toBe(GAP - 12_000)

    const view = await loadFunds(db, ID, YEAR)
    expect(view.funds.find((f) => f.key === 'unexplained')?.balanceCents).toBe(GAP - 12_000)
    expect(sumCents(view.funds.map((f) => f.balanceCents))).toBe(view.onHandCents)
  })

  it('refuses to account for more than is outstanding', async () => {
    await expect(resolve({ amountCents: GAP + 1 })).rejects.toThrow(/more than is outstanding/)
  })

  it('refuses a resolution that would flip a surplus into a shortfall', async () => {
    await expect(resolve({ amountCents: -GAP })).rejects.toThrow(/has to be positive/)
  })

  it('refuses a decision with no reason and no one behind it', async () => {
    await expect(resolve({ reason: '   ' })).rejects.toThrow(/needs a reason/)
    await expect(resolve({ decidedBy: '' })).rejects.toThrow(/whoever decided/)
  })

  it('keeps the reason and the name of whoever decided', async () => {
    await resolve()
    const position = await loadOpeningPosition(db, ID)
    const decision = position.entries.find((e) => e.kind === 'resolved')
    expect(decision?.reason).toMatch(/unrecorded deposit/)
    expect(decision?.decidedBy).toBe('the Assembly, minuted 12 Kamál')
  })

  it('has nothing to do once the difference is gone', async () => {
    await resolve()
    await expect(resolve()).rejects.toThrow(/nothing unexplained/)
  })
})

describe('the opening position is append-only', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await fresh()
    await open(db)
  })

  // Enforced by triggers rather than by the code paths remembering. Every
  // later figure in these books is measured from the opening position, so an
  // edit would move what every report has already been computed against and
  // leave no trace of what it was.
  it('refuses an edit, even from a raw SQL console', async () => {
    await expect(
      db.run('UPDATE fund_openings SET amount_cents = 1 WHERE assembly_id = ?', [ID]),
    ).rejects.toThrow(/cannot be edited/)
  })

  it('refuses a delete', async () => {
    await expect(
      db.run('DELETE FROM fund_openings WHERE assembly_id = ?', [ID]),
    ).rejects.toThrow(/cannot be deleted/)
  })

  it('records the declaration in the audit trail, with the Local figure in it', async () => {
    const entry = await db.get<{ after_json: string; actor: string }>(
      "SELECT after_json, actor FROM audit_log WHERE entity = 'setup' AND assembly_id = ?",
      [ID],
    )
    const declared = JSON.parse(entry!.after_json)
    // The Local Fund has no row of its own — it is the residual — so the audit
    // entry is the only place the figure the treasurer actually stated for it
    // survives.
    expect(declared.declared.local).toBe(DECLARED_LOCAL)
    expect(declared.unexplained_cents).toBe(GAP)
    expect(declared.opened_on).toBe(OPENED)
  })
})

describe('an opened book handed to a successor', () => {
  it('arrives with its opening position intact', async () => {
    const source = await fresh()
    await open(source)

    const bundle = JSON.parse(
      JSON.stringify(await exportEverything(source, ID, NOW, 'outgoing@riverbend')),
    )
    const target = await fresh()
    await restore(target, bundle, 'successor@riverbend', NOW)

    const before = await loadFunds(source, ID, YEAR)
    const after = await loadFunds(target, ID, YEAR)
    expect(after.funds).toEqual(before.funds)
    expect(after.onHandCents).toBe(before.onHandCents)

    // Including the part nobody could explain, which is exactly the fact a
    // successor most needs carried across.
    expect((await loadOpeningPosition(target, ID)).unexplainedCents).toBe(GAP)
  })
})

const MAPPING: ColumnMapping = {
  date: 0,
  dateFormat: 'ymd',
  description: 1,
  amount: { kind: 'single', column: 2 },
}

/** A statement whose rows straddle the day the books opened. */
const STRADDLING = [
  'Date,Description,Amount',
  '2026-07-14,EARLIER DEPOSIT,120.00',
  '2026-07-20,EARLIER RENT,-350.00',
  '2026-08-03,HALL RENTAL,-450.00',
  '2026-08-11,ONLINE TRANSFER FROM MEMBER,315.00',
].join('\n')

const bankId = (db: NodeSqlDatabase) =>
  db
    .get<{ id: string }>("SELECT id FROM accounts WHERE assembly_id = ? AND kind = 'bank'", [ID])
    .then((r) => r!.id)

describe('a statement that reaches back before the books opened', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await fresh()
    await open(db)
  })

  // The opening balance already accounts for everything before the wall.
  // Importing a row from before it counts the same money twice — once inside
  // the opening figure and once as a transaction — and the books end up out by
  // exactly the amount of history that was loaded.
  it('marks the rows before the wall rather than importing them', async () => {
    const preview = await previewImport(db, ID, await bankId(db), STRADDLING, MAPPING)
    expect(preview.openedOn).toBe(OPENED)
    expect(preview.counts.beforeOpening).toBe(2)
    expect(preview.counts.fresh).toBe(2)

    const verdicts = preview.rows.map((r) => `${r.occurredOn} ${r.verdict}`)
    expect(verdicts).toEqual([
      '2026-07-14 before-opening',
      '2026-07-20 before-opening',
      '2026-08-03 new',
      '2026-08-11 new',
    ])
  })

  it('refuses to write them even when the client accepts every row', async () => {
    const accountId = await bankId(db)
    const preview = await previewImport(db, ID, accountId, STRADDLING, MAPPING)

    const result = await commitImport(db, ID, {
      accountId,
      filename: 'straddling.csv',
      mapping: MAPPING,
      csvText: STRADDLING,
      // Everything, including the two the treasurer was told are outside.
      accept: preview.rows.map((r) => r.dedupeHash),
      actor: ACTOR,
      now: NOW,
    })

    expect(result.imported).toBe(2)
    const landed = await db.all<{ occurred_on: string }>(
      'SELECT occurred_on FROM transactions WHERE assembly_id = ? ORDER BY occurred_on',
      [ID],
    )
    expect(landed.map((r) => r.occurred_on)).toEqual(['2026-08-03', '2026-08-11'])

    // And the books moved by the two rows that were inside, not by all four.
    const view = await loadFunds(db, ID, YEAR)
    expect(view.onHandCents).toBe(ON_HAND - 45_000 + 31_500)
  })

  it('lets them in once the wall has moved behind them', async () => {
    const accountId = await bankId(db)
    await restateOpening(
      db, ID,
      {
        openedOn: '2026-07-01',
        accounts: { [accountId]: BANK_CENTS - 12_000 + 35_000 },
        declared: { local: RESTATED_LOCAL, national: DECLARED_NATIONAL },
        reason: "Last year's cash journal was found in the safe",
        decidedBy: 'the Assembly, minuted 3 ʿIzzat',
      },
      ACTOR, NOW,
    )

    const preview = await previewImport(db, ID, accountId, STRADDLING, MAPPING)
    expect(preview.counts.beforeOpening).toBe(0)
    expect(preview.counts.fresh).toBe(4)
  })
})

describe('moving the opening date backwards', () => {
  let db: NodeSqlDatabase
  let accountId: string
  beforeEach(async () => {
    db = await fresh()
    await open(db)
    accountId = await bankId(db)
  })

  const restate = (over: Record<string, unknown> = {}) =>
    restateOpening(
      db, ID,
      {
        openedOn: '2026-07-01',
        accounts: { [accountId]: BANK_CENTS - 12_000 + 35_000 },
        declared: { local: RESTATED_LOCAL, national: DECLARED_NATIONAL },
        reason: "Last year's cash journal was found in the safe",
        decidedBy: 'the Assembly, minuted 3 ʿIzzat',
        ...over,
      },
      ACTOR, NOW,
    )

  it('moves the wall and keeps what the books used to say', async () => {
    const result = await restate()
    expect(result.openedOn).toBe('2026-07-01')
    expect(result.previousOpenedOn).toBe(OPENED)
    // The figure the Assembly had already accepted for the old date.
    expect(result.checkpoint).toEqual({ asOf: OPENED, expectedCents: ON_HAND })
    expect((await loadOpeningPosition(db, ID)).openedOn).toBe('2026-07-01')
  })

  // Forwards would leave transactions already on the books sitting before a
  // wall that says nothing before it counts — still in every total while
  // claiming not to exist.
  it('refuses to move forwards', async () => {
    await expect(restate({ openedOn: '2026-09-01' })).rejects.toThrow(/only move earlier/)
  })

  it('refuses to move to the same day', async () => {
    await expect(restate({ openedOn: OPENED })).rejects.toThrow(/only move earlier/)
  })

  // The mistake this guard exists for is silent and catastrophic. The
  // Assembly's own fund has no stored figure — it is the residual — so a form
  // built from the table of stored openings does not think to ask for it, and
  // leaving it out declares the Assembly's entire balance unaccounted for.
  // This was written after doing exactly that.
  it('refuses to restate without saying what the Assembly’s own fund held', async () => {
    await expect(restate({ declared: { national: DECLARED_NATIONAL } })).rejects.toThrow(
      /Say what the Local Fund held as well/,
    )
  })

  it('keeps the remainder where it was when the funds are restated consistently', async () => {
    const before = (await loadOpeningPosition(db, ID)).unexplainedCents
    await restate()
    expect((await loadOpeningPosition(db, ID)).unexplainedCents).toBe(before)
  })

  it('refuses without a reason or a name', async () => {
    await expect(restate({ reason: '  ' })).rejects.toThrow(/needs a reason/)
    await expect(restate({ decidedBy: '' })).rejects.toThrow(/whoever decided/)
  })

  it('corrects the funds by appending, never by editing', async () => {
    await restate({ declared: { local: RESTATED_LOCAL, national: 40_000 } })
    const position = await loadOpeningPosition(db, ID)
    expect(position.funds.find((f) => f.key === 'national')?.openingCents).toBe(40_000)
    // Two rows, not one changed one: what was declared and what corrected it.
    const national = position.entries.filter((e) => e.fundLabel === 'National Fund')
    expect(national.map((e) => e.kind)).toEqual(['declared', 'restated'])
    expect(national.map((e) => e.amountCents)).toEqual([DECLARED_NATIONAL, 15_000])
  })

  it('records the change of opening balance in the audit trail', async () => {
    await restate()
    const entry = await db.get<{ before_json: string; after_json: string }>(
      `SELECT before_json, after_json FROM audit_log
        WHERE entity = 'accounts' AND action = 'update' ORDER BY id DESC LIMIT 1`,
    )
    expect(JSON.parse(entry!.before_json).opening_balance_cents).toBe(BANK_CENTS)
    expect(JSON.parse(entry!.after_json).opening_balance_cents).toBe(BANK_CENTS - 12_000 + 35_000)
  })

  it('will not let a checkpoint be edited away', async () => {
    await restate()
    await expect(
      db.run('UPDATE opening_checkpoints SET expected_cents = 0 WHERE assembly_id = ?', [ID]),
    ).rejects.toThrow(/cannot be edited/)
    await expect(
      db.run('DELETE FROM opening_checkpoints WHERE assembly_id = ?', [ID]),
    ).rejects.toThrow(/cannot be deleted/)
  })
})

describe('proving the restated books against what they used to say', () => {
  let db: NodeSqlDatabase
  let accountId: string

  beforeEach(async () => {
    db = await fresh()
    await open(db)
    accountId = await bankId(db)
  })

  // The whole reason a checkpoint is kept. The bank held $4,312.18 on 1 August.
  // Move the wall to 1 July, say it held $4,192.18 then, and the two July rows
  // (+$120.00 and -$350.00) have to bring it back to $4,312.18 — they do not
  // unless the restated figure is right, and the difference is the size of
  // what is missing.
  it('holds when the history loaded lands on the old figure', async () => {
    await restateOpening(
      db, ID,
      {
        openedOn: '2026-07-01',
        // 4312.18 - 120.00 + 350.00
        accounts: { [accountId]: BANK_CENTS - 12_000 + 35_000 },
        declared: { local: RESTATED_LOCAL, national: DECLARED_NATIONAL },
        reason: "Last year's cash journal was found in the safe",
        decidedBy: 'the Assembly',
      },
      ACTOR, NOW,
    )

    const preview = await previewImport(db, ID, accountId, STRADDLING, MAPPING)
    await commitImport(db, ID, {
      accountId,
      filename: 'straddling.csv',
      mapping: MAPPING,
      csvText: STRADDLING,
      accept: preview.rows.map((r) => r.dedupeHash),
      actor: ACTOR,
      now: NOW,
    })

    const [checkpoint] = await loadCheckpoints(db, ID)
    expect(checkpoint.expectedCents).toBe(ON_HAND)
    expect(checkpoint.differenceCents).toBe(0)
    expect(checkpoint.holds).toBe(true)
  })

  it('says by how much when the history does not add up', async () => {
    await restateOpening(
      db, ID,
      {
        openedOn: '2026-07-01',
        // Out by $40: a plausible restated figure that the July rows will not
        // reproduce.
        accounts: { [accountId]: BANK_CENTS - 12_000 + 35_000 + 4_000 },
        declared: { local: RESTATED_LOCAL, national: DECLARED_NATIONAL },
        reason: 'Restated from the June statement',
        decidedBy: 'the Assembly',
      },
      ACTOR, NOW,
    )

    const preview = await previewImport(db, ID, accountId, STRADDLING, MAPPING)
    await commitImport(db, ID, {
      accountId,
      filename: 'straddling.csv',
      mapping: MAPPING,
      csvText: STRADDLING,
      accept: preview.rows.map((r) => r.dedupeHash),
      actor: ACTOR,
      now: NOW,
    })

    const [checkpoint] = await loadCheckpoints(db, ID)
    expect(checkpoint.holds).toBe(false)
    expect(checkpoint.differenceCents).toBe(4_000)
  })

  it('is disclosed in the audit package rather than left to be found', async () => {
    await restateOpening(
      db, ID,
      {
        openedOn: '2026-07-01',
        accounts: { [accountId]: BANK_CENTS + 4_000 },
        declared: { local: RESTATED_LOCAL, national: DECLARED_NATIONAL },
        reason: 'Restated from the June statement',
        decidedBy: 'the Assembly',
      },
      ACTOR, NOW,
    )

    const pack = await loadAuditPackage(db, ID, YEAR, TODAY, ACTOR)
    expect(pack!.gaps.map((g) => g.key)).toContain('opening-checkpoint')
    expect(pack!.checkpoints[0].holds).toBe(false)
  })
})

describe('what the audit package says about an unexplained opening', () => {
  it('discloses money no fund claims', async () => {
    const db = await fresh()
    await open(db)
    const pack = await loadAuditPackage(db, ID, YEAR, TODAY, ACTOR)
    const gap = pack!.gaps.find((g) => g.key === 'opening-unexplained')
    expect(gap?.label).toContain('$149.68')
    expect(gap?.consequence).toContain('kept out of the Local Fund')
  })

  it('says the opposite thing when the funds claim more than is held', async () => {
    const db = await fresh()
    await open(db, {
      accounts: [{ name: 'Bank', kind: 'bank' as const, openingBalanceCents: 100_000 }],
      declared: { local: 90_000, national: 25_000 },
    })
    const pack = await loadAuditPackage(db, ID, YEAR, TODAY, ACTOR)
    const gap = pack!.gaps.find((g) => g.key === 'opening-unexplained')
    expect(gap?.label).toContain('more than the Assembly holds')
    expect(gap?.consequence).toContain('appears to have been spent')
  })

  it('says nothing at all when the books opened clean', async () => {
    const db = await fresh()
    await open(db, {
      accounts: [{ name: 'Bank', kind: 'bank' as const, openingBalanceCents: 100_000 }],
      declared: { local: 75_000, national: 25_000 },
    })
    const pack = await loadAuditPackage(db, ID, YEAR, TODAY, ACTOR)
    expect(pack!.gaps.map((g) => g.key)).not.toContain('opening-unexplained')
  })
})
