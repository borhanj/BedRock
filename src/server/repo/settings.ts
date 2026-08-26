/**
 * Settings: the books' description of themselves.
 *
 * Everything here was typed once during setup, by someone who had not used the
 * software yet and was guessing at some of it. An account name is wrong, a fund
 * the Assembly does not actually keep got ticked, the letterhead was never
 * uploaded. None of that is a transaction, and none of it should require
 * starting again.
 *
 * Two rules shape what this module will and will not do.
 *
 * **Renaming is allowed; removing is not.** A fund or category or account can
 * be renamed and can be retired from the lists a treasurer picks from, but
 * nothing that has ever had money against it is deleted. Every past report
 * points at these rows; deleting one would leave a presented report referring
 * to something that no longer exists, and a report that has been read aloud at
 * Feast cannot be quietly rewritten. Archiving keeps the history readable and
 * gets the row out of the way.
 *
 * **The exception is total.** `resetEverything` deletes the lot, and it exists
 * because "this database holds a demonstration" is a real state that a treasurer
 * has to be able to get out of without a command line. It is the only operation
 * in Bedrock that destroys records, it stands the schema's own guards down to do
 * it, and it refuses to run without the Assembly's name typed back.
 */

import type { Cents } from '../../lib/money'
import type { SqlDatabase, SqlStatement } from '../db/adapter'
import { setAuditActor } from '../db/adapter'

export class SettingsError extends Error {}

/**
 * The largest letterhead accepted, before base64 expansion.
 *
 * A logo at the top of a receipt does not need more, and the ceiling matters:
 * this lives in the database, is read on every receipt, and travels inside
 * every handover bundle. A treasurer who uploads a 12-megapixel photograph
 * should be told no rather than quietly given a slow app and a backup nobody
 * can email.
 */
export const LETTERHEAD_MAX_BYTES = 400_000

const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']

export interface AccountSetting {
  readonly id: string
  readonly name: string
  readonly kind: 'bank' | 'cash'
  readonly openingBalanceCents: Cents
  readonly isActive: boolean
  /** Rows posted to it. An account with movements cannot be made to vanish. */
  readonly transactionCount: number
}

export interface FundSetting {
  readonly id: string
  readonly key: string
  readonly label: string
  readonly isPassthrough: boolean
  readonly contributionCount: number
}

export interface CategorySetting {
  readonly id: string
  readonly label: string
  readonly kind: 'income' | 'expense'
  readonly isArchived: boolean
  readonly transactionCount: number
}

export interface BrandingView {
  readonly letterheadDataUrl: string | null
  readonly letterheadFilename: string | null
  readonly letterheadBytes: number | null
  readonly updatedAt: string | null
  readonly updatedBy: string | null
}

export interface SettingsView {
  readonly assemblyId: string
  readonly name: string
  readonly shortName: string
  readonly openedOn: string | null
  readonly accounts: readonly AccountSetting[]
  readonly funds: readonly FundSetting[]
  readonly categories: readonly CategorySetting[]
  readonly branding: BrandingView
  readonly letterheadMaxBytes: number
}

export async function loadSettings(
  db: SqlDatabase,
  assemblyId: string,
): Promise<SettingsView | null> {
  const assembly = await db.get<{ name: string; short_name: string; opened_on: string | null }>(
    'SELECT name, short_name, opened_on FROM assemblies WHERE id = ?',
    [assemblyId],
  )
  if (!assembly) return null

  const [accounts, funds, categories, branding] = await Promise.all([
    db.all<{
      id: string
      name: string
      kind: 'bank' | 'cash'
      opening_balance_cents: number
      is_active: number
      n: number
    }>(
      `SELECT a.id, a.name, a.kind, a.opening_balance_cents, a.is_active,
              (SELECT COUNT(*) FROM transactions t WHERE t.account_id = a.id) AS n
         FROM accounts a
        WHERE a.assembly_id = ?
        ORDER BY a.kind, a.name`,
      [assemblyId],
    ),
    db.all<{ id: string; key: string; label: string; is_passthrough: number; n: number }>(
      `SELECT f.id, f.key, f.label, f.is_passthrough,
              (SELECT COUNT(*) FROM contributions c WHERE c.fund_id = f.id) AS n
         FROM funds f
        WHERE f.assembly_id = ?
        ORDER BY f.sort_order`,
      [assemblyId],
    ),
    db.all<{
      id: string
      label: string
      kind: 'income' | 'expense'
      is_archived: number
      n: number
    }>(
      `SELECT c.id, c.label, c.kind, c.is_archived,
              (SELECT COUNT(*) FROM transactions t WHERE t.category_id = c.id) AS n
         FROM categories c
        WHERE c.assembly_id = ?
        ORDER BY c.kind, c.sort_order`,
      [assemblyId],
    ),
    db.get<{
      letterhead_data_url: string | null
      letterhead_filename: string | null
      letterhead_bytes: number | null
      updated_at: string | null
      updated_by: string | null
    }>(
      `SELECT letterhead_data_url, letterhead_filename, letterhead_bytes, updated_at, updated_by
         FROM branding WHERE assembly_id = ?`,
      [assemblyId],
    ),
  ])

  return {
    assemblyId,
    name: assembly.name,
    shortName: assembly.short_name,
    openedOn: assembly.opened_on,
    accounts: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      openingBalanceCents: a.opening_balance_cents,
      isActive: a.is_active === 1,
      transactionCount: a.n,
    })),
    funds: funds.map((f) => ({
      id: f.id,
      key: f.key,
      label: f.label,
      isPassthrough: f.is_passthrough === 1,
      contributionCount: f.n,
    })),
    categories: categories.map((c) => ({
      id: c.id,
      label: c.label,
      kind: c.kind,
      isArchived: c.is_archived === 1,
      transactionCount: c.n,
    })),
    branding: {
      letterheadDataUrl: branding?.letterhead_data_url ?? null,
      letterheadFilename: branding?.letterhead_filename ?? null,
      letterheadBytes: branding?.letterhead_bytes ?? null,
      updatedAt: branding?.updated_at ?? null,
      updatedBy: branding?.updated_by ?? null,
    },
    letterheadMaxBytes: LETTERHEAD_MAX_BYTES,
  }
}

/** Rename the Assembly. The id never changes — every row points at it. */
export async function renameAssembly(
  db: SqlDatabase,
  assemblyId: string,
  name: string,
  shortName: string,
  actor: string,
): Promise<void> {
  if (!name.trim()) throw new SettingsError('The Assembly needs a name.')
  await setAuditActor(db, actor)
  await db.run('UPDATE assemblies SET name = ?, short_name = ? WHERE id = ?', [
    name.trim(),
    shortName.trim() || name.trim(),
    assemblyId,
  ])
}

export interface NewAccount {
  readonly name: string
  readonly kind: 'bank' | 'cash'
  readonly openingBalanceCents: Cents
}

/**
 * Another account, opened partway through.
 *
 * Its opening balance counts from the day the books opened, the same as the
 * others — an account added later is one the Assembly already had and did not
 * record, not money appearing from nowhere. If it genuinely opened later with
 * nothing in it, the balance is zero and nothing moves.
 */
export async function addAccount(
  db: SqlDatabase,
  assemblyId: string,
  input: NewAccount,
  actor: string,
  now: string,
): Promise<string> {
  if (!input.name.trim()) throw new SettingsError('The account needs a name.')
  await setAuditActor(db, actor)

  const id = `acct-${assemblyId}-${now.replace(/[^0-9]/g, '')}`
  await db.run(
    `INSERT INTO accounts (id, assembly_id, name, kind, opening_balance_cents, is_active)
     VALUES (?, ?, ?, ?, ?, 1)`,
    [id, assemblyId, input.name.trim(), input.kind, input.openingBalanceCents],
  )
  return id
}

/**
 * Rename an account, or stop offering it.
 *
 * Never deleted. Every transaction posted to it names it, so removing the row
 * would leave rows in the ledger pointing at nothing — and the reconciliations
 * that proved those rows against a statement would lose the account they were
 * about. Deactivating takes it out of the lists without touching a figure.
 */
export async function updateAccount(
  db: SqlDatabase,
  assemblyId: string,
  accountId: string,
  patch: { name?: string; isActive?: boolean },
  actor: string,
): Promise<boolean> {
  await setAuditActor(db, actor)

  if (patch.name !== undefined && !patch.name.trim()) {
    throw new SettingsError('The account needs a name.')
  }

  const result = await db.run(
    `UPDATE accounts
        SET name = COALESCE(?, name),
            is_active = COALESCE(?, is_active)
      WHERE assembly_id = ? AND id = ?`,
    [
      patch.name?.trim() ?? null,
      patch.isActive === undefined ? null : patch.isActive ? 1 : 0,
      assemblyId,
      accountId,
    ],
  )
  return result.changes > 0
}

/**
 * Another fund, or a renamed one.
 *
 * A fund cannot change sides. Turning the Assembly's own fund into a
 * pass-through one, or the reverse, would silently re-partition every balance
 * the app has ever shown: the Assembly's own fund is the residual of that
 * partition, and there has to be exactly one. Making a second one is not a
 * setting, it is a different set of books.
 */
export async function addFund(
  db: SqlDatabase,
  assemblyId: string,
  input: { key: string; label: string },
  actor: string,
): Promise<string> {
  if (!input.label.trim()) throw new SettingsError('The fund needs a name.')
  const key = input.key.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
  if (!key) throw new SettingsError('The fund needs a short key, in letters and numbers.')

  const clash = await db.get('SELECT id FROM funds WHERE assembly_id = ? AND key = ?', [
    assemblyId,
    key,
  ])
  if (clash) throw new SettingsError(`There is already a fund with the key "${key}".`)

  await setAuditActor(db, actor)
  const id = `fund-${assemblyId}-${key}`
  const order = await db.get<{ n: number }>(
    'SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM funds WHERE assembly_id = ?',
    [assemblyId],
  )
  await db.run(
    `INSERT INTO funds (id, assembly_id, key, label, is_passthrough, sort_order)
     VALUES (?, ?, ?, ?, 1, ?)`,
    [id, assemblyId, key, input.label.trim(), order?.n ?? 1],
  )
  return id
}

export async function renameFund(
  db: SqlDatabase,
  assemblyId: string,
  fundId: string,
  label: string,
  actor: string,
): Promise<boolean> {
  if (!label.trim()) throw new SettingsError('The fund needs a name.')
  await setAuditActor(db, actor)
  const result = await db.run('UPDATE funds SET label = ? WHERE assembly_id = ? AND id = ?', [
    label.trim(),
    assemblyId,
    fundId,
  ])
  return result.changes > 0
}

export async function addCategory(
  db: SqlDatabase,
  assemblyId: string,
  input: { label: string; kind: 'income' | 'expense'; fundKey?: string | null },
  actor: string,
): Promise<string> {
  if (!input.label.trim()) throw new SettingsError('The category needs a name.')
  if (input.kind === 'expense' && input.fundKey) {
    throw new SettingsError(
      'An expense category cannot name a fund it feeds. Only income categories do that.',
    )
  }

  const clash = await db.get('SELECT id FROM categories WHERE assembly_id = ? AND label = ?', [
    assemblyId,
    input.label.trim(),
  ])
  if (clash) throw new SettingsError(`There is already a category called "${input.label.trim()}".`)

  let fundId: string | null = null
  if (input.fundKey) {
    const fund = await db.get<{ id: string }>(
      'SELECT id FROM funds WHERE assembly_id = ? AND key = ?',
      [assemblyId, input.fundKey],
    )
    if (!fund) throw new SettingsError(`No fund here is called "${input.fundKey}".`)
    fundId = fund.id
  }

  await setAuditActor(db, actor)
  const order = await db.get<{ n: number }>(
    'SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM categories WHERE assembly_id = ?',
    [assemblyId],
  )
  const id = `cat-${assemblyId}-${(order?.n ?? 1).toString().padStart(3, '0')}`
  await db.run(
    `INSERT INTO categories (id, assembly_id, label, kind, fund_id, sort_order, is_archived)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
    [id, assemblyId, input.label.trim(), input.kind, fundId, order?.n ?? 1],
  )
  return id
}

/**
 * Rename a category, or archive it.
 *
 * Archived rather than deleted, for the reason the whole module follows:
 * transactions and budget lines point at it, and a presented Feast report that
 * said "Rent / facility use" has to keep saying it.
 */
export async function updateCategory(
  db: SqlDatabase,
  assemblyId: string,
  categoryId: string,
  patch: { label?: string; isArchived?: boolean },
  actor: string,
): Promise<boolean> {
  if (patch.label !== undefined && !patch.label.trim()) {
    throw new SettingsError('The category needs a name.')
  }
  await setAuditActor(db, actor)
  const result = await db.run(
    `UPDATE categories
        SET label = COALESCE(?, label),
            is_archived = COALESCE(?, is_archived)
      WHERE assembly_id = ? AND id = ?`,
    [
      patch.label?.trim() ?? null,
      patch.isArchived === undefined ? null : patch.isArchived ? 1 : 0,
      assemblyId,
      categoryId,
    ],
  )
  return result.changes > 0
}

/**
 * Put the Assembly's letterhead at the top of its receipts.
 *
 * Validated here rather than trusted from the browser: the size ceiling and the
 * list of image types are the only things standing between this and a database
 * row holding an arbitrary file. A data URL that is not an image is refused
 * outright — this string is rendered into a page, and `data:text/html` in an
 * `<img src>` is the kind of thing that only looks harmless.
 */
export async function setLetterhead(
  db: SqlDatabase,
  assemblyId: string,
  dataUrl: string,
  filename: string | null,
  actor: string,
  now: string,
): Promise<void> {
  const match = /^data:([a-z0-9/+.-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl.trim())
  if (!match) {
    throw new SettingsError(
      'That is not an image file this can read. Upload a PNG, JPEG, GIF, WebP or SVG.',
    )
  }

  const [, mediaType, base64] = match
  if (!ALLOWED_IMAGE_TYPES.includes(mediaType.toLowerCase())) {
    throw new SettingsError(
      `${mediaType} is not an image type this accepts. Use a PNG, JPEG, GIF, WebP or SVG.`,
    )
  }

  // The decoded size, which is what the file actually is — base64 inflates by
  // about a third and a ceiling on the encoded string would be a ceiling on the
  // wrong number.
  const bytes = Math.floor((base64.length * 3) / 4)
  if (bytes > LETTERHEAD_MAX_BYTES) {
    throw new SettingsError(
      `That image is ${Math.round(bytes / 1024)}kB. The limit is ` +
        `${Math.round(LETTERHEAD_MAX_BYTES / 1024)}kB — it is stored in the database, ` +
        'read on every receipt, and carried inside every backup, so a photograph would ' +
        'make all three slower. Scale it down or export it smaller.',
    )
  }

  await setAuditActor(db, actor)
  await db.run(
    `INSERT INTO branding
       (assembly_id, letterhead_data_url, letterhead_filename, letterhead_bytes, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (assembly_id) DO UPDATE SET
       letterhead_data_url = excluded.letterhead_data_url,
       letterhead_filename = excluded.letterhead_filename,
       letterhead_bytes    = excluded.letterhead_bytes,
       updated_at          = excluded.updated_at,
       updated_by          = excluded.updated_by`,
    [assemblyId, dataUrl.trim(), filename, bytes, now, actor],
  )
}

export async function clearLetterhead(
  db: SqlDatabase,
  assemblyId: string,
  actor: string,
  now: string,
): Promise<void> {
  await setAuditActor(db, actor)
  await db.run(
    `UPDATE branding
        SET letterhead_data_url = NULL, letterhead_filename = NULL,
            letterhead_bytes = NULL, updated_at = ?, updated_by = ?
      WHERE assembly_id = ?`,
    [now, actor, assemblyId],
  )
}

/** Just the letterhead, for the receipt to print. */
export async function loadLetterhead(
  db: SqlDatabase,
  assemblyId: string,
): Promise<string | null> {
  const row = await db.get<{ letterhead_data_url: string | null }>(
    'SELECT letterhead_data_url FROM branding WHERE assembly_id = ?',
    [assemblyId],
  )
  return row?.letterhead_data_url ?? null
}

/**
 * Every table, in the order a delete can safely walk them.
 *
 * Children before parents, so a foreign key is never left dangling mid-way.
 * `audit_log` is last on purpose: the deletes above it fire audit triggers that
 * write into it, and clearing it first would leave those entries behind as the
 * only surviving trace of books that no longer exist.
 */
const WIPE_ORDER = [
  'reconciliation_items',
  'reconciliations',
  'budgets',
  'budget_years',
  'donor_access_log',
  'attachments',
  'receipts',
  'remittances',
  'contributions',
  'transactions',
  'import_batches',
  'reports',
  'rules',
  'opening_checkpoints',
  'fund_openings',
  'categories',
  'funds',
  'accounts',
  'donors',
  'vault',
  'branding',
  'assemblies',
  'audit_log',
] as const

export interface ResetResult {
  readonly assemblyName: string
  readonly rowsDeleted: number
  readonly tables: Readonly<Record<string, number>>
}

/**
 * Delete everything and leave a database ready to be set up again.
 *
 * The only operation in Bedrock that destroys records rather than superseding
 * them, and it exists for one real situation: a deployment filled with a
 * demonstration, which a treasurer has to be able to clear without a command
 * line before it can hold anything true.
 *
 * Three things guard it. The Assembly's name has to be typed back, so it cannot
 * be reached by a mis-click. The schema's own delete guards are stood down for
 * the duration and put back immediately, in the same batch, so a failure part
 * way through cannot leave a database where receipts are deletable. And the
 * caller is expected to have offered a backup first — this module cannot
 * enforce that, which is exactly why the screen that calls it puts the download
 * in front of the button.
 *
 * What it destroys includes the audit trail. That is not a side effect to be
 * softened: an audit trail of books that no longer exist is not evidence of
 * anything, and leaving it behind would make the next Assembly's first report
 * carry entries about a community it has never heard of.
 */
export async function resetEverything(
  db: SqlDatabase,
  assemblyId: string,
  confirmation: string,
  actor: string,
): Promise<ResetResult> {
  const assembly = await db.get<{ name: string }>(
    'SELECT name FROM assemblies WHERE id = ?',
    [assemblyId],
  )
  if (!assembly) throw new SettingsError('There are no books here to clear.')

  if (confirmation.trim() !== assembly.name) {
    throw new SettingsError(
      `To clear these books, type the Assembly's name back exactly: "${assembly.name}". ` +
        'This deletes every transaction, receipt, report and audit entry, and it cannot ' +
        'be undone from inside the app — only by restoring a backup.',
    )
  }

  const counts: Record<string, number> = {}
  for (const table of WIPE_ORDER) {
    const row = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)
    counts[table] = row?.n ?? 0
  }

  await setAuditActor(db, actor)

  const statements: SqlStatement[] = [
    {
      sql: `INSERT INTO reset_guard (id, resetting) VALUES (1, 1)
            ON CONFLICT (id) DO UPDATE SET resetting = 1`,
    },
    ...WIPE_ORDER.map((table) => ({ sql: `DELETE FROM ${table}` })),
    // Put the guards back up in the same batch that took them down. If the
    // deletes fail, this rolls back with them and the database is protected
    // again by virtue of the whole thing never having happened.
    { sql: 'UPDATE reset_guard SET resetting = 0 WHERE id = 1' },
  ]

  await db.batch(statements)

  // Belt and braces: the batch above restores it, but a database left with the
  // guards down is bad enough to be worth a second, unconditional attempt.
  await db.run('UPDATE reset_guard SET resetting = 0 WHERE id = 1')

  return {
    assemblyName: assembly.name,
    rowsDeleted: Object.values(counts).reduce((sum, n) => sum + n, 0),
    tables: counts,
  }
}
