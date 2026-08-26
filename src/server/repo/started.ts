/**
 * Getting started: what a new treasurer still has to do.
 *
 * Setup answers where the books begin. It does not tell anybody what the job
 * actually is — a treasurer who has just opened their books lands on a
 * dashboard of zeroes with six nav items and no idea which one comes first.
 *
 * Every step here is **detected, never remembered**. There is no "dismissed"
 * column and nothing is ticked because a screen was visited: a step is done
 * when the database shows it done, which means the list cannot drift from the
 * books, cannot be wrong after a restore, and cannot congratulate anybody for
 * work they have not finished. It also means a step can go back to undone —
 * un-approving a budget really does leave it undone — which is correct, and a
 * stored flag would have hidden it.
 *
 * The order is the order the work actually happens in, and each step says what
 * it is for rather than only what to click. A treasurer who reads only this
 * list should still end up with defensible books.
 */

import type { SqlDatabase } from '../db/adapter'

export interface StartStep {
  readonly key: string
  readonly title: string
  /** Why it matters, in a sentence a volunteer would use. */
  readonly detail: string
  readonly href: string
  readonly done: boolean
  /**
   * True when nothing is stopping this step and everything before it is done.
   * Exactly one step is ever `next`, so the card can point at one thing.
   */
  readonly next: boolean
  /** What the database can already say about it, if anything. */
  readonly status: string | null
}

export interface GettingStarted {
  readonly steps: readonly StartStep[]
  readonly doneCount: number
  /** True once every step is done and the card has nothing left to say. */
  readonly complete: boolean
}

export async function loadGettingStarted(
  db: SqlDatabase,
  assemblyId: string,
): Promise<GettingStarted> {
  const counts = await db.get<{
    imported: number
    manual: number
    uncategorised: number
    vault: number
    receipts: number
    awaiting: number
    balanced: number
    budget: number
    presented: number
  }>(
    `SELECT
       (SELECT COUNT(*) FROM transactions
         WHERE assembly_id = ? AND source = 'import')                       AS imported,
       (SELECT COUNT(*) FROM transactions
         WHERE assembly_id = ? AND source <> 'import')                      AS manual,
       (SELECT COUNT(*) FROM transactions
         WHERE assembly_id = ? AND category_id IS NULL
           AND kind IN ('contribution', 'expense'))                         AS uncategorised,
       (SELECT COUNT(*) FROM vault WHERE assembly_id = ?)                   AS vault,
       (SELECT COUNT(*) FROM receipts WHERE assembly_id = ?)                AS receipts,
       (SELECT COUNT(*) FROM contributions
         WHERE assembly_id = ? AND receipt_id IS NULL)                      AS awaiting,
       (SELECT COUNT(*) FROM reconciliations
         WHERE assembly_id = ? AND status = 'balanced')                     AS balanced,
       (SELECT COUNT(*) FROM budget_years WHERE assembly_id = ?)            AS budget,
       (SELECT COUNT(*) FROM reports
         WHERE assembly_id = ? AND status = 'presented')                    AS presented`,
    Array.from({ length: 9 }, () => assemblyId),
  )

  const c = counts ?? {
    imported: 0, manual: 0, uncategorised: 0, vault: 0,
    receipts: 0, awaiting: 0, balanced: 0, budget: 0, presented: 0,
  }
  const anyTransactions = c.imported + c.manual > 0

  const steps: Array<Omit<StartStep, 'next'>> = [
    {
      key: 'import',
      title: 'Bring in your bank transactions',
      detail:
        'Download a CSV from your bank and import it. Bedrock reads the columns, works ' +
        'out the date order, and refuses to add a row twice — so re-importing an ' +
        'overlapping statement next month is safe.',
      href: '/ledger/import',
      done: anyTransactions,
      status: anyTransactions
        ? `${c.imported + c.manual} transactions on file`
        : 'nothing has been imported yet',
    },
    {
      key: 'categorise',
      title: 'Say what each row was for',
      detail:
        'Every contribution needs its fund and every payment its category, or the Feast ' +
        'report has nothing to group. Categorising one row teaches Bedrock that payee, ' +
        'and the next statement arrives with the answer already suggested.',
      href: '/ledger?uncategorised=1',
      done: anyTransactions && c.uncategorised === 0,
      status: !anyTransactions
        ? null
        : c.uncategorised === 0
          ? 'everything is categorised'
          : `${c.uncategorised} still uncategorised`,
    },
    {
      key: 'vault',
      title: 'Set a PIN for donor names',
      detail:
        'Contribution amounts stay readable; who gave them does not. Names are encrypted ' +
        'behind a PIN only you know, so reports work without ever decrypting anything, ' +
        'and every look at a name is logged.',
      href: '/receipts',
      done: c.vault > 0,
      status: c.vault > 0 ? 'the vault is set up' : 'donor names are not protected yet',
    },
    {
      key: 'receipts',
      title: 'Issue a receipt',
      detail:
        'Numbered without gaps, voided rather than deleted, and printed on your ' +
        'letterhead. A contributor who asks for one next year should be able to be given it.',
      href: '/receipts',
      done: c.receipts > 0,
      status:
        c.receipts > 0
          ? `${c.receipts} issued`
          : c.awaiting > 0
            ? `${c.awaiting} gift${c.awaiting === 1 ? ' is' : 's are'} waiting for one`
            : null,
    },
    {
      key: 'reconcile',
      title: 'Prove the books against a statement',
      detail:
        'Tick off what the bank has actually processed until the difference is zero. ' +
        'Until this has been done once, the dashboard will not claim there is nothing ' +
        'unmatched — it says it does not know, which is a different thing.',
      href: '/ledger/reconcile',
      done: c.balanced > 0,
      status:
        c.balanced > 0
          ? `${c.balanced} statement${c.balanced === 1 ? '' : 's'} balanced`
          : 'never reconciled',
    },
    {
      key: 'budget',
      title: 'Record the budget the Assembly adopted',
      detail:
        'Drafted by you, approved by the Assembly, and frozen once it is. The Feast ' +
        'report then shows spending against what was actually agreed rather than against ' +
        'last year.',
      href: '/budget',
      done: c.budget > 0,
      status: c.budget > 0 ? 'a budget year exists' : 'no budget yet',
    },
    {
      key: 'report',
      title: 'Present a report at Feast',
      detail:
        'Build the month, close the books on it, and present it. A presented report keeps ' +
        'saying what it said, so if a later correction moves the figures the report shows ' +
        'both — what the community heard, and what changed since.',
      href: '/',
      done: c.presented > 0,
      status: c.presented > 0 ? `${c.presented} presented` : 'none presented yet',
    },
  ]

  // Exactly one step is `next`: the first undone one. A card that pointed at
  // five things at once would be a list of chores rather than an answer to
  // "what do I do now?".
  const firstUndone = steps.findIndex((s) => !s.done)

  return {
    steps: steps.map((s, i) => ({ ...s, next: i === firstUndone })),
    doneCount: steps.filter((s) => s.done).length,
    complete: firstUndone === -1,
  }
}
