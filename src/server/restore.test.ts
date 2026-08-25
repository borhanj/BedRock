import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from './db/migrate'
import { openNodeDatabase, type NodeSqlDatabase } from './db/node-sqlite'
import { exportEverything, HANDOFF_SCHEMA_VERSION } from './repo/handoff'
import { inspectBundle, planRestore, restore, RestoreError } from './repo/restore'
import { loadFunds } from './repo/funds'
import { loadYear } from './repo/year'
import { loadAuditPackage } from './repo/audit'
import { createDonor, setupVault } from './repo/donors'
import { handleApi } from './api'
import { ASSEMBLY_ID, SEED_TODAY, SEED_YEAR, seed } from './seed'

const ACTOR = 'successor@riverbend'
const NOW = '2027-04-02T09:00:00Z'

/** A seeded database — the outgoing treasurer's. */
async function seeded(): Promise<NodeSqlDatabase> {
  const db = openNodeDatabase(':memory:')
  await migrate(db)
  await seed(db)
  return db
}

/** An empty one with the schema — the successor's fresh deployment. */
async function empty(): Promise<NodeSqlDatabase> {
  const db = openNodeDatabase(':memory:')
  await migrate(db)
  return db
}

const bundleFrom = (db: NodeSqlDatabase) =>
  exportEverything(db, ASSEMBLY_ID, '2027-04-01T12:00:00Z', 'outgoing@riverbend')

/** Round-trip through JSON, because that is how a bundle actually travels. */
const overWire = async (db: NodeSqlDatabase) =>
  JSON.parse(JSON.stringify(await bundleFrom(db)))

describe('reading a bundle before touching anything', () => {
  let source: NodeSqlDatabase
  beforeEach(async () => {
    source = await seeded()
  })

  it('names the Assembly and the money without a database in hand', async () => {
    const report = inspectBundle(await overWire(source))
    expect(report.assemblyId).toBe(ASSEMBLY_ID)
    expect(report.assemblyName).toBe('Local Spiritual Assembly of Riverbend')
    expect(report.exportedBy).toBe('outgoing@riverbend')
    // The figure a treasurer would recognise, so they can tell at a glance
    // whether this is the file they meant.
    expect(report.onHandCents).toBe(517_240)
    expect(report.counts.transactions).toBe(85)
    expect(report.canRestore).toBe(true)
  })

  it('refuses something that is not a Bedrock export', async () => {
    for (const junk of [null, 42, 'a string', {}, { hello: 'world' }]) {
      expect(() => inspectBundle(junk)).toThrow(RestoreError)
    }
  })

  it('refuses a file from a newer Bedrock rather than loading part of it', async () => {
    const bundle = await overWire(source)
    bundle.schemaVersion = HANDOFF_SCHEMA_VERSION + 1
    const report = inspectBundle(bundle)
    expect(report.canRestore).toBe(false)
    expect(report.problems.join(' ')).toMatch(/newer Bedrock/)
  })

  it('refuses a table this version has never heard of', async () => {
    const bundle = await overWire(source)
    bundle.tables.endowments = [{ id: 'e1' }]
    expect(inspectBundle(bundle).canRestore).toBe(false)
  })

  it('refuses a fraction of a cent anywhere in the file', async () => {
    const bundle = await overWire(source)
    bundle.tables.transactions[0].amount_cents = 12.5
    const report = inspectBundle(bundle)
    expect(report.canRestore).toBe(false)
    expect(report.problems.join(' ')).toMatch(/not a whole number of cents/)
  })

  it('catches a truncated file by its dangling references', async () => {
    // The failure this check exists for: a file that loads happily until the
    // row whose parent was cut off the end.
    const bundle = await overWire(source)
    bundle.tables.transactions = bundle.tables.transactions.slice(0, 10)
    const report = inspectBundle(bundle)
    expect(report.canRestore).toBe(false)
    expect(report.problems.join(' ')).toMatch(/contributions point at a transactions/)
  })

  it('says when the trail is missing without refusing the figures', async () => {
    const bundle = await overWire(source)
    bundle.tables.audit_log = []
    const report = inspectBundle(bundle)
    expect(report.canRestore).toBe(true)
    expect(report.notes.join(' ')).toMatch(/no audit trail/)
  })

  it('warns that encrypted names do not come back without the PIN', async () => {
    await setupVault(source, ASSEMBLY_ID, 'correct-horse-battery', ACTOR, NOW)
    await createDonor(
      source, ASSEMBLY_ID,
      { name: 'Ruhiyyih Nakhjavani', contact: null, secret: 'correct-horse-battery' },
      ACTOR, NOW,
    )
    const report = inspectBundle(await overWire(source))
    expect(report.notes.join(' ')).toMatch(/1 donor name is encrypted/)
    expect(report.notes.join(' ')).toMatch(/restoring does not recover them/)
  })
})

describe('restoring into an empty database', () => {
  let source: NodeSqlDatabase
  let target: NodeSqlDatabase
  beforeEach(async () => {
    source = await seeded()
    target = await empty()
  })

  it('lands on exactly the same books', async () => {
    await restore(target, await overWire(source), ACTOR, NOW)

    const before = await loadFunds(source, ASSEMBLY_ID, SEED_YEAR)
    const after = await loadFunds(target, ASSEMBLY_ID, SEED_YEAR)
    expect(after.funds).toEqual(before.funds)
    expect(after.onHandCents).toBe(before.onHandCents)

    const y1 = await loadYear(source, ASSEMBLY_ID, SEED_YEAR, SEED_TODAY)
    const y2 = await loadYear(target, ASSEMBLY_ID, SEED_YEAR, SEED_TODAY)
    expect(y2.receivedToDateCents).toBe(y1.receivedToDateCents)
    expect(y2.paidToDateCents).toBe(y1.paidToDateCents)
    expect(y2.attention).toEqual(y1.attention)
  })

  it('brings every row across', async () => {
    const bundle = await overWire(source)
    const result = await restore(target, bundle, ACTOR, NOW)
    expect(result.assemblyName).toBe('Local Spiritual Assembly of Riverbend')

    for (const table of ['transactions', 'contributions', 'reports', 'budgets']) {
      const n = await target.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)
      expect(n!.n).toBe(bundle.tables[table].length)
    }
  })

  it('restores the frozen report snapshots, not just the rows', async () => {
    // Without these a presented month would recompute live in the successor's
    // database, and a later correction would silently rewrite a report the
    // community has already heard.
    await restore(target, await overWire(source), ACTOR, NOW)
    const frozen = await target.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM reports WHERE snapshot_json IS NOT NULL',
    )
    expect(frozen!.n).toBe(8)
    const pack = (await loadAuditPackage(target, ASSEMBLY_ID, SEED_YEAR, SEED_TODAY, ACTOR))!
    expect(pack.checks.filter((c) => !c.holds)).toEqual([])
  })

  it('gets the balanced statement past its own trigger', async () => {
    // A balanced reconciliation refuses changes to what has cleared, so it has
    // to arrive open and be closed once its items are in.
    await restore(target, await overWire(source), ACTOR, NOW)
    const rec = await target.get<{ status: string; items: number }>(
      `SELECT status, (SELECT COUNT(*) FROM reconciliation_items) AS items
         FROM reconciliations LIMIT 1`,
    )
    expect(rec!.status).toBe('balanced')
    expect(rec!.items).toBe(73)
  })

  it('gets the approved budget past its own trigger', async () => {
    // An approved year refuses new lines, so the lines arrive first.
    await restore(target, await overWire(source), ACTOR, NOW)
    const budget = await target.get<{ status: string; lines: number }>(
      `SELECT status, (SELECT COUNT(*) FROM budgets) AS lines
         FROM budget_years LIMIT 1`,
    )
    expect(budget!.status).toBe('approved')
    expect(budget!.lines).toBe(13)
  })

  it('keeps donor names encrypted, and still unreadable', async () => {
    await setupVault(source, ASSEMBLY_ID, 'correct-horse-battery', ACTOR, NOW)
    await createDonor(
      source, ASSEMBLY_ID,
      { name: 'Ruhiyyih Nakhjavani', contact: null, secret: 'correct-horse-battery' },
      ACTOR, NOW,
    )
    await restore(target, await overWire(source), ACTOR, NOW)

    const stored = await target.get<{ name_encrypted: string }>(
      'SELECT name_encrypted FROM donors WHERE name_encrypted IS NOT NULL LIMIT 1',
    )
    expect(stored!.name_encrypted).not.toContain('Ruhiyyih')
    // And the vault parameters came too, so the right PIN still opens them.
    const vault = await target.get<{ kdf_salt: string }>('SELECT kdf_salt FROM vault')
    expect(vault!.kdf_salt).toBeTruthy()
  })
})

describe('the audit trail across a restore', () => {
  let source: NodeSqlDatabase
  let target: NodeSqlDatabase
  beforeEach(async () => {
    source = await seeded()
    target = await empty()
  })

  it('carries the original entries with their own actors and times', async () => {
    const bundle = await overWire(source)
    const result = await restore(target, bundle, ACTOR, NOW)
    expect(result.auditRowsCarried).toBe(bundle.tables.audit_log.length)

    const original = await target.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM audit_log WHERE actor = 'seed'",
    )
    expect(original!.n).toBeGreaterThan(0)
  })

  it('attributes its own entries so they cannot pass for original activity', async () => {
    await restore(target, await overWire(source), ACTOR, NOW)
    const mine = await target.get<{ n: number; actor: string }>(
      `SELECT COUNT(*) AS n, actor FROM audit_log WHERE actor LIKE 'restore by %'`,
    )
    expect(mine!.n).toBeGreaterThan(0)
    expect(mine!.actor).toContain(ACTOR)
    expect(mine!.actor).toContain('2027-04-01')
  })

  it('records the restore as one findable event', async () => {
    await restore(target, await overWire(source), ACTOR, NOW)
    const event = await target.get<{ actor: string; after_json: string; occurred_at: string }>(
      "SELECT actor, after_json, occurred_at FROM audit_log WHERE entity = 'restore'",
    )
    expect(event!.actor).toBe(ACTOR)
    expect(event!.occurred_at).toBe(NOW)
    const detail = JSON.parse(event!.after_json)
    expect(detail.exported_by).toBe('outgoing@riverbend')
    expect(detail.rows_written).toBeGreaterThan(0)
  })

  it('leaves no entry unattributed', async () => {
    await restore(target, await overWire(source), ACTOR, NOW)
    const blank = await target.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM audit_log WHERE actor IS NULL OR TRIM(actor) = ''",
    )
    expect(blank!.n).toBe(0)
  })
})

describe('restoring over books that are already there', () => {
  it('refuses, and changes nothing', async () => {
    const source = await seeded()
    const target = await seeded()

    const plan = await planRestore(target, await overWire(source))
    expect(plan.canRestore).toBe(false)
    expect(plan.problems.join(' ')).toMatch(/already holds Local Spiritual Assembly/)

    await expect(restore(target, await overWire(source), ACTOR, NOW)).rejects.toThrow(
      RestoreError,
    )

    // Not one row doubled.
    const counted = await target.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM transactions',
    )
    expect(counted!.n).toBe(85)
  })

  it('refuses even when the file itself is perfectly sound', async () => {
    // The file is fine; the target is not empty. The distinction matters —
    // the refusal is about where it is going, not what it contains.
    const source = await seeded()
    const bundle = await overWire(source)
    expect(inspectBundle(bundle).canRestore).toBe(true)

    const target = await seeded()
    expect((await planRestore(target, bundle)).canRestore).toBe(false)
  })
})

describe('a restored book keeps working', () => {
  it('exports again to the same thing', async () => {
    // The round trip closes: what comes out of a restored database is what
    // went into it, so a successor can hand on in turn.
    const source = await seeded()
    const target = await empty()
    const first = await overWire(source)
    await restore(target, first, ACTOR, NOW)

    const second = await exportEverything(target, ASSEMBLY_ID, NOW, ACTOR)
    for (const table of ['transactions', 'contributions', 'funds', 'budgets', 'reports']) {
      expect(second.tables[table]).toEqual(first.tables[table])
    }
  })
})

describe('the restore API', () => {
  let target: NodeSqlDatabase
  let bundle: unknown
  beforeEach(async () => {
    target = await empty()
    bundle = await overWire(await seeded())
  })

  const call = (path: string, body: unknown) =>
    handleApi(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
      { db: target, assemblyId: ASSEMBLY_ID, actor: ACTOR, today: SEED_TODAY, now: NOW },
    )

  it('inspects without writing anything', async () => {
    const response = (await call('/api/handoff/inspect', bundle))!
    expect(response.status).toBe(200)
    expect((await response.json()).canRestore).toBe(true)

    const untouched = await target.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM transactions',
    )
    expect(untouched!.n).toBe(0)
  })

  it('restores, and reports what it wrote', async () => {
    const response = (await call('/api/handoff/restore', bundle))!
    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.rowsWritten).toBeGreaterThan(400)
    expect(body.assemblyName).toContain('Riverbend')
  })

  it('answers 409 rather than half-loading a bad file', async () => {
    const broken = JSON.parse(JSON.stringify(bundle))
    broken.tables.transactions = broken.tables.transactions.slice(0, 5)
    const response = (await call('/api/handoff/restore', broken))!
    expect(response.status).toBe(409)

    const untouched = await target.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM assemblies',
    )
    expect(untouched!.n).toBe(0)
  })
})
