import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from './db/migrate'
import { openNodeDatabase, type NodeSqlDatabase } from './db/node-sqlite'
import {
  addAccount,
  addCategory,
  addFund,
  clearLetterhead,
  loadLetterhead,
  loadSettings,
  renameAssembly,
  renameFund,
  resetEverything,
  setLetterhead,
  updateAccount,
  updateCategory,
  isSampleData,
  LETTERHEAD_MAX_BYTES,
} from './repo/settings'
import { exportEverything } from './repo/handoff'
import { restore } from './repo/restore'
import { setUpAssembly, setupStatus } from './repo/setup'
import { loadChoices } from './repo/ledger'
import { loadGettingStarted } from './repo/started'
import { handleApi } from './api'
import { ASSEMBLY_ID, SEED_TODAY, seed } from './seed'

const ACTOR = 'treasurer@riverbend'
const NOW = '2026-08-28T12:00:00Z'

/** The worked year, which is exactly what a treasurer needs to be rid of. */
async function seeded(): Promise<NodeSqlDatabase> {
  const db = openNodeDatabase(':memory:')
  await migrate(db)
  await seed(db)
  return db
}

/** A one-pixel PNG, as a browser would hand it over. */
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk' +
  'YAAAAAYAAjCB0C8AAAAASUVORK5CYII='

describe('correcting what setup got wrong', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await seeded()
  })

  it('renames the Assembly without changing its id', async () => {
    await renameAssembly(db, ASSEMBLY_ID, 'Riverbend LSA', 'Riverbend', ACTOR)
    const view = await loadSettings(db, ASSEMBLY_ID)
    expect(view?.name).toBe('Riverbend LSA')
    expect(view?.assemblyId).toBe(ASSEMBLY_ID)
  })

  it('records the rename in the audit trail', async () => {
    await renameAssembly(db, ASSEMBLY_ID, 'Riverbend LSA', 'Riverbend', ACTOR)
    const entry = await db.get<{ before_json: string; actor: string }>(
      "SELECT before_json, actor FROM audit_log WHERE entity = 'assemblies' ORDER BY id DESC LIMIT 1",
    )
    expect(JSON.parse(entry!.before_json).name).not.toBe('Riverbend LSA')
    expect(entry!.actor).toBe(ACTOR)
  })

  it('adds a second bank account and a second cash journal', async () => {
    await addAccount(
      db, ASSEMBLY_ID,
      { name: 'Building Fund savings', kind: 'bank', openingBalanceCents: 250_000 },
      ACTOR, NOW,
    )
    await addAccount(
      db, ASSEMBLY_ID,
      { name: 'Feast tin', kind: 'cash', openingBalanceCents: 0 },
      ACTOR, '2026-08-28T12:00:01Z',
    )
    const view = await loadSettings(db, ASSEMBLY_ID)
    expect(view!.accounts.filter((a) => a.kind === 'bank')).toHaveLength(2)
    expect(view!.accounts.filter((a) => a.kind === 'cash')).toHaveLength(2)
  })

  // An account with rows against it is never deleted: the ledger and the
  // reconciliations that proved those rows would lose what they were about.
  // Retiring takes it out of the lists and touches no figure.
  it('retires an account rather than deleting it', async () => {
    const before = await loadSettings(db, ASSEMBLY_ID)
    const bank = before!.accounts.find((a) => a.kind === 'bank')!
    expect(bank.transactionCount).toBeGreaterThan(0)

    await updateAccount(db, ASSEMBLY_ID, bank.id, { isActive: false }, ACTOR)

    const after = await loadSettings(db, ASSEMBLY_ID)
    expect(after!.accounts.find((a) => a.id === bank.id)?.isActive).toBe(false)
    // Still there, still carrying its rows.
    expect(after!.accounts.find((a) => a.id === bank.id)?.transactionCount).toBe(
      bank.transactionCount,
    )
    // And gone from what the entry forms offer.
    const choices = await loadChoices(db, ASSEMBLY_ID)
    expect(choices.accounts.map((a) => a.id)).not.toContain(bank.id)
  })

  it('archives a category rather than deleting it', async () => {
    const before = await loadSettings(db, ASSEMBLY_ID)
    const used = before!.categories.find((c) => c.transactionCount > 0)!

    await updateCategory(db, ASSEMBLY_ID, used.id, { isArchived: true }, ACTOR)

    const choices = await loadChoices(db, ASSEMBLY_ID)
    expect(choices.categories.map((c) => c.id)).not.toContain(used.id)
    const rows = await db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM transactions WHERE category_id = ?',
      [used.id],
    )
    expect(rows?.n).toBe(used.transactionCount)
  })

  it('adds a fund, and it is held for another institution', async () => {
    await addFund(db, ASSEMBLY_ID, { key: 'Regional Council', label: 'Regional Council Fund' }, ACTOR)
    const view = await loadSettings(db, ASSEMBLY_ID)
    const added = view!.funds.find((f) => f.label === 'Regional Council Fund')
    expect(added?.key).toBe('regional-council')
    // Never the Assembly's own: there is exactly one of those and it is the
    // residual of the partition.
    expect(added?.isPassthrough).toBe(true)
    expect(view!.funds.filter((f) => !f.isPassthrough)).toHaveLength(1)
  })

  it('refuses a fund whose key is already taken', async () => {
    await expect(
      addFund(db, ASSEMBLY_ID, { key: 'local', label: 'Another Local' }, ACTOR),
    ).rejects.toThrow(/already a fund with the key/)
  })

  it('refuses an expense category that claims to feed a fund', async () => {
    await expect(
      addCategory(db, ASSEMBLY_ID, { label: 'Nonsense', kind: 'expense', fundKey: 'local' }, ACTOR),
    ).rejects.toThrow(/cannot name a fund it feeds/)
  })

  it('renames a fund, and past reports keep reading correctly', async () => {
    const before = await loadSettings(db, ASSEMBLY_ID)
    const national = before!.funds.find((f) => f.key === 'national')!
    await renameFund(db, ASSEMBLY_ID, national.id, 'National Bahá’í Fund', ACTOR)
    const after = await loadSettings(db, ASSEMBLY_ID)
    expect(after!.funds.find((f) => f.key === 'national')?.label).toBe('National Bahá’í Fund')
    expect(after!.funds.find((f) => f.key === 'national')?.contributionCount).toBe(
      national.contributionCount,
    )
  })
})

describe('knowing the books are only a demonstration', () => {
  // A deployment full of the worked example looks exactly like one in use —
  // the same screens, the same confident totals — so a treasurer who does not
  // already know has no reason to go looking for the way out.
  it('recognises the fixture', async () => {
    const db = await seeded()
    expect(await isSampleData(db, ASSEMBLY_ID)).toBe(true)
  })

  it('does not mistake an Assembly’s own books for it', async () => {
    const db = openNodeDatabase(':memory:')
    await migrate(db)
    await setUpAssembly(
      db, ASSEMBLY_ID,
      {
        assemblyName: 'Riverbend Local Spiritual Assembly',
        shortName: 'Riverbend',
        openedOn: '2026-08-01',
        funds: [{ key: 'local', label: 'Local Fund', isPassthrough: false }],
        accounts: [{ name: 'Bank', kind: 'bank', openingBalanceCents: 100_000 }],
        categories: [],
        declared: { local: 100_000 },
        declaredBy: 'outgoing',
      },
      ACTOR, NOW,
    )
    expect(await isSampleData(db, ASSEMBLY_ID)).toBe(false)
  })

  it('stops saying so once the books are cleared', async () => {
    const db = await seeded()
    const assembly = await db.get<{ name: string }>('SELECT name FROM assemblies')
    await resetEverything(db, ASSEMBLY_ID, assembly!.name, ACTOR)
    expect(await isSampleData(db, ASSEMBLY_ID)).toBe(false)
  })
})

describe('the Assembly’s letterhead', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await seeded()
  })

  it('is stored and read back for a receipt', async () => {
    await setLetterhead(db, ASSEMBLY_ID, TINY_PNG, 'logo.png', ACTOR, NOW)
    expect(await loadLetterhead(db, ASSEMBLY_ID)).toBe(TINY_PNG)

    const view = await loadSettings(db, ASSEMBLY_ID)
    expect(view!.branding.letterheadFilename).toBe('logo.png')
    expect(view!.branding.updatedBy).toBe(ACTOR)
  })

  it('is removed on request', async () => {
    await setLetterhead(db, ASSEMBLY_ID, TINY_PNG, 'logo.png', ACTOR, NOW)
    await clearLetterhead(db, ASSEMBLY_ID, ACTOR, NOW)
    expect(await loadLetterhead(db, ASSEMBLY_ID)).toBeNull()
  })

  // This string is rendered into an <img src>. A limit enforced only by the
  // page that happens to be open is not a limit, and `data:text/html` in an
  // image source is the kind of thing that only looks harmless.
  it('refuses anything that is not an image', async () => {
    await expect(
      setLetterhead(db, ASSEMBLY_ID, 'data:text/html;base64,PHNjcmlwdD4x', 'x.html', ACTOR, NOW),
    ).rejects.toThrow(/not an image type/)
    await expect(
      setLetterhead(db, ASSEMBLY_ID, 'https://example.com/logo.png', 'x.png', ACTOR, NOW),
    ).rejects.toThrow(/not an image file/)
  })

  it('refuses one too large to live in a database', async () => {
    // Base64 inflates by about a third, so the ceiling is on the decoded size.
    const huge = `data:image/png;base64,${'A'.repeat(LETTERHEAD_MAX_BYTES * 2)}`
    await expect(setLetterhead(db, ASSEMBLY_ID, huge, 'huge.png', ACTOR, NOW)).rejects.toThrow(
      /The limit is/,
    )
  })

  it('travels with the books to a successor', async () => {
    await setLetterhead(db, ASSEMBLY_ID, TINY_PNG, 'logo.png', ACTOR, NOW)
    const bundle = JSON.parse(
      JSON.stringify(await exportEverything(db, ASSEMBLY_ID, NOW, 'outgoing@riverbend')),
    )
    const target = openNodeDatabase(':memory:')
    await migrate(target)
    await restore(target, bundle, 'successor@riverbend', NOW)
    expect(await loadLetterhead(target, ASSEMBLY_ID)).toBe(TINY_PNG)
  })
})

describe('clearing a database that only ever held a demonstration', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await seeded()
  })

  // The ceremony scales with what is at risk. Nothing in the sample books
  // belongs to anybody, and making a new treasurer transcribe a long name they
  // did not choose is an obstacle between them and a usable app rather than a
  // safeguard.
  it('asks nothing of the sample books', async () => {
    const result = await resetEverything(db, ASSEMBLY_ID, '', ACTOR)
    expect(result.rowsDeleted).toBeGreaterThan(0)
  })

  it('still demands the name for an Assembly’s real books', async () => {
    const real = openNodeDatabase(':memory:')
    await migrate(real)
    await setUpAssembly(
      real, ASSEMBLY_ID,
      {
        assemblyName: 'Riverbend Local Spiritual Assembly',
        shortName: 'Riverbend',
        openedOn: '2026-08-01',
        funds: [{ key: 'local', label: 'Local Fund', isPassthrough: false }],
        accounts: [{ name: 'Bank', kind: 'bank', openingBalanceCents: 100_000 }],
        categories: [],
        declared: { local: 100_000 },
        declaredBy: 'outgoing',
      },
      ACTOR, NOW,
    )

    await expect(resetEverything(real, ASSEMBLY_ID, 'yes', ACTOR)).rejects.toThrow(
      /type the Assembly's name back/,
    )
    const survived = await real.get<{ n: number }>('SELECT COUNT(*) AS n FROM accounts')
    expect(survived!.n).toBe(1)

    const done = await resetEverything(
      real, ASSEMBLY_ID, 'Riverbend Local Spiritual Assembly', ACTOR,
    )
    expect(done.rowsDeleted).toBeGreaterThan(0)
  })

  it('leaves a database ready to be set up again', async () => {
    const assembly = await db.get<{ name: string }>('SELECT name FROM assemblies')
    const result = await resetEverything(db, ASSEMBLY_ID, assembly!.name, ACTOR)

    expect(result.rowsDeleted).toBeGreaterThan(0)
    for (const table of ['transactions', 'contributions', 'receipts', 'funds', 'accounts']) {
      const row = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)
      expect(`${table}=${row?.n}`).toBe(`${table}=0`)
    }

    // The state a fresh install is in, which is the whole point.
    const status = await setupStatus(db, ASSEMBLY_ID)
    expect(status.isSetUp).toBe(false)
  })

  // Six triggers refuse a DELETE, each protecting a record whose absence would
  // read as evidence destroyed. They stand down for a reset and have to be back
  // up the moment it finishes, or the next receipt is deletable.
  it('puts the schema’s guards back up afterwards', async () => {
    const assembly = await db.get<{ name: string }>('SELECT name FROM assemblies')
    await resetEverything(db, ASSEMBLY_ID, assembly!.name, ACTOR)

    const guard = await db.get<{ resetting: number }>(
      'SELECT resetting FROM reset_guard WHERE id = 1',
    )
    expect(guard?.resetting).toBe(0)

    // Prove it rather than trusting the flag: a receipt in a fresh book still
    // cannot be deleted.
    await db.run(
      `INSERT INTO audit_actor (id, actor) VALUES (1, 'test')
       ON CONFLICT (id) DO UPDATE SET actor = excluded.actor`,
    )
    await db.run(
      `INSERT INTO assemblies (id, name, short_name, created_at) VALUES ('x', 'X', 'X', 'n')`,
    )
    await db.run(`INSERT INTO funds (id, assembly_id, key, label) VALUES ('f', 'x', 'l', 'L')`)
    await db.run(
      `INSERT INTO receipts (id, assembly_id, number, issued_on, amount_cents, method, fund_id)
       VALUES ('r', 'x', 1, '2026-01-01', 100, 'cash', 'f')`,
    )
    await expect(db.run("DELETE FROM receipts WHERE id = 'r'")).rejects.toThrow(
      /cannot be deleted/,
    )
  })

  it('takes the audit trail with it, rather than leaving orphaned entries', async () => {
    const assembly = await db.get<{ name: string }>('SELECT name FROM assemblies')
    await resetEverything(db, ASSEMBLY_ID, assembly!.name, ACTOR)
    const log = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_log')
    expect(log?.n).toBe(0)
  })

  it('is reachable over the wire', async () => {
    const ctx = { db, assemblyId: ASSEMBLY_ID, actor: ACTOR, today: SEED_TODAY, now: NOW }
    const done = await handleApi(
      new Request('http://x/api/settings/reset', {
        method: 'POST',
        body: JSON.stringify({ confirmation: '' }),
      }),
      ctx,
    )
    expect(done?.status).toBe(200)
    expect(await setupStatus(db, ASSEMBLY_ID)).toMatchObject({ isSetUp: false })
  })
})

describe('what a new treasurer does next', () => {
  it('points at importing a statement when the books are empty', async () => {
    const db = openNodeDatabase(':memory:')
    await migrate(db)
    await setUpAssembly(
      db, ASSEMBLY_ID,
      {
        assemblyName: 'Riverbend Local Spiritual Assembly',
        shortName: 'Riverbend',
        openedOn: '2026-08-01',
        funds: [{ key: 'local', label: 'Local Fund', isPassthrough: false }],
        accounts: [{ name: 'Bank', kind: 'bank', openingBalanceCents: 100_000 }],
        categories: [],
        declared: { local: 100_000 },
        declaredBy: 'outgoing',
      },
      ACTOR, NOW,
    )

    const started = await loadGettingStarted(db, ASSEMBLY_ID)
    expect(started.doneCount).toBe(0)
    expect(started.complete).toBe(false)
    // Exactly one, so the card can answer "what now?" rather than list chores.
    expect(started.steps.filter((s) => s.next).map((s) => s.key)).toEqual(['import'])
  })

  // Read from the books, never from a record of what has been clicked. That is
  // what stops the list drifting from reality — and it means a step can go back
  // to undone, which a stored flag would have hidden.
  it('reads every tick from the data rather than from a flag', async () => {
    const db = await seeded()
    const started = await loadGettingStarted(db, ASSEMBLY_ID)

    const byKey = Object.fromEntries(started.steps.map((s) => [s.key, s]))
    expect(byKey.import.done).toBe(true)
    expect(byKey.report.done).toBe(true)
    // The fixture deliberately leaves the current month uncategorised, so this
    // step is genuinely outstanding and the list says so.
    expect(byKey.categorise.done).toBe(false)
    expect(byKey.categorise.status).toMatch(/still uncategorised/)
  })

  it('has nothing left to say once every step is done', async () => {
    const db = await seeded()
    const started = await loadGettingStarted(db, ASSEMBLY_ID)
    // Not complete for the fixture — the point of the assertion is that
    // `complete` is derived from the steps rather than asserted separately.
    expect(started.complete).toBe(started.steps.every((s) => s.done))
    expect(started.doneCount).toBe(started.steps.filter((s) => s.done).length)
  })
})
