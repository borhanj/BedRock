/**
 * Importing a bank CSV.
 *
 * Two steps, always. `previewImport` reads the file and reports what it would
 * do; `commitImport` writes only what the treasurer accepted. Nothing is
 * written during a preview, so a wrong column mapping costs a click rather
 * than a corrupted ledger.
 */

import type { Cents } from '../../lib/money'
import type { SqlDatabase, SqlStatement } from '../db/adapter'
import { setAuditActor } from '../db/adapter'
import { readTable, type CsvTable } from '../import/csv'
import {
  applyMapping,
  guessMapping,
  type ColumnMapping,
  type DateDetection,
  type RowProblem,
} from '../import/mapping'
import { findNearMatches, hashRows, type NearMatch } from '../import/dedupe'
import { suggestForAll, learn, type Suggestion } from './rules'
import { openedOn } from './opening'

export type RowVerdict =
  /** Not seen before; will be imported. */
  | 'new'
  /** Exact match on an existing row; will be skipped. */
  | 'duplicate'
  /** Same amount and a similar description nearby. Needs a human. */
  | 'possible-duplicate'
  /**
   * Dated before the day these books open, so it is not part of them.
   *
   * Never imported, and the refusal matters more than it looks: the opening
   * balance already accounts for everything that happened before that date.
   * Importing a row from before it would count the same money twice — once
   * inside the opening figure and once as a transaction — and the books would
   * be out by exactly the amount of the history that was loaded.
   *
   * The fix is not to import it anyway. It is to move the opening date
   * backwards and restate what was held then, which is what
   * `restateOpening` is for.
   */
  | 'before-opening'

export interface PreviewRow {
  readonly line: number
  readonly occurredOn: string
  readonly description: string
  readonly memo: string | null
  readonly amountCents: Cents
  readonly dedupeHash: string
  readonly verdict: RowVerdict
  readonly nearMatch: NearMatch | null
  readonly suggestion: Suggestion | null
}

export interface ImportPreview {
  readonly header: readonly string[]
  readonly sample: readonly (readonly string[])[]
  readonly delimiter: string
  readonly skippedPreamble: number
  readonly mapping: ColumnMapping | null
  readonly dateDetection: DateDetection
  readonly rows: readonly PreviewRow[]
  readonly problems: readonly RowProblem[]
  readonly counts: {
    readonly total: number
    readonly fresh: number
    readonly duplicates: number
    readonly possible: number
    readonly unreadable: number
    readonly beforeOpening: number
  }
  /** The day the books open, so the screen can explain a refusal. */
  readonly openedOn: string | null
}

/** Header and a few rows, for the column-mapping screen. */
export function inspect(csvText: string): {
  table: CsvTable
  mapping: ColumnMapping | null
  dateDetection: DateDetection
} {
  const table = readTable(csvText)
  const { mapping, dateDetection } = guessMapping(table.header, table.rows.slice(0, 25))
  return { table, mapping, dateDetection }
}

export async function previewImport(
  db: SqlDatabase,
  assemblyId: string,
  accountId: string,
  csvText: string,
  override?: ColumnMapping,
): Promise<ImportPreview> {
  return buildPreview(db, assemblyId, accountId, csvText, override, true)
}

async function buildPreview(
  db: SqlDatabase,
  assemblyId: string,
  accountId: string,
  csvText: string,
  override: ColumnMapping | undefined,
  /**
   * False on the commit path, where the answer cannot change anything. A
   * near match only ever produces the `possible-duplicate` verdict, and commit
   * writes a possible duplicate the treasurer accepted exactly as it writes a
   * new row — it is the exact-hash `duplicate` verdict that stops a write.
   * Looking again would be a second pass over the statement to reach a
   * conclusion nothing reads.
   */
  withNearMatches: boolean,
): Promise<ImportPreview> {
  const { table, mapping: guessed, dateDetection } = inspect(csvText)
  const mapping = override ?? guessed

  if (!mapping) {
    return {
      header: table.header,
      sample: table.rows.slice(0, 8),
      delimiter: table.delimiter,
      skippedPreamble: table.skipped,
      mapping: null,
      dateDetection,
      rows: [],
      problems: [],
      counts: {
        total: table.rows.length,
        fresh: 0,
        duplicates: 0,
        possible: 0,
        unreadable: 0,
        beforeOpening: 0,
      },
      openedOn: await openedOn(db, assemblyId),
    }
  }

  const { rows: mapped, problems } = applyMapping(table.rows, mapping)
  const hashed = await hashRows(accountId, mapped)

  const wall = await openedOn(db, assemblyId)

  const existing = new Set(
    (
      await db.all<{ dedupe_hash: string }>(
        'SELECT dedupe_hash FROM transactions WHERE account_id = ? AND dedupe_hash IS NOT NULL',
        [accountId],
      )
    ).map((r) => r.dedupe_hash),
  )

  const suggestions = await suggestForAll(
    db,
    assemblyId,
    hashed.map((r) => r.description),
  )

  const outside = (row: { occurredOn: string }) => wall !== null && row.occurredOn < wall

  // Only rows that would otherwise be imported are worth comparing: one the
  // hash already recognises is settled, and one outside the books will not be
  // written whatever it resembles.
  const unseen = hashed.filter((row) => !existing.has(row.dedupeHash) && !outside(row))
  const nearMatches = withNearMatches
    ? await findNearMatches(db, accountId, unseen)
    : unseen.map(() => null)
  const nearByHash = new Map<string, NearMatch | null>(
    unseen.map((row, i) => [row.dedupeHash, nearMatches[i]]),
  )

  const rows: PreviewRow[] = hashed.map((row, i) => {
    const nearMatch = nearByHash.get(row.dedupeHash) ?? null
    // Checked first: a row dated before the books open is not part of them
    // whether or not it also looks like something already on file.
    const verdict: RowVerdict = outside(row)
      ? 'before-opening'
      : existing.has(row.dedupeHash)
        ? 'duplicate'
        : nearMatch
          ? 'possible-duplicate'
          : 'new'

    return {
      line: row.line,
      occurredOn: row.occurredOn,
      description: row.description,
      memo: row.memo,
      amountCents: row.amountCents,
      dedupeHash: row.dedupeHash,
      verdict,
      nearMatch,
      suggestion: suggestions[i],
    }
  })

  return {
    header: table.header,
    sample: table.rows.slice(0, 8),
    delimiter: table.delimiter,
    skippedPreamble: table.skipped,
    mapping,
    dateDetection,
    rows,
    problems,
    counts: {
      total: table.rows.length,
      fresh: rows.filter((r) => r.verdict === 'new').length,
      duplicates: rows.filter((r) => r.verdict === 'duplicate').length,
      possible: rows.filter((r) => r.verdict === 'possible-duplicate').length,
      unreadable: problems.length,
      beforeOpening: rows.filter((r) => r.verdict === 'before-opening').length,
    },
    openedOn: wall,
  }
}

export interface CommitRequest {
  readonly accountId: string
  readonly filename: string | null
  readonly mapping: ColumnMapping
  readonly csvText: string
  /**
   * Hashes the treasurer chose to import. Anything not listed is skipped,
   * which is how a flagged possible-duplicate gets excluded.
   */
  readonly accept: readonly string[]
  readonly actor: string
  readonly now: string
}

export interface CommitResult {
  readonly batchId: string
  readonly imported: number
  readonly skipped: number
}

export async function commitImport(
  db: SqlDatabase,
  assemblyId: string,
  request: CommitRequest,
): Promise<CommitResult> {
  await setAuditActor(db, request.actor)

  const preview = await buildPreview(
    db,
    assemblyId,
    request.accountId,
    request.csvText,
    request.mapping,
    false,
  )

  const accept = new Set(request.accept)
  // Unique per import rather than per timestamp: two files uploaded in the
  // same second are two batches, and a re-upload of the same file is its own
  // record of "everything in here was already on file".
  const batchId = `imp-${crypto.randomUUID()}`

  // Neither verdict is importable however the client asks. A duplicate would
  // be rejected by the unique index anyway, and failing the whole batch over
  // it helps nobody. A row from before the books open is refused for a reason
  // that no index enforces: the opening balance already contains it, so
  // writing it would count the same money twice.
  const importing = preview.rows.filter(
    (row) =>
      row.verdict !== 'duplicate' &&
      row.verdict !== 'before-opening' &&
      accept.has(row.dedupeHash),
  )

  // The batch row goes first: every transaction references it, and the foreign
  // key is checked at insert time. It can carry its final imported_count
  // straight away — what the treasurer accepted is known before anything is
  // written, so there is nothing to correct afterwards.
  const statements: SqlStatement[] = [
    {
      sql: `INSERT INTO import_batches
              (id, assembly_id, account_id, filename, r2_key, mapping_json,
               row_count, imported_count, duplicate_count, created_at)
            VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      params: [
        batchId,
        assemblyId,
        request.accountId,
        request.filename,
        JSON.stringify(request.mapping),
        preview.counts.total,
        importing.length,
        preview.counts.duplicates,
        request.now,
      ],
    },
  ]

  for (const row of importing) {
    // Money in is a contribution unless the treasurer says otherwise; money
    // out is an expense. Both are provisional and shown as uncategorised
    // until confirmed, which is what the dashboard's worklist counts.
    const kind = row.amountCents > 0 ? 'contribution' : 'expense'

    statements.push({
      sql: `INSERT INTO transactions
              (id, assembly_id, account_id, fund_id, category_id, occurred_on, amount_cents,
               payee, memo, method, source, kind, dedupe_hash, import_batch_id,
               is_locked, created_at, updated_at)
            VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, 'bank', 'import', ?, ?, ?, 0, ?, ?)`,
      params: [
        `txn-${row.dedupeHash.slice(0, 24)}`,
        assemblyId,
        request.accountId,
        row.occurredOn,
        row.amountCents,
        row.description || null,
        row.memo,
        kind,
        row.dedupeHash,
        batchId,
        request.now,
        request.now,
      ],
    })
  }

  // One call rather than a write per line. A statement with a thousand rows on
  // it is an ordinary thing for an Assembly to be handed, and a thousand
  // separate writes is what a Worker is not allowed to make.
  await db.batch(statements)

  return {
    batchId,
    imported: importing.length,
    skipped: preview.rows.length - importing.length,
  }
}

/**
 * Categorise a transaction, and learn from it.
 *
 * The learning is the whole point of doing this in one place: the treasurer
 * makes a decision once and the next statement carrying the same payee arrives
 * with that decision already suggested.
 */
export async function categorise(
  db: SqlDatabase,
  assemblyId: string,
  transactionId: string,
  target: { categoryId: string | null; fundId: string | null; txnKind: string | null },
  actor: string,
  now: string,
): Promise<boolean> {
  await setAuditActor(db, actor)

  const txn = await db.get<{ payee: string | null; is_locked: number }>(
    'SELECT payee, is_locked FROM transactions WHERE assembly_id = ? AND id = ?',
    [assemblyId, transactionId],
  )
  if (!txn) return false

  const result = await db.run(
    `UPDATE transactions
        SET category_id = ?, fund_id = COALESCE(?, fund_id),
            kind = COALESCE(?, kind), updated_at = ?
      WHERE assembly_id = ? AND id = ?`,
    [
      target.categoryId,
      target.fundId,
      target.txnKind,
      now,
      assemblyId,
      transactionId,
    ],
  )
  if (result.changes === 0) return false

  if (txn.payee) await learn(db, assemblyId, txn.payee, target, now)
  return true
}
