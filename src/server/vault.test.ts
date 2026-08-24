import { beforeEach, describe, expect, it } from 'vitest'
import { formatMoney } from '../lib/money'
import { migrate } from './db/migrate'
import { openNodeDatabase, type NodeSqlDatabase } from './db/node-sqlite'
import {
  changeSecret,
  createAnonymousDonor,
  createDonor,
  listDonors,
  readAccessLog,
  readDonor,
  setupVault,
  vaultStatus,
  VaultError,
  verifySecret,
} from './repo/donors'
import {
  issueReceipt,
  listReceipts,
  nextReceiptNumber,
  ReceiptError,
  receiptSummary,
  unreceiptedGifts,
  voidReceipt,
} from './repo/receipts'
import { loadYear } from './repo/year'
import { loadReport, loadYearSummary } from './repo/report'
import { ASSEMBLY_ID, SEED_TODAY, SEED_YEAR, seed } from './seed'
import { MIN_SECRET_LENGTH } from './vault/crypto'

const NOW = '2026-08-28T12:00:00Z'
const ACTOR = 'treasurer@riverbend'
const PIN = 'riverbend-2026'

async function freshDatabase(): Promise<NodeSqlDatabase> {
  const db = openNodeDatabase(':memory:')
  await migrate(db)
  await seed(db)
  return db
}

describe('setting up the vault', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await freshDatabase()
  })

  it('starts unconfigured', async () => {
    expect((await vaultStatus(db, ASSEMBLY_ID)).configured).toBe(false)
  })

  it('accepts a PIN and can then verify it', async () => {
    await setupVault(db, ASSEMBLY_ID, PIN, ACTOR, NOW)
    expect((await vaultStatus(db, ASSEMBLY_ID)).configured).toBe(true)
    expect(await verifySecret(db, ASSEMBLY_ID, PIN)).toBe(true)
    expect(await verifySecret(db, ASSEMBLY_ID, 'not-the-pin')).toBe(false)
  })

  it('refuses a PIN short enough to be guessed in an afternoon', async () => {
    await expect(setupVault(db, ASSEMBLY_ID, '1234', ACTOR, NOW)).rejects.toThrow(
      new RegExp(`at least ${MIN_SECRET_LENGTH}`),
    )
  })

  it('will not silently replace an existing PIN', async () => {
    await setupVault(db, ASSEMBLY_ID, PIN, ACTOR, NOW)
    await expect(setupVault(db, ASSEMBLY_ID, 'another-one', ACTOR, NOW)).rejects.toThrow(
      /already set/,
    )
  })

  it('stores nothing that reveals the PIN', async () => {
    await setupVault(db, ASSEMBLY_ID, PIN, ACTOR, NOW)
    const row = await db.get<{ kdf_salt: string; verifier: string }>(
      'SELECT kdf_salt, verifier FROM vault',
    )
    expect(row!.verifier).not.toContain(PIN)
    expect(row!.kdf_salt).not.toContain(PIN)
  })
})

describe('donor records', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await freshDatabase()
    await setupVault(db, ASSEMBLY_ID, PIN, ACTOR, NOW)
  })

  it('never writes a name in plaintext', async () => {
    const id = await createDonor(
      db, ASSEMBLY_ID, { name: 'Ruhiyyih Nakhjavani', secret: PIN }, ACTOR, NOW,
    )
    const stored = await db.get<{ name_encrypted: string }>(
      'SELECT name_encrypted FROM donors WHERE id = ?',
      [id],
    )
    expect(stored!.name_encrypted).not.toContain('Ruhiyyih')
    expect(stored!.name_encrypted).not.toContain('Nakhjavani')

    // ...and the name is nowhere else in the database either.
    const everywhere = await db.all<{ v: string }>(
      `SELECT after_json AS v FROM audit_log WHERE after_json LIKE '%Ruhiyyih%'
       UNION ALL SELECT before_json FROM audit_log WHERE before_json LIKE '%Ruhiyyih%'`,
    )
    expect(everywhere).toHaveLength(0)
  })

  it('reads the name back with the right PIN', async () => {
    const id = await createDonor(
      db, ASSEMBLY_ID,
      { name: 'Ruhiyyih Nakhjavani', contact: 'ruhiyyih@example.org', secret: PIN },
      ACTOR, NOW,
    )
    const donor = await readDonor(db, ASSEMBLY_ID, id, PIN, 'issuing a receipt', ACTOR, NOW)
    expect(donor!.name).toBe('Ruhiyyih Nakhjavani')
    expect(donor!.contact).toBe('ruhiyyih@example.org')
  })

  it('refuses the wrong PIN rather than returning garbage', async () => {
    const id = await createDonor(db, ASSEMBLY_ID, { name: 'Someone', secret: PIN }, ACTOR, NOW)
    await expect(
      readDonor(db, ASSEMBLY_ID, id, 'wrong-pin-entirely', 'poking', ACTOR, NOW),
    ).rejects.toThrow(VaultError)
  })

  it('encrypts the same name differently every time', async () => {
    // A fresh IV per field, so the database cannot be mined for repeats.
    const a = await createDonor(db, ASSEMBLY_ID, { name: 'Same Name', secret: PIN }, ACTOR, NOW)
    const b = await createDonor(db, ASSEMBLY_ID, { name: 'Same Name', secret: PIN }, ACTOR, NOW)
    const rows = await db.all<{ name_encrypted: string }>(
      'SELECT name_encrypted FROM donors WHERE id IN (?, ?)',
      [a, b],
    )
    expect(rows[0].name_encrypted).not.toBe(rows[1].name_encrypted)
  })

  it('takes an anonymous gift without needing the PIN at all', async () => {
    const id = await createAnonymousDonor(db, ASSEMBLY_ID, ACTOR, NOW)
    const row = await db.get<{ is_anonymous: number; name_encrypted: string | null }>(
      'SELECT is_anonymous, name_encrypted FROM donors WHERE id = ?',
      [id],
    )
    expect(row!.is_anonymous).toBe(1)
    expect(row!.name_encrypted).toBeNull()
  })

  it('records every look at donor detail, without recording the name', async () => {
    const id = await createDonor(db, ASSEMBLY_ID, { name: 'Ruhiyyih', secret: PIN }, ACTOR, NOW)
    await readDonor(db, ASSEMBLY_ID, id, PIN, 'issuing a receipt', ACTOR, NOW)
    await listDonors(db, ASSEMBLY_ID, PIN, 'annual review', ACTOR, NOW)

    const log = await readAccessLog(db, ASSEMBLY_ID)
    expect(log).toHaveLength(2)
    expect(log.map((e) => e.reason)).toContain('issuing a receipt')
    expect(log.every((e) => e.actor === ACTOR)).toBe(true)
    expect(JSON.stringify(log)).not.toContain('Ruhiyyih')
  })

  it('changes the PIN by re-encrypting every record', async () => {
    await createDonor(db, ASSEMBLY_ID, { name: 'First Donor', secret: PIN }, ACTOR, NOW)
    await createDonor(db, ASSEMBLY_ID, { name: 'Second Donor', secret: PIN }, ACTOR, NOW)

    const rekeyed = await changeSecret(db, ASSEMBLY_ID, PIN, 'a-new-passphrase', ACTOR, NOW)
    expect(rekeyed).toBe(2)

    expect(await verifySecret(db, ASSEMBLY_ID, PIN)).toBe(false)
    const donors = await listDonors(
      db, ASSEMBLY_ID, 'a-new-passphrase', 'checking', ACTOR, NOW,
    )
    // The seeded households have no name on file, so only the two created
    // here carry one — and both survive the re-key intact.
    const named = donors.map((d) => d.name).filter(Boolean).sort()
    expect(named).toEqual(['First Donor', 'Second Donor'])
  })
})

describe('receipts', () => {
  let db: NodeSqlDatabase
  let gift: { contributionId: string; amountCents: number }

  beforeEach(async () => {
    db = await freshDatabase()
    await setupVault(db, ASSEMBLY_ID, PIN, ACTOR, NOW)
    const awaiting = await unreceiptedGifts(db, ASSEMBLY_ID)
    gift = awaiting[0]
  })

  it('finds the cash gifts the dashboard says need one', async () => {
    const awaiting = await unreceiptedGifts(db, ASSEMBLY_ID)
    // The two cash gifts taken at Feast, neither yet receipted.
    expect(awaiting).toHaveLength(2)
    expect(awaiting.every((g) => g.method === 'cash')).toBe(true)
  })

  it('numbers from one and keeps going', async () => {
    expect(await nextReceiptNumber(db, ASSEMBLY_ID)).toBe(1)
    const first = await issueReceipt(
      db, ASSEMBLY_ID,
      { contributionId: gift.contributionId, donorId: null, note: null, issuedOn: SEED_TODAY },
      ACTOR,
    )
    expect(first.number).toBe(1)
    expect(first.amountCents).toBe(gift.amountCents)

    const second = (await unreceiptedGifts(db, ASSEMBLY_ID))[0]
    const next = await issueReceipt(
      db, ASSEMBLY_ID,
      { contributionId: second.contributionId, donorId: null, note: null, issuedOn: SEED_TODAY },
      ACTOR,
    )
    expect(next.number).toBe(2)
  })

  it('will not receipt the same contribution twice', async () => {
    await issueReceipt(
      db, ASSEMBLY_ID,
      { contributionId: gift.contributionId, donorId: null, note: null, issuedOn: SEED_TODAY },
      ACTOR,
    )
    await expect(
      issueReceipt(
        db, ASSEMBLY_ID,
        { contributionId: gift.contributionId, donorId: null, note: null, issuedOn: SEED_TODAY },
        ACTOR,
      ),
    ).rejects.toThrow(/already been issued/)
  })

  it('cannot be deleted, only voided, and the number is not reused', async () => {
    const one = await issueReceipt(
      db, ASSEMBLY_ID,
      { contributionId: gift.contributionId, donorId: null, note: null, issuedOn: SEED_TODAY },
      ACTOR,
    )
    await expect(db.run('DELETE FROM receipts WHERE id = ?', [one.id])).rejects.toThrow(
      /cannot be deleted/,
    )

    const voided = await voidReceipt(
      db, ASSEMBLY_ID, one.id, 'wrong amount entered', ACTOR, NOW,
    )
    expect(voided!.voidedAt).toBe(NOW)
    expect(voided!.voidReason).toBe('wrong amount entered')

    // The gift is free to be receipted again — with a NEW number. A gap in a
    // receipt book reads to an auditor as a destroyed record.
    const reissued = await issueReceipt(
      db, ASSEMBLY_ID,
      { contributionId: gift.contributionId, donorId: null, note: null, issuedOn: SEED_TODAY },
      ACTOR,
    )
    expect(reissued.number).toBe(2)

    const numbers = (await listReceipts(db, ASSEMBLY_ID)).map((r) => r.number).sort()
    expect(numbers).toEqual([1, 2])
  })

  it('insists on a reason for voiding', async () => {
    const one = await issueReceipt(
      db, ASSEMBLY_ID,
      { contributionId: gift.contributionId, donorId: null, note: null, issuedOn: SEED_TODAY },
      ACTOR,
    )
    await expect(
      voidReceipt(db, ASSEMBLY_ID, one.id, '   ', ACTOR, NOW),
    ).rejects.toThrow(ReceiptError)
  })

  it('lists receipts without decrypting anything', async () => {
    const donorId = await createDonor(
      db, ASSEMBLY_ID, { name: 'Ruhiyyih Nakhjavani', secret: PIN }, ACTOR, NOW,
    )
    await issueReceipt(
      db, ASSEMBLY_ID,
      { contributionId: gift.contributionId, donorId, note: null, issuedOn: SEED_TODAY },
      ACTOR,
    )

    const log = await listReceipts(db, ASSEMBLY_ID)
    expect(log[0].donorId).toBe(donorId)
    // The log carries the opaque id and nothing more. Reading a name from here
    // would make the PIN decorative.
    expect(JSON.stringify(log)).not.toContain('Ruhiyyih')
    expect(await readAccessLog(db, ASSEMBLY_ID)).toHaveLength(0)
  })

  it('summarises the book', async () => {
    await issueReceipt(
      db, ASSEMBLY_ID,
      { contributionId: gift.contributionId, donorId: null, note: null, issuedOn: SEED_TODAY },
      ACTOR,
    )
    const summary = await receiptSummary(db, ASSEMBLY_ID)
    expect(summary.issued).toBe(1)
    expect(summary.voided).toBe(0)
    expect(summary.nextNumber).toBe(2)
    expect(formatMoney(summary.totalCents)).toBe(formatMoney(gift.amountCents))
  })
})

describe('the reports never touch the donor table', () => {
  // The acceptance test for this phase, and the structural guarantee behind
  // §4. Every aggregate is built from `contributions`, which holds plaintext
  // amounts against opaque ids. Renaming `donors` out from under the app is
  // the bluntest way to prove nothing depends on it: if any reporting query
  // joined it, these would all throw.
  let db: NodeSqlDatabase

  beforeEach(async () => {
    db = await freshDatabase()
    await setupVault(db, ASSEMBLY_ID, PIN, ACTOR, NOW)
    await db.run('ALTER TABLE donors RENAME TO donors_hidden')
  })

  it('builds the year dashboard', async () => {
    const view = await loadYear(db, ASSEMBLY_ID, SEED_YEAR, SEED_TODAY)
    expect(formatMoney(view.onHandTodayCents)).toBe('$5,172.40')
  })

  it('builds a Feast report, household count and all', async () => {
    const report = (await loadReport(db, ASSEMBLY_ID, SEED_YEAR, 8))!
    expect(report.contributionCount).toBe(23)
    // The count comes from contributions.donor_id, an opaque column. Knowing
    // eleven households gave requires no access to who they are.
    expect(report.householdCount).toBe(11)
  })

  it('builds the year-end summary', async () => {
    const summary = (await loadYearSummary(db, ASSEMBLY_ID, SEED_YEAR))!
    expect(formatMoney(summary.closingCents)).toBe('$5,172.40')
  })

  it('lists the gifts still awaiting a receipt', async () => {
    expect(await unreceiptedGifts(db, ASSEMBLY_ID)).toHaveLength(2)
  })
})
