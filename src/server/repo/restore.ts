/**
 * Reading a handoff bundle back in.
 *
 * The export has been able to write a complete book since Phase 7; nothing
 * could read one. That made "the file below is the backup" a claim rather than
 * a capability, which is a bad thing for an Assembly to have been told.
 *
 * Three rules shape this module.
 *
 * **It refuses to restore over anything.** The target must not already hold
 * the bundle's Assembly. Merging a file into live books, or overwriting them,
 * is the operation most likely to be reached for in a panic and most likely to
 * destroy the thing it was meant to save. A restore goes into an empty place;
 * if the books are already there, what is wanted is not a restore.
 *
 * **It checks everything before it writes anything.** The whole bundle is
 * validated first — shape, version, money, and every reference between tables
 * — because the alternative is discovering the file was truncated after half
 * of it is in the database. This matters more than usual here: the rows go in
 * as batches, and while a batch is atomic the restore as a whole is not, so a
 * failure part way through leaves the batches that already committed. The
 * pre-flight is what makes that unlikely, and the empty-target rule is what
 * makes it recoverable — wipe and try again.
 *
 * **It keeps the original audit trail.** The rows come back with their own
 * actors and timestamps; the trigger entries the restore itself generates are
 * attributed to a string that says so, so the two can never be confused. An
 * auditor reading the log afterwards can see both what happened originally and
 * that this database learned it in one go on a later date.
 */

import type { Cents } from '../../lib/money'
import type { SqlDatabase, SqlStatement, SqlValue } from '../db/adapter'
import { setAuditActor } from '../db/adapter'
import {
  HANDOFF_SCHEMA_VERSION,
  RENUMBERED_ON_RESTORE,
  RESTORE_ORDER,
  type HandoffBundle,
} from './handoff'

/** A bundle that cannot be restored, with the reason. */
export class RestoreError extends Error {}

export interface BundleReport {
  readonly schemaVersion: number
  readonly exportedAt: string
  readonly exportedBy: string
  readonly assemblyId: string
  /** From the bundle's own `assemblies` row, so it can be named before loading. */
  readonly assemblyName: string | null
  readonly counts: Readonly<Record<string, number>>
  readonly totalRows: number
  /** Money the bundle accounts for, as a figure a person can recognise. */
  readonly onHandCents: Cents
  /** Anything that stops the restore. Empty means it can proceed. */
  readonly problems: readonly string[]
  /** True, worth saying, and not blocking. */
  readonly notes: readonly string[]
  readonly canRestore: boolean
}

/**
 * References the bundle has to satisfy on its own, before it touches a
 * database. A truncated or hand-edited file fails here rather than half way
 * through the load.
 */
const REFERENCES: ReadonlyArray<{
  from: string
  column: string
  to: string
  /** Null is allowed — an unassigned fund, an anonymous gift. */
  optional?: boolean
}> = [
  { from: 'accounts', column: 'assembly_id', to: 'assemblies' },
  { from: 'funds', column: 'assembly_id', to: 'assemblies' },
  { from: 'categories', column: 'assembly_id', to: 'assemblies' },
  { from: 'fund_openings', column: 'assembly_id', to: 'assemblies' },
  { from: 'opening_checkpoints', column: 'assembly_id', to: 'assemblies' },
  { from: 'branding', column: 'assembly_id', to: 'assemblies' },
  // Optional: a null fund_id is the unexplained remainder, which belongs to
  // no fund by definition. See repo/opening.ts.
  { from: 'fund_openings', column: 'fund_id', to: 'funds', optional: true },
  { from: 'categories', column: 'fund_id', to: 'funds', optional: true },
  { from: 'transactions', column: 'account_id', to: 'accounts' },
  { from: 'transactions', column: 'fund_id', to: 'funds', optional: true },
  { from: 'transactions', column: 'category_id', to: 'categories', optional: true },
  { from: 'contributions', column: 'transaction_id', to: 'transactions' },
  { from: 'contributions', column: 'fund_id', to: 'funds' },
  { from: 'contributions', column: 'donor_id', to: 'donors', optional: true },
  { from: 'receipts', column: 'fund_id', to: 'funds' },
  { from: 'receipts', column: 'donor_id', to: 'donors', optional: true },
  { from: 'remittances', column: 'fund_id', to: 'funds' },
  { from: 'remittances', column: 'transaction_id', to: 'transactions', optional: true },
  { from: 'attachments', column: 'transaction_id', to: 'transactions', optional: true },
  { from: 'budgets', column: 'category_id', to: 'categories' },
  { from: 'reconciliations', column: 'account_id', to: 'accounts' },
  {
    from: 'reconciliation_items',
    column: 'reconciliation_id',
    to: 'reconciliations',
  },
  { from: 'reconciliation_items', column: 'transaction_id', to: 'transactions' },
]

function rowsOf(bundle: HandoffBundle, table: string): readonly Record<string, SqlValue>[] {
  return bundle.tables?.[table] ?? []
}

/**
 * Is this a Bedrock bundle at all, and is it internally sound?
 *
 * Pure: takes no database and writes nothing, so a treasurer can be shown what
 * a file contains before deciding anything. `planRestore` adds the checks that
 * need to look at the target.
 */
export function inspectBundle(raw: unknown): BundleReport {
  const problems: string[] = []
  const notes: string[] = []

  if (raw === null || typeof raw !== 'object') {
    throw new RestoreError('That file is not a Bedrock export.')
  }
  const bundle = raw as HandoffBundle

  if (typeof bundle.schemaVersion !== 'number' || typeof bundle.tables !== 'object') {
    throw new RestoreError(
      'That file is not a Bedrock export — it carries no schema version or no tables.',
    )
  }

  if (bundle.schemaVersion > HANDOFF_SCHEMA_VERSION) {
    // Refused rather than attempted. A newer export may hold tables or columns
    // this build has never heard of, and loading the parts it recognises would
    // produce books that look complete and are not.
    problems.push(
      `The file was written by a newer Bedrock (format ${bundle.schemaVersion}; this one ` +
        `reads ${HANDOFF_SCHEMA_VERSION}). Upgrade before restoring it — loading only the ` +
        'parts this version understands would produce books that look whole and are not.',
    )
  }

  if (!bundle.assemblyId) problems.push('The file names no Assembly.')

  const unknown = Object.keys(bundle.tables ?? {}).filter(
    (t) => !(RESTORE_ORDER as readonly string[]).includes(t),
  )
  if (unknown.length > 0) {
    problems.push(
      `The file holds tables this version does not know: ${unknown.join(', ')}.`,
    )
  }

  // ── money is whole cents, here as everywhere ─────────────────────────────
  //
  // A float that reached a `_cents` column would be a rounding error with a
  // long life ahead of it, and a hand-edited file is exactly where one would
  // come from.
  for (const table of RESTORE_ORDER) {
    for (const [i, row] of rowsOf(bundle, table).entries()) {
      for (const [column, value] of Object.entries(row)) {
        if (!column.endsWith('_cents')) continue
        if (value !== null && !Number.isInteger(value)) {
          problems.push(
            `${table} row ${i + 1}: ${column} is ${String(value)}, which is not a whole ` +
              'number of cents.',
          )
        }
      }
    }
  }

  // ── every reference resolves inside the file ─────────────────────────────
  for (const ref of REFERENCES) {
    const targets = new Set(rowsOf(bundle, ref.to).map((r) => r.id))
    let missing = 0
    for (const row of rowsOf(bundle, ref.from)) {
      const value = row[ref.column]
      if (value === null || value === undefined) {
        if (!ref.optional) missing += 1
        continue
      }
      if (!targets.has(value)) missing += 1
    }
    if (missing > 0) {
      problems.push(
        `${missing} row${missing === 1 ? '' : 's'} in ${ref.from} point at a ` +
          `${ref.to} that is not in the file. It looks truncated or edited.`,
      )
    }
  }

  const counts: Record<string, number> = {}
  let totalRows = 0
  for (const table of RESTORE_ORDER) {
    const n = rowsOf(bundle, table).length
    counts[table] = n
    totalRows += n
  }

  if (counts.transactions === 0) {
    notes.push('The file holds no transactions. It may be an empty book.')
  }
  if (counts.audit_log === 0 && counts.transactions > 0) {
    // Not blocking — but an audit trail is the thing that makes the rest
    // defensible, and its absence should be said out loud rather than noticed
    // later by an auditor.
    notes.push(
      'The file carries no audit trail. The figures can be restored; the record of who ' +
        'entered them cannot.',
    )
  }
  const encryptedNames = rowsOf(bundle, 'donors').filter(
    (d) => d.name_encrypted !== null && d.name_encrypted !== undefined,
  ).length
  if (encryptedNames > 0) {
    notes.push(
      `${encryptedNames} donor name${encryptedNames === 1 ? ' is' : 's are'} encrypted in ` +
        'this file. Without the PIN they stay unreadable after the restore — restoring ' +
        'does not recover them.',
    )
  }

  const opening = rowsOf(bundle, 'accounts').reduce(
    (sum, a) => sum + Number(a.opening_balance_cents ?? 0),
    0,
  )
  const flows = rowsOf(bundle, 'transactions').reduce(
    (sum, t) => sum + Number(t.amount_cents ?? 0),
    0,
  )

  return {
    schemaVersion: bundle.schemaVersion,
    exportedAt: String(bundle.exportedAt ?? ''),
    exportedBy: String(bundle.exportedBy ?? ''),
    assemblyId: String(bundle.assemblyId ?? ''),
    assemblyName:
      (rowsOf(bundle, 'assemblies').find((a) => a.id === bundle.assemblyId)?.name as
        | string
        | undefined) ?? null,
    counts,
    totalRows,
    onHandCents: opening + flows,
    problems,
    notes,
    canRestore: problems.length === 0,
  }
}

/** Everything `inspectBundle` finds, plus what the target database says. */
export async function planRestore(
  db: SqlDatabase,
  raw: unknown,
): Promise<BundleReport> {
  const report = inspectBundle(raw)
  const problems = [...report.problems]

  const existing = await db.get<{ name: string }>(
    'SELECT name FROM assemblies WHERE id = ?',
    [report.assemblyId],
  )
  if (existing) {
    problems.push(
      `This database already holds ${existing.name}. A restore goes into an empty place — ` +
        'it will not merge into books that are already here, and it will not overwrite ' +
        'them. If these are the wrong books, remove them deliberately first.',
    )
  }

  return { ...report, problems, canRestore: problems.length === 0 }
}

export interface RestoreResult {
  readonly assemblyId: string
  readonly assemblyName: string | null
  readonly rowsWritten: number
  readonly tables: Readonly<Record<string, number>>
  /** Audit entries carried across with their original actors and timestamps. */
  readonly auditRowsCarried: number
}

/**
 * Load a verified bundle into an empty database.
 *
 * Re-runs the full plan first rather than trusting a report the caller passed
 * in: between inspecting a file and pressing the button, the target may have
 * gained the very Assembly the bundle holds.
 */
export async function restore(
  db: SqlDatabase,
  raw: unknown,
  actor: string,
  now: string,
): Promise<RestoreResult> {
  const plan = await planRestore(db, raw)
  if (!plan.canRestore) {
    throw new RestoreError(plan.problems.join(' '))
  }
  const bundle = raw as HandoffBundle

  // Every row the triggers write while this runs is attributed to a string
  // that says what it was, so a later reader cannot mistake the restore for
  // ordinary activity by the person who ran it.
  await setAuditActor(
    db,
    `restore by ${actor} from a bundle exported ${plan.exportedAt || 'at an unstated time'}`,
  )

  const tables: Record<string, number> = {}
  let rowsWritten = 0

  // Every row of the bundle as one ordered list of writes, handed over in
  // batches rather than one at a time.
  //
  // A year of a real Assembly's books is thousands of rows once the audit
  // trail is counted, and a write per row is a network round trip per row
  // against D1. That is not merely slow: a Worker may only make so many, so
  // past a certain size the restore stopped part way through — which is the
  // one operation where being handed half the books is worst. Order still
  // matters and is preserved: a batch runs in the order it is given, and the
  // batches run in the order they are sent.
  const statements: SqlStatement[] = []

  for (const table of RESTORE_ORDER) {
    const rows = rowsOf(bundle, table)
    tables[table] = 0
    if (rows.length === 0) continue

    const drop = RENUMBERED_ON_RESTORE.has(table)
    for (const row of rows) {
      const entries = Object.entries(row).filter(([c]) => !(drop && c === 'id'))
      // A balanced reconciliation refuses changes to what has cleared, so the
      // statement goes in open and is closed once its items are loaded.
      const values = entries.map(([c, v]) =>
        table === 'reconciliations' && c === 'status' ? 'open' : v,
      )
      const columns = entries.map(([c]) => c)

      statements.push({
        sql: `INSERT INTO ${table} (${columns.join(', ')})
         VALUES (${columns.map(() => '?').join(', ')})`,
        params: values as SqlValue[],
      })
      tables[table] += 1
      rowsWritten += 1
    }
  }

  // Now that every cleared item is loaded, close the statements that were
  // closed when the bundle was taken. Last in the list, so they follow every
  // insert however the batches happen to divide.
  for (const row of rowsOf(bundle, 'reconciliations')) {
    if (row.status !== 'balanced') continue
    statements.push({
      sql: "UPDATE reconciliations SET status = 'balanced' WHERE id = ?",
      params: [row.id as SqlValue],
    })
  }

  await db.batch(statements)

  // One row saying the whole thing happened.
  //
  // The triggers have already written an entry per inserted row, but those say
  // "this arrived" a thousand times over and never say why. A restore is a
  // single act on the books and deserves a single line an auditor can find:
  // what was loaded, from a bundle taken when, by whom, on what date.
  await db.run(
    `INSERT INTO audit_log
       (assembly_id, entity, entity_id, action, before_json, after_json, actor, occurred_at)
     VALUES (?, 'restore', ?, 'insert', NULL, ?, ?, ?)`,
    [
      plan.assemblyId,
      plan.assemblyId,
      JSON.stringify({
        rows_written: rowsWritten,
        audit_rows_carried: tables.audit_log ?? 0,
        exported_at: plan.exportedAt,
        exported_by: plan.exportedBy,
        schema_version: plan.schemaVersion,
      }),
      actor,
      now,
    ],
  )

  return {
    assemblyId: plan.assemblyId,
    assemblyName: plan.assemblyName,
    rowsWritten,
    tables,
    auditRowsCarried: tables.audit_log ?? 0,
  }
}
