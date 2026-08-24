/**
 * The donor vault.
 *
 * Everything that can turn a donor_id into a person lives in this file, and
 * every function that does it takes a PIN. Nothing else in the codebase reads
 * the `donors` table — the aggregate reports are built entirely from
 * `contributions`, which holds plaintext amounts against opaque ids. A test
 * proves that by renaming the table away and asserting the dashboard, the
 * Feast report and the year summary all still work.
 */

import type { SqlDatabase } from '../db/adapter'
import { setAuditActor } from '../db/adapter'
import {
  checkVerifier,
  DEFAULT_ITERATIONS,
  decryptField,
  deriveKey,
  encryptField,
  makeVerifier,
  randomSalt,
  VaultError,
} from '../vault/crypto'

export { VaultError }

interface VaultRow {
  kdf_salt: string
  kdf_iterations: number
  verifier: string
}

export interface VaultStatus {
  readonly configured: boolean
  readonly donorCount: number
}

export async function vaultStatus(
  db: SqlDatabase,
  assemblyId: string,
): Promise<VaultStatus> {
  const row = await db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM vault WHERE assembly_id = ?',
    [assemblyId],
  )
  // A count is not identifying: it says how many households have given, which
  // the Feast report already prints.
  const donors = await db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM donors WHERE assembly_id = ? AND is_anonymous = 0',
    [assemblyId],
  )
  return { configured: (row?.n ?? 0) > 0, donorCount: donors?.n ?? 0 }
}

/**
 * Set the PIN for the first time.
 *
 * Deliberately refuses if a vault already exists. Re-keying would need every
 * donor record decrypted with the old PIN and re-encrypted with the new one,
 * which is a different operation with a different failure mode; see
 * `changeSecret`.
 */
export async function setupVault(
  db: SqlDatabase,
  assemblyId: string,
  secret: string,
  actor: string,
  now: string,
): Promise<void> {
  const existing = await db.get<VaultRow>(
    'SELECT kdf_salt FROM vault WHERE assembly_id = ?',
    [assemblyId],
  )
  if (existing) {
    throw new VaultError('A PIN is already set for these donor records.')
  }

  const salt = randomSalt()
  const key = await deriveKey(secret, salt, DEFAULT_ITERATIONS)

  await setAuditActor(db, actor)
  await db.run(
    `INSERT INTO vault (assembly_id, kdf_salt, kdf_iterations, verifier, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [assemblyId, salt, DEFAULT_ITERATIONS, await makeVerifier(key), now, now],
  )
}

/** Derive the key for this request, proving the PIN first. */
async function openVault(
  db: SqlDatabase,
  assemblyId: string,
  secret: string,
): Promise<CryptoKey> {
  const row = await db.get<VaultRow>(
    'SELECT kdf_salt, kdf_iterations, verifier FROM vault WHERE assembly_id = ?',
    [assemblyId],
  )
  if (!row) {
    throw new VaultError('No PIN has been set for these donor records yet.')
  }

  const key = await deriveKey(secret, row.kdf_salt, row.kdf_iterations)
  if (!(await checkVerifier(key, row.verifier))) {
    throw new VaultError('That PIN does not open the donor records.')
  }
  return key
}

/** Check a PIN without reading anything. Used by the unlock screen. */
export async function verifySecret(
  db: SqlDatabase,
  assemblyId: string,
  secret: string,
): Promise<boolean> {
  try {
    await openVault(db, assemblyId, secret)
    return true
  } catch {
    return false
  }
}

async function logAccess(
  db: SqlDatabase,
  assemblyId: string,
  donorId: string | null,
  reason: string,
  actor: string,
  now: string,
): Promise<void> {
  await db.run(
    `INSERT INTO donor_access_log (assembly_id, donor_id, reason, actor, occurred_at)
     VALUES (?, ?, ?, ?, ?)`,
    [assemblyId, donorId, reason, actor, now],
  )
}

export interface DonorView {
  readonly id: string
  readonly name: string | null
  readonly contact: string | null
  readonly isAnonymous: boolean
}

/** Record a donor. The name is encrypted before it reaches the database. */
export async function createDonor(
  db: SqlDatabase,
  assemblyId: string,
  input: { name: string; contact?: string | null; secret: string },
  actor: string,
  now: string,
): Promise<string> {
  const key = await openVault(db, assemblyId, input.secret)
  await setAuditActor(db, actor)

  const id = `donor-${crypto.randomUUID()}`
  await db.run(
    `INSERT INTO donors (id, assembly_id, name_encrypted, contact_encrypted, is_anonymous, created_at)
     VALUES (?, ?, ?, ?, 0, ?)`,
    [
      id,
      assemblyId,
      await encryptField(key, input.name),
      input.contact ? await encryptField(key, input.contact) : null,
      now,
    ],
  )
  return id
}

/**
 * A cash gift given without a name.
 *
 * Needs no PIN because there is nothing to encrypt. §4 asks for this
 * explicitly: a treasurer holding an envelope at Feast should not have to
 * invent an identity to record the money.
 */
export async function createAnonymousDonor(
  db: SqlDatabase,
  assemblyId: string,
  actor: string,
  now: string,
): Promise<string> {
  await setAuditActor(db, actor)
  const id = `donor-anon-${crypto.randomUUID()}`
  await db.run(
    `INSERT INTO donors (id, assembly_id, name_encrypted, contact_encrypted, is_anonymous, created_at)
     VALUES (?, ?, NULL, NULL, 1, ?)`,
    [id, assemblyId, now],
  )
  return id
}

/** One donor, decrypted. Logged. */
export async function readDonor(
  db: SqlDatabase,
  assemblyId: string,
  donorId: string,
  secret: string,
  reason: string,
  actor: string,
  now: string,
): Promise<DonorView | null> {
  const key = await openVault(db, assemblyId, secret)
  const row = await db.get<{
    id: string
    name_encrypted: string | null
    contact_encrypted: string | null
    is_anonymous: number
  }>(
    `SELECT id, name_encrypted, contact_encrypted, is_anonymous
       FROM donors WHERE assembly_id = ? AND id = ?`,
    [assemblyId, donorId],
  )
  if (!row) return null

  await logAccess(db, assemblyId, donorId, reason, actor, now)

  return {
    id: row.id,
    name: row.name_encrypted ? await decryptField(key, row.name_encrypted) : null,
    contact: row.contact_encrypted
      ? await decryptField(key, row.contact_encrypted)
      : null,
    isAnonymous: row.is_anonymous === 1,
  }
}

/**
 * Every donor, decrypted, for issuing a receipt or for the Assembly's own
 * internal oversight. One log entry for the whole list rather than fifty.
 */
export async function listDonors(
  db: SqlDatabase,
  assemblyId: string,
  secret: string,
  reason: string,
  actor: string,
  now: string,
): Promise<DonorView[]> {
  const key = await openVault(db, assemblyId, secret)
  const rows = await db.all<{
    id: string
    name_encrypted: string | null
    contact_encrypted: string | null
    is_anonymous: number
  }>(
    `SELECT id, name_encrypted, contact_encrypted, is_anonymous
       FROM donors WHERE assembly_id = ? ORDER BY created_at`,
    [assemblyId],
  )

  await logAccess(db, assemblyId, null, reason, actor, now)

  const out: DonorView[] = []
  for (const row of rows) {
    out.push({
      id: row.id,
      name: row.name_encrypted ? await decryptField(key, row.name_encrypted) : null,
      contact: row.contact_encrypted
        ? await decryptField(key, row.contact_encrypted)
        : null,
      isAnonymous: row.is_anonymous === 1,
    })
  }
  return out
}

export interface AccessLogEntry {
  readonly donorId: string | null
  readonly reason: string
  readonly actor: string
  readonly occurredAt: string
}

/**
 * Who has looked at donor detail, and when.
 *
 * Readable without the PIN, deliberately: the point of the log is oversight,
 * and oversight that only the person being overseen can read is not oversight.
 * It records that a name was read, never the name.
 */
export async function readAccessLog(
  db: SqlDatabase,
  assemblyId: string,
  limit = 100,
): Promise<AccessLogEntry[]> {
  const rows = await db.all<{
    donor_id: string | null
    reason: string
    actor: string
    occurred_at: string
  }>(
    `SELECT donor_id, reason, actor, occurred_at FROM donor_access_log
      WHERE assembly_id = ? ORDER BY id DESC LIMIT ?`,
    [assemblyId, limit],
  )
  return rows.map((r) => ({
    donorId: r.donor_id,
    reason: r.reason,
    actor: r.actor,
    occurredAt: r.occurred_at,
  }))
}

/**
 * Change the PIN, re-encrypting every donor record.
 *
 * Reads everything with the old key and writes it back with the new one. If
 * this fails partway the vault row is left on the OLD parameters, so the
 * records that were already rewritten would be unreadable — which is why the
 * vault row is updated last and the whole thing is worth a backup first.
 */
export async function changeSecret(
  db: SqlDatabase,
  assemblyId: string,
  oldSecret: string,
  newSecret: string,
  actor: string,
  now: string,
): Promise<number> {
  const oldKey = await openVault(db, assemblyId, oldSecret)
  const salt = randomSalt()
  const newKey = await deriveKey(newSecret, salt, DEFAULT_ITERATIONS)

  await setAuditActor(db, actor)
  const rows = await db.all<{
    id: string
    name_encrypted: string | null
    contact_encrypted: string | null
  }>(
    `SELECT id, name_encrypted, contact_encrypted FROM donors
      WHERE assembly_id = ? AND (name_encrypted IS NOT NULL OR contact_encrypted IS NOT NULL)`,
    [assemblyId],
  )

  for (const row of rows) {
    await db.run(
      'UPDATE donors SET name_encrypted = ?, contact_encrypted = ? WHERE id = ?',
      [
        row.name_encrypted
          ? await encryptField(newKey, await decryptField(oldKey, row.name_encrypted))
          : null,
        row.contact_encrypted
          ? await encryptField(newKey, await decryptField(oldKey, row.contact_encrypted))
          : null,
        row.id,
      ],
    )
  }

  await db.run(
    `UPDATE vault SET kdf_salt = ?, kdf_iterations = ?, verifier = ?, updated_at = ?
      WHERE assembly_id = ?`,
    [salt, DEFAULT_ITERATIONS, await makeVerifier(newKey), now, assemblyId],
  )
  return rows.length
}
