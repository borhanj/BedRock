/**
 * The treasurer handoff.
 *
 * A Local Spiritual Assembly elects its officers annually, so the ordinary
 * case is that whoever is holding these books will not be holding them next
 * year. Two things have to survive that: the data, and the handful of facts
 * that are not in the data.
 *
 * The export below is the first — every table, complete, in one file, with a
 * schema version so a later Bedrock knows what it is reading. Lossless on
 * purpose: an export that dropped the audit trail or the receipt voids would
 * hand a successor books that could not be defended.
 *
 * The checklist is the second, and it is the part that actually gets lost. A
 * database is easy to copy. The donor PIN lives in one person's memory, and if
 * that person leaves without passing it on, the names are gone — not
 * recoverable by the Assembly, not recoverable by this software, not
 * recoverable at all. That is a property of the encryption working correctly,
 * and it is worth one plain sentence on the way out rather than a discovery
 * next Naw-Rúz.
 */

import { monthsForYear, nawRuz } from '../../calendar/badi'
import type { SqlDatabase, SqlValue } from '../db/adapter'

/** Bumped when the shape of an export changes in a way an importer must know. */
export const HANDOFF_SCHEMA_VERSION = 1

/** Something that has to pass between two people, not between two databases. */
export interface HandoffStep {
  readonly key: string
  readonly title: string
  readonly detail: string
  /**
   * True when the step is not merely unfinished but unrecoverable if skipped.
   * Reserved for the ones where there is no second chance.
   */
  readonly irreversible: boolean
  /** What the database can already tell us about this step, if anything. */
  readonly status: string | null
}

export interface HandoffView {
  readonly assemblyName: string
  readonly bahaiYear: number
  readonly today: string
  readonly preparedBy: string
  readonly schemaVersion: number
  /** Row counts, so the successor can check the file arrived whole. */
  readonly counts: Readonly<Record<string, number>>
  readonly steps: readonly HandoffStep[]
}

/**
 * Every table, in the order a restore must replay them.
 *
 * Parents before children, and two orderings that are the database's rules
 * rather than anyone's preference:
 *
 *   - `budgets` before `budget_years`, because an approved year refuses new
 *     lines. The year row goes in last and closes the door behind it.
 *   - `reconciliations` before `reconciliation_items`, with the statement
 *     restored open and balanced afterwards, because a balanced reconciliation
 *     refuses changes to what has cleared.
 *
 * The export writes its tables in this order too, so the file itself documents
 * how to replay it and a reader working straight down the keys cannot trip
 * over a trigger. This list is the single copy of that knowledge —
 * `scripts/seed-sql.ts` and `repo/restore.ts` both read it rather than keeping
 * their own, because two copies of an ordering constraint stay right until the
 * day one of them does not.
 *
 * `audit_actor` is deliberately absent: it holds who is writing right now,
 * which is a property of a live connection and means nothing in a file.
 */
export const RESTORE_ORDER = [
  'assemblies',
  'accounts',
  'funds',
  'categories',
  'donors',
  'import_batches',
  'transactions',
  'contributions',
  'receipts',
  'remittances',
  'reports',
  'attachments',
  'rules',
  'vault',
  'donor_access_log',
  'budgets',
  'budget_years',
  'reconciliations',
  'reconciliation_items',
  'audit_log',
] as const

/**
 * Tables whose `id` is AUTOINCREMENT and must not be carried across.
 *
 * Restoring these rows with their original ids would collide with the entries
 * the triggers write as the restore itself proceeds. The rows go in with every
 * other column intact — original actor, original timestamp — and take new ids.
 */
export const RENUMBERED_ON_RESTORE = new Set(['audit_log', 'donor_access_log'])

const TABLES = RESTORE_ORDER

export interface HandoffBundle {
  readonly schemaVersion: number
  readonly exportedAt: string
  readonly exportedBy: string
  readonly assemblyId: string
  readonly tables: Readonly<Record<string, readonly Record<string, SqlValue>[]>>
}

/**
 * The whole book, as data.
 *
 * Includes the donor ciphertext. Leaving it out would make the file safe to
 * lose and useless to keep — the names would be unrecoverable even by someone
 * holding the right PIN. It stays encrypted in the file exactly as it is in
 * the database, so the export is no more readable than the database was.
 */
export async function exportEverything(
  db: SqlDatabase,
  assemblyId: string,
  exportedAt: string,
  exportedBy: string,
): Promise<HandoffBundle> {
  const tables: Record<string, Record<string, SqlValue>[]> = {}

  for (const table of TABLES) {
    // Not every table carries assembly_id — reconciliation_items hangs off a
    // reconciliation, and audit_actor is excluded above. Scope where we can
    // and take the lot where we cannot, rather than silently exporting
    // nothing for a table whose column name was guessed wrong.
    const scoped = await hasColumn(db, table, 'assembly_id')
    tables[table] = scoped
      ? await db.all(`SELECT * FROM ${table} WHERE assembly_id = ?`, [assemblyId])
      : await db.all(`SELECT * FROM ${table}`)
  }

  return {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    exportedAt,
    exportedBy,
    assemblyId,
    tables,
  }
}

async function hasColumn(
  db: SqlDatabase,
  table: string,
  column: string,
): Promise<boolean> {
  const row = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM pragma_table_info(?) WHERE name = ?`,
    [table, column],
  )
  return (row?.n ?? 0) > 0
}

export async function loadHandoff(
  db: SqlDatabase,
  assemblyId: string,
  bahaiYear: number,
  today: string,
  preparedBy: string,
): Promise<HandoffView | null> {
  const assembly = await db.get<{ name: string }>(
    'SELECT name FROM assemblies WHERE id = ?',
    [assemblyId],
  )
  if (!assembly) return null

  const counts: Record<string, number> = {}
  for (const table of TABLES) {
    const scoped = await hasColumn(db, table, 'assembly_id')
    const row = scoped
      ? await db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM ${table} WHERE assembly_id = ?`,
          [assemblyId],
        )
      : await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)
    counts[table] = row?.n ?? 0
  }

  return {
    assemblyName: assembly.name,
    bahaiYear,
    today,
    preparedBy,
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    counts,
    steps: await buildSteps(db, assemblyId, bahaiYear, today),
  }
}

async function buildSteps(
  db: SqlDatabase,
  assemblyId: string,
  bahaiYear: number,
  today: string,
): Promise<HandoffStep[]> {
  const periods = monthsForYear(bahaiYear)
  const from = nawRuz(bahaiYear)
  const to = periods[periods.length - 1].endDate

  const vault = await db.get<{ updated_at: string }>(
    'SELECT updated_at FROM vault WHERE assembly_id = ?',
    [assemblyId],
  )
  const namedDonors = await db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM donors WHERE assembly_id = ? AND name_encrypted IS NOT NULL',
    [assemblyId],
  )
  // Months that have ENDED without their report being presented — the work the
  // outgoing treasurer still owes. Counting every month without a presented
  // report would fold in the ones still to come, which belong to the successor
  // and are not a handover failing. Month boundaries come from the calendar,
  // never from SQL.
  const presented = new Set(
    (
      await db.all<{ month_number: number }>(
        `SELECT month_number FROM reports
          WHERE assembly_id = ? AND bahai_year = ? AND status = 'presented'`,
        [assemblyId, bahaiYear],
      )
    ).map((r) => r.month_number),
  )
  const owed = periods.filter(
    (p) => p.kind === 'month' && p.endDate < today && !presented.has(p.monthNumber!),
  ).length
  const lastStatement = await db.get<{ ended: string }>(
    `SELECT MAX(statement_ended_on) AS ended FROM reconciliations
      WHERE assembly_id = ? AND status = 'balanced'`,
    [assemblyId],
  )
  const uncategorised = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM transactions
      WHERE assembly_id = ? AND category_id IS NULL
        AND kind IN ('contribution', 'expense') AND occurred_on BETWEEN ? AND ?`,
    [assemblyId, from, to],
  )
  const awaiting = await db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM contributions WHERE assembly_id = ? AND receipt_id IS NULL',
    [assemblyId],
  )

  const named = namedDonors?.n ?? 0

  return [
    {
      key: 'pin',
      title: 'Hand over the donor PIN, in person, before you go',
      detail:
        'Donor names are encrypted with a key derived from the PIN, and the PIN is ' +
        'held in browser memory only — it is not in the database, not in this export, ' +
        'and not recoverable from either. If it leaves with you, the names are gone ' +
        'for good: not by the Assembly, not by this software, not at all. The safest ' +
        'handover is to sit down together and use Change PIN, so your successor sets ' +
        'one only they know and every record is re-encrypted to it.',
      irreversible: true,
      status:
        vault === undefined || vault === null
          ? 'No vault has been set up, so there is no PIN to pass on and no name at risk.'
          : named === 0
            ? 'A vault exists but no donor name has been stored in it yet.'
            : `${named} donor name${named === 1 ? '' : 's'} would become unreadable. ` +
              `The PIN was last changed ${vault.updated_at.slice(0, 10)}.`,
    },
    {
      key: 'export',
      title: 'Give your successor the export file, and keep a copy',
      detail:
        'The file below is every row: ledger, contributions, receipts and voids, ' +
        'funds, budget, reconciliations and the full audit trail. It is lossless, so ' +
        'the books can be defended from it alone. It is also not encrypted beyond ' +
        'what already was — treat it as you would the account statements.',
      irreversible: false,
      status: null,
    },
    {
      key: 'bank',
      title: 'Change the bank signatories',
      detail:
        'Nothing in this software can do it and nothing here will know whether it ' +
        'was done. It is on this list because it is the step most often left until ' +
        'someone needs to sign a cheque.',
      irreversible: false,
      status: null,
    },
    {
      key: 'reports',
      title: 'Present the reports still outstanding',
      detail:
        'A month left unpresented is a month the community has not heard, and your ' +
        'successor cannot present it for you — they were not there.',
      irreversible: false,
      status:
        owed === 0
          ? 'Every month that has ended has had its report presented.'
          : owed === 1
            ? 'One month has ended without its report being presented.'
            : `${owed} months have ended without their reports being presented.`,
    },
    {
      key: 'reconcile',
      title: 'Reconcile to the last statement you received',
      detail:
        'Handing over books that are proved against the bank to a known date makes ' +
        'the boundary between your term and theirs unambiguous.',
      irreversible: false,
      status: lastStatement?.ended
        ? `Reconciled to ${lastStatement.ended}.`
        : 'No statement has ever been reconciled.',
    },
    {
      key: 'tidy',
      title: 'Categorise what is left, and issue the receipts owed',
      detail:
        'Only you know what the uncategorised rows were for. A successor can guess ' +
        'from a payee, and a guess in the books is worse than a blank.',
      irreversible: false,
      status:
        `${uncategorised?.n ?? 0} transaction${(uncategorised?.n ?? 0) === 1 ? '' : 's'} ` +
        `uncategorised, ${awaiting?.n ?? 0} contribution${(awaiting?.n ?? 0) === 1 ? '' : 's'} ` +
        'still awaiting a receipt.',
    },
    {
      key: 'audit',
      title: 'Draw the audit package for the year and file it',
      detail:
        'Dated, complete, and stating what it could not vouch for. It is the ' +
        'document that says what the books looked like the day they changed hands.',
      irreversible: false,
      status: `Available for ${bahaiYear} B.E. as at ${today}.`,
    },
  ]
}
