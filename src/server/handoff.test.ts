import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from './db/migrate'
import { openNodeDatabase, type NodeSqlDatabase } from './db/node-sqlite'
import {
  exportEverything,
  HANDOFF_SCHEMA_VERSION,
  loadHandoff,
  RESTORE_ORDER,
  tablesWithoutAssemblyId,
} from './repo/handoff'
import { createDonor, setupVault } from './repo/donors'
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

const view = (db: NodeSqlDatabase, today = SEED_TODAY) =>
  loadHandoff(db, ASSEMBLY_ID, SEED_YEAR, today, ACTOR)

describe('the export', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await freshDatabase()
  })

  it('carries every table the schema has', async () => {
    const bundle = await exportEverything(db, ASSEMBLY_ID, NOW, ACTOR)

    // Read from the database rather than listed here, so a migration that adds
    // a table fails this test instead of quietly exporting an incomplete book.
    //
    // Three are deliberately outside a bundle, and each is machine state rather
    // than a record of anything: which migrations this database has run, who is
    // currently writing to it, and whether a reset is in progress. Carrying any
    // of them into a successor's database would say something untrue about it.
    const tables = (
      await db.all<{ name: string }>(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
            AND name NOT IN ('schema_migrations', 'audit_actor', 'reset_guard')`,
      )
    ).map((r) => r.name)

    for (const table of tables) {
      expect(Object.keys(bundle.tables)).toContain(table)
    }
  })

  it('is lossless where it matters', async () => {
    const bundle = await exportEverything(db, ASSEMBLY_ID, NOW, ACTOR)
    // The audit trail and the receipt voids are the two an export is most
    // tempted to drop, and the two that make the books defensible.
    expect(bundle.tables.audit_log.length).toBeGreaterThan(0)
    expect(bundle.tables.transactions).toHaveLength(85)
    expect(bundle.tables.contributions).toHaveLength(121)
    expect(bundle.tables.reconciliation_items.length).toBeGreaterThan(0)
  })

  it('stamps a schema version, who took it and when', async () => {
    const bundle = await exportEverything(db, ASSEMBLY_ID, NOW, ACTOR)
    expect(bundle.schemaVersion).toBe(HANDOFF_SCHEMA_VERSION)
    expect(bundle.exportedBy).toBe(ACTOR)
    expect(bundle.exportedAt).toBe(NOW)
    expect(bundle.assemblyId).toBe(ASSEMBLY_ID)
  })

  it('leaves donor names encrypted, and carries no key', async () => {
    await setupVault(db, ASSEMBLY_ID, 'correct-horse-battery', ACTOR, NOW)
    await createDonor(
      db, ASSEMBLY_ID,
      { name: 'Ruhiyyih Nakhjavani', contact: 'ruhiyyih@example.org', secret: 'correct-horse-battery' },
      ACTOR, NOW,
    )

    const serialised = JSON.stringify(
      await exportEverything(db, ASSEMBLY_ID, NOW, ACTOR),
    )
    expect(serialised).not.toContain('Ruhiyyih')
    expect(serialised).not.toContain('example.org')
    expect(serialised).not.toContain('correct-horse-battery')
  })

  it('still carries the ciphertext, or the names would be lost', async () => {
    // The other half of the same rule. An export that dropped the encrypted
    // column would be safe to lose and useless to keep.
    await setupVault(db, ASSEMBLY_ID, 'correct-horse-battery', ACTOR, NOW)
    const id = await createDonor(
      db, ASSEMBLY_ID,
      { name: 'Ruhiyyih Nakhjavani', contact: null, secret: 'correct-horse-battery' },
      ACTOR, NOW,
    )
    const bundle = await exportEverything(db, ASSEMBLY_ID, NOW, ACTOR)
    const donor = bundle.tables.donors.find((d) => d.id === id)
    expect(donor?.name_encrypted).toBeTruthy()

    // And the vault parameters, without which the ciphertext cannot be opened
    // even by someone who knows the PIN.
    expect(bundle.tables.vault).toHaveLength(1)
    expect(bundle.tables.vault[0].kdf_salt).toBeTruthy()
  })

  it('does not export who was writing at the time', async () => {
    // audit_actor holds the current connection's actor. It is a property of a
    // live session and means nothing in a file.
    const bundle = await exportEverything(db, ASSEMBLY_ID, NOW, ACTOR)
    expect(Object.keys(bundle.tables)).not.toContain('audit_actor')
  })
})

describe('the handover checklist', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await freshDatabase()
  })

  const step = async (key: string) => (await view(db))!.steps.find((s) => s.key === key)!

  it('puts the PIN first, and marks it as having no second chance', async () => {
    const list = (await view(db))!.steps
    expect(list[0].key).toBe('pin')
    expect(list[0].irreversible).toBe(true)
    // It is the only one. If a second step ever claims to be unrecoverable,
    // that is a decision someone should have to make deliberately.
    expect(list.filter((s) => s.irreversible)).toHaveLength(1)
  })

  it('says there is nothing at risk when no vault exists', async () => {
    expect((await step('pin')).status).toMatch(/No vault has been set up/)
  })

  it('counts the names that would be lost once there are any', async () => {
    await setupVault(db, ASSEMBLY_ID, 'correct-horse-battery', ACTOR, NOW)
    await createDonor(
      db, ASSEMBLY_ID,
      { name: 'Ruhiyyih Nakhjavani', contact: null, secret: 'correct-horse-battery' },
      ACTOR, NOW,
    )
    expect((await step('pin')).status).toMatch(/1 donor name would become unreadable/)
  })

  it('counts only the months that have ended, not the ones still to come', async () => {
    // Kamál has ended and is closed but not presented. Asmáʼ is still running
    // and belongs to whoever holds the books next.
    expect((await step('reports')).status).toBe(
      'One month has ended without its report being presented.',
    )
  })

  it('reports the last statement proved against the bank', async () => {
    expect((await step('reconcile')).status).toBe('Reconciled to 2026-08-19.')
  })

  it('counts what is left uncategorised and unreceipted', async () => {
    expect((await step('tidy')).status).toBe(
      '7 transactions uncategorised, 2 contributions still awaiting a receipt.',
    )
  })

  it('counts the rows so a successor can check the file arrived whole', async () => {
    const v = (await view(db))!
    expect(v.counts.transactions).toBe(85)
    expect(v.counts.audit_log).toBeGreaterThan(0)
    expect(v.schemaVersion).toBe(HANDOFF_SCHEMA_VERSION)
  })

  it('returns nothing for an assembly that does not exist', async () => {
    expect(await loadHandoff(db, 'nowhere', SEED_YEAR, SEED_TODAY, ACTOR)).toBeNull()
  })
})

describe('the handoff API', () => {
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

  it('serves the checklist', async () => {
    const response = (await call('/api/handoff/current'))!
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.steps).toHaveLength(7)
    expect(body.assemblyName).toContain('Riverbend')
  })

  it('serves the export as a named download, not as a page', async () => {
    const response = (await call('/api/handoff/export'))!
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="bedrock-riverbend-2026-08-28.json"',
    )
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json()
    expect(body.tables.transactions).toHaveLength(85)
  })
})

describe('the scoping constant', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await freshDatabase()
  })

  it('still matches the schema', async () => {
    // Which tables carry assembly_id is stated as a constant rather than asked
    // of the database, because both ways of asking it work in node:sqlite and
    // fail against D1 — sqlite_master is refused by the Worker's authorizer,
    // and twenty UNION ALL terms exceed D1's compound SELECT limit. This test
    // is the thing that keeps the constant honest, and it can afford to ask
    // properly because pragma queries are free here.
    const actual = new Set<string>()
    for (const table of RESTORE_ORDER) {
      const row = await db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM pragma_table_info(?) WHERE name = 'assembly_id'`,
        [table],
      )
      if ((row?.n ?? 0) === 0) actual.add(table)
    }
    expect([...actual].sort()).toEqual([...tablesWithoutAssemblyId()].sort())
  })

  it('scopes the export to one Assembly wherever it can', async () => {
    // A second Assembly's rows must not ride along in someone else's export.
    await db.run(
      `INSERT INTO assemblies (id, name, short_name, created_at)
       VALUES ('elsewhere', 'Another Assembly', 'Elsewhere', '2026-01-01T00:00:00Z')`,
    )
    await db.run(
      `INSERT INTO accounts (id, assembly_id, name, kind, opening_balance_cents)
       VALUES ('acct-elsewhere', 'elsewhere', 'Their bank', 'bank', 999)`,
    )

    const bundle = await exportEverything(db, ASSEMBLY_ID, NOW, ACTOR)
    expect(bundle.tables.accounts.map((a) => a.id)).not.toContain('acct-elsewhere')
    expect(bundle.tables.accounts).toHaveLength(2)
  })
})
