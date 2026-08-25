/**
 * The budget: what the Assembly planned, beside what happened.
 *
 * Two things shape this module.
 *
 * A budget belongs to the Assembly, not to the treasurer. It is drafted, then
 * approved, and after that changing a figure is a further decision rather than
 * an edit — enforced by triggers in 0005_budget.sql, so the rule holds for any
 * caller and not only the one that remembers it.
 *
 * And next year's draft is proposed from this year's actuals rather than typed
 * from nothing. A volunteer treasurer with one year's term should not have to
 * invent nineteen figures; they should have last year's, to argue with.
 */

import { monthsForYear, nawRuz, toDayIndex } from '../../calendar/badi'
import type { Cents } from '../../lib/money'
import { yearProgress } from '../../lib/year-progress'
import type { SqlDatabase, SqlStatement } from '../db/adapter'
import { setAuditActor } from '../db/adapter'

/** A budget change that cannot be made, with the reason a treasurer needs. */
export class BudgetError extends Error {}

export type BudgetStatus = 'none' | 'draft' | 'approved'

export interface BudgetLineView {
  readonly categoryId: string
  readonly label: string
  readonly kind: 'income' | 'expense'
  /**
   * Income destined for another institution's fund.
   *
   * The Assembly may well set a goal for it, but it is not money the Assembly
   * can spend, so it is kept out of the surplus rather than counted as though
   * it were.
   */
  readonly isPassthrough: boolean
  readonly budgetCents: Cents
  /** Positive magnitude, whichever direction the money went. */
  readonly actualCents: Cents
  /** Actual less budget. Positive is more than planned, either way. */
  readonly varianceCents: Cents
  /** Where an even pace through the year would have this line by today. */
  readonly pacedCents: Cents
}

/**
 * Money inside the year that no category claims yet.
 *
 * Shown as its own line rather than dropped or spread across the others. It
 * is the same backlog the dashboard's worklist counts, and a budget that
 * quietly omitted it would read as being further under than it is.
 */
export interface UncategorisedView {
  readonly incomeCents: Cents
  readonly expenseCents: Cents
}

export interface BudgetView {
  readonly bahaiYear: number
  readonly status: BudgetStatus
  readonly approvedOn: string | null
  readonly approvedBy: string | null
  readonly note: string | null
  readonly proposedFromYear: number | null
  readonly proposedFromMonths: number | null
  readonly nawRuz: string
  readonly yearEnd: string
  /** How much of the year has run: 0 before it starts, 1 once it is over. */
  readonly elapsed: number
  readonly monthsElapsed: number
  /** Income the Assembly keeps and may spend. */
  readonly income: readonly BudgetLineView[]
  /** Goals for other institutions' funds. Passes through; never spent here. */
  readonly passthrough: readonly BudgetLineView[]
  readonly expenses: readonly BudgetLineView[]
  readonly uncategorised: UncategorisedView
  readonly budgetedIncomeCents: Cents
  readonly actualIncomeCents: Cents
  readonly budgetedPassthroughCents: Cents
  readonly actualPassthroughCents: Cents
  readonly budgetedExpenseCents: Cents
  readonly actualExpenseCents: Cents
  /**
   * What the plan expects to be left over. Negative is a planned deficit.
   *
   * Pass-through income is excluded from both figures. Including it would
   * overstate the surplus by exactly what is owed upward — the Assembly would
   * read money it must forward as money it can spend.
   */
  readonly plannedSurplusCents: Cents
  readonly actualSurplusCents: Cents
}

interface CategoryRow {
  id: string
  label: string
  kind: 'income' | 'expense'
  sort_order: number
  is_passthrough: number
}

const SELECT_CATEGORIES = `
  SELECT c.id, c.label, c.kind, c.sort_order,
         COALESCE(f.is_passthrough, 0) AS is_passthrough
    FROM categories c
    LEFT JOIN funds f ON f.id = c.fund_id
   WHERE c.assembly_id = ? AND c.is_archived = 0
`

/**
 * Actual money in and out, by category, over a Bahá'í year.
 *
 * Positive magnitudes in both directions: a budget is read as "planned versus
 * spent", and signing the expenses negative here would make every variance
 * read backwards.
 *
 * The null key is money in the year that carries no category yet.
 */
async function actualsByCategory(
  db: SqlDatabase,
  assemblyId: string,
  bahaiYear: number,
): Promise<Map<string | null, { income: Cents; expense: Cents }>> {
  const periods = monthsForYear(bahaiYear)
  const rows = await db.all<{
    category_id: string | null
    income: number
    expense: number
  }>(
    `SELECT t.category_id,
            COALESCE(SUM(CASE WHEN t.kind = 'contribution' THEN t.amount_cents END), 0) AS income,
            COALESCE(SUM(CASE WHEN t.kind = 'expense' THEN -t.amount_cents END), 0) AS expense
       FROM transactions t
      WHERE t.assembly_id = ? AND t.kind IN ('contribution', 'expense')
        AND t.occurred_on BETWEEN ? AND ?
      GROUP BY t.category_id`,
    [assemblyId, nawRuz(bahaiYear), periods[periods.length - 1].endDate],
  )
  return new Map(rows.map((r) => [r.category_id, { income: r.income, expense: r.expense }]))
}

export async function loadBudget(
  db: SqlDatabase,
  assemblyId: string,
  bahaiYear: number,
  today: string,
): Promise<BudgetView> {
  const periods = monthsForYear(bahaiYear)
  const from = nawRuz(bahaiYear)
  const to = periods[periods.length - 1].endDate

  // How far through the year we are, by days. A budget line is paced against
  // the calendar, not against how many months happen to have Feast reports.
  const first = toDayIndex(from)
  const last = toDayIndex(to)
  const now = toDayIndex(today)
  const elapsed = Math.min(1, Math.max(0, (now - first + 1) / (last - first + 1)))
  const monthsElapsed = yearProgress(periods, today).monthsClosed

  const header = await db.get<{
    status: string
    approved_on: string | null
    approved_by: string | null
    note: string | null
    proposed_from_year: number | null
    proposed_from_months: number | null
  }>(
    `SELECT status, approved_on, approved_by, note, proposed_from_year, proposed_from_months
       FROM budget_years WHERE assembly_id = ? AND bahai_year = ?`,
    [assemblyId, bahaiYear],
  )

  const categories = await db.all<CategoryRow>(
    `${SELECT_CATEGORIES} ORDER BY c.kind, c.sort_order`,
    [assemblyId],
  )

  const budgeted = new Map(
    (
      await db.all<{ category_id: string; amount_cents: number }>(
        'SELECT category_id, amount_cents FROM budgets WHERE assembly_id = ? AND bahai_year = ?',
        [assemblyId, bahaiYear],
      )
    ).map((r) => [r.category_id, r.amount_cents]),
  )

  const actuals = await actualsByCategory(db, assemblyId, bahaiYear)

  const toLine = (c: CategoryRow): BudgetLineView => {
    const budgetCents = budgeted.get(c.id) ?? 0
    const actual = actuals.get(c.id)
    const actualCents = c.kind === 'income' ? (actual?.income ?? 0) : (actual?.expense ?? 0)
    return {
      categoryId: c.id,
      label: c.label,
      kind: c.kind,
      isPassthrough: c.is_passthrough === 1,
      budgetCents,
      actualCents,
      varianceCents: actualCents - budgetCents,
      pacedCents: Math.round(budgetCents * elapsed),
    }
  }

  const incomeLines = categories.filter((c) => c.kind === 'income').map(toLine)
  const income = incomeLines.filter((l) => !l.isPassthrough)
  const passthrough = incomeLines.filter((l) => l.isPassthrough)
  const expenses = categories.filter((c) => c.kind === 'expense').map(toLine)

  const unassigned = await uncategorisedActuals(db, assemblyId, bahaiYear)

  const total = (lines: readonly BudgetLineView[], pick: (l: BudgetLineView) => Cents) =>
    lines.reduce((sum, l) => sum + pick(l), 0)

  const budgetedIncomeCents = total(income, (l) => l.budgetCents)
  const budgetedPassthroughCents = total(passthrough, (l) => l.budgetCents)
  const budgetedExpenseCents = total(expenses, (l) => l.budgetCents)
  // Uncategorised money is real money. It counts toward the actual totals even
  // though no line claims it, or the surplus on this page would disagree with
  // the one on the year summary. Which fund a gift went to is known even when
  // its category is not, so it still lands on the right side of the split.
  const actualIncomeCents = total(income, (l) => l.actualCents) + unassigned.incomeOwn
  const actualPassthroughCents =
    total(passthrough, (l) => l.actualCents) + unassigned.incomePassthrough
  const actualExpenseCents = total(expenses, (l) => l.actualCents) + unassigned.expense

  return {
    bahaiYear,
    status: (header?.status as BudgetStatus) ?? 'none',
    approvedOn: header?.approved_on ?? null,
    approvedBy: header?.approved_by ?? null,
    note: header?.note ?? null,
    proposedFromYear: header?.proposed_from_year ?? null,
    proposedFromMonths: header?.proposed_from_months ?? null,
    nawRuz: from,
    yearEnd: to,
    elapsed,
    monthsElapsed,
    income,
    passthrough,
    expenses,
    uncategorised: {
      incomeCents: unassigned.incomeOwn + unassigned.incomePassthrough,
      expenseCents: unassigned.expense,
    },
    budgetedIncomeCents,
    actualIncomeCents,
    budgetedPassthroughCents,
    actualPassthroughCents,
    budgetedExpenseCents,
    actualExpenseCents,
    plannedSurplusCents: budgetedIncomeCents - budgetedExpenseCents,
    actualSurplusCents: actualIncomeCents - actualExpenseCents,
  }
}

/**
 * Money in the year that carries no category, split the way the totals need.
 *
 * A gift with no category still has a fund, so it can be told apart into the
 * Assembly's own income and money owed upward — which is the split the surplus
 * depends on. Expenses have no such second opinion, so they come straight from
 * the transaction rows.
 */
async function uncategorisedActuals(
  db: SqlDatabase,
  assemblyId: string,
  bahaiYear: number,
): Promise<{ incomeOwn: Cents; incomePassthrough: Cents; expense: Cents }> {
  const periods = monthsForYear(bahaiYear)
  const from = nawRuz(bahaiYear)
  const to = periods[periods.length - 1].endDate

  const gifts = await db.all<{ passthrough: number; cents: number }>(
    `SELECT COALESCE(f.is_passthrough, 0) AS passthrough, SUM(c.amount_cents) AS cents
       FROM contributions c
       JOIN transactions t ON t.id = c.transaction_id
       LEFT JOIN funds f ON f.id = c.fund_id
      WHERE c.assembly_id = ? AND t.category_id IS NULL
        AND t.occurred_on BETWEEN ? AND ?
      GROUP BY passthrough`,
    [assemblyId, from, to],
  )

  const spent = await db.get<{ cents: number }>(
    `SELECT COALESCE(SUM(-amount_cents), 0) AS cents
       FROM transactions
      WHERE assembly_id = ? AND kind = 'expense' AND category_id IS NULL
        AND occurred_on BETWEEN ? AND ?`,
    [assemblyId, from, to],
  )

  return {
    incomeOwn: gifts.find((g) => g.passthrough === 0)?.cents ?? 0,
    incomePassthrough: gifts.find((g) => g.passthrough === 1)?.cents ?? 0,
    expense: spent?.cents ?? 0,
  }
}

// ── setting the figures ──────────────────────────────────────────────────────

/** The year's header row, created on first use. Draft until approved. */
async function ensureBudgetYear(
  db: SqlDatabase,
  assemblyId: string,
  bahaiYear: number,
  now: string,
): Promise<string> {
  const existing = await db.get<{ status: string }>(
    'SELECT status FROM budget_years WHERE assembly_id = ? AND bahai_year = ?',
    [assemblyId, bahaiYear],
  )
  if (existing) return existing.status

  await db.run(
    `INSERT INTO budget_years
       (assembly_id, bahai_year, status, created_at, updated_at)
     VALUES (?, ?, 'draft', ?, ?)`,
    [assemblyId, bahaiYear, now, now],
  )
  return 'draft'
}

/**
 * Set, change or clear one category's figure for a year.
 *
 * A cleared line and a line set to zero are different statements: zero means
 * the Assembly decided to spend nothing here, and nothing means it has not
 * been considered. Passing null clears; passing 0 records the decision.
 */
export async function setBudgetLine(
  db: SqlDatabase,
  assemblyId: string,
  bahaiYear: number,
  categoryId: string,
  amountCents: Cents | null,
  note: string | null,
  actor: string,
  now: string,
): Promise<void> {
  await setAuditActor(db, actor)

  if (amountCents !== null) {
    if (!Number.isInteger(amountCents) || amountCents < 0) {
      throw new BudgetError('A budget figure must be a whole number of cents, and not negative.')
    }
  }

  const status = await ensureBudgetYear(db, assemblyId, bahaiYear, now)
  if (status === 'approved') {
    throw new BudgetError(
      `The ${bahaiYear} B.E. budget has been approved. Reopen the year before changing it.`,
    )
  }

  const category = await db.get<{ id: string }>(
    'SELECT id FROM categories WHERE assembly_id = ? AND id = ? AND is_archived = 0',
    [assemblyId, categoryId],
  )
  if (!category) throw new BudgetError('No such category.')

  if (amountCents === null) {
    await db.run(
      'DELETE FROM budgets WHERE assembly_id = ? AND bahai_year = ? AND category_id = ?',
      [assemblyId, bahaiYear, categoryId],
    )
    return
  }

  await db.run(
    `INSERT INTO budgets
       (id, assembly_id, bahai_year, category_id, amount_cents, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (assembly_id, bahai_year, category_id)
       DO UPDATE SET amount_cents = excluded.amount_cents,
                     note = excluded.note,
                     updated_at = excluded.updated_at`,
    [
      `bud-${bahaiYear}-${categoryId}`,
      assemblyId,
      bahaiYear,
      categoryId,
      amountCents,
      note,
      now,
      now,
    ],
  )
}

export interface ProposalResult {
  readonly bahaiYear: number
  readonly fromYear: number
  /** How many of the source year's nineteen months had ended. */
  readonly fromMonths: number
  readonly lines: number
  readonly totalCents: Cents
}

/**
 * Draft a year's budget from another year's actuals.
 *
 * The Assembly approves; this only puts something on the table. Every figure
 * is last year's actual, unrounded and unadjusted — a proposal that quietly
 * added ten percent would be the software making a decision that belongs to
 * nineteen people in a room.
 *
 * Refuses to touch a year that already has figures in it. Overwriting a
 * half-finished draft would discard deliberation that has already happened,
 * and there is no way for this function to know it has.
 *
 * The source year is usually still running when next year's budget is drafted,
 * which is normal and not an error — but how much of it had happened is
 * recorded, so a part-year basis stays visible after that year is complete.
 */
export async function proposeBudget(
  db: SqlDatabase,
  assemblyId: string,
  bahaiYear: number,
  fromYear: number,
  actor: string,
  now: string,
  today: string,
): Promise<ProposalResult> {
  await setAuditActor(db, actor)

  if (fromYear === bahaiYear) {
    throw new BudgetError('A budget cannot be proposed from its own year.')
  }

  const status = await ensureBudgetYear(db, assemblyId, bahaiYear, now)
  if (status === 'approved') {
    throw new BudgetError(
      `The ${bahaiYear} B.E. budget has been approved. Reopen the year before redrafting it.`,
    )
  }

  const existing = await db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM budgets WHERE assembly_id = ? AND bahai_year = ?',
    [assemblyId, bahaiYear],
  )
  if ((existing?.n ?? 0) > 0) {
    throw new BudgetError(
      `The ${bahaiYear} B.E. budget already has figures in it. Clear them before ` +
        'proposing a fresh draft, so nothing already decided is quietly overwritten.',
    )
  }

  const actuals = await actualsByCategory(db, assemblyId, fromYear)
  const categories = await db.all<CategoryRow>(SELECT_CATEGORIES, [assemblyId])

  const statements: SqlStatement[] = []
  let lines = 0
  let totalCents = 0
  for (const category of categories) {
    const actual = actuals.get(category.id)
    const amount = category.kind === 'income' ? (actual?.income ?? 0) : (actual?.expense ?? 0)
    // A category nothing went through last year gets no line at all, rather
    // than a zero. Zero is a decision; absence is an open question.
    if (amount <= 0) continue
    statements.push({
      sql: `INSERT INTO budgets
         (id, assembly_id, bahai_year, category_id, amount_cents, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        `bud-${bahaiYear}-${category.id}`,
        assemblyId,
        bahaiYear,
        category.id,
        amount,
        `From ${fromYear} B.E. actuals`,
        now,
        now,
      ],
    })
    lines += 1
    totalCents += amount
  }

  const fromMonths = yearProgress(monthsForYear(fromYear), today).monthsClosed

  // The lines and the note saying where they came from go in together. A
  // draft that existed without its provenance, even briefly, would be a
  // proposal with no answer to "from what?".
  statements.push({
    sql: `UPDATE budget_years
        SET proposed_from_year = ?, proposed_from_months = ?, updated_at = ?
      WHERE assembly_id = ? AND bahai_year = ?`,
    params: [fromYear, fromMonths, now, assemblyId, bahaiYear],
  })
  await db.batch(statements)

  return { bahaiYear, fromYear, fromMonths, lines, totalCents }
}

/**
 * The Assembly has adopted the budget.
 *
 * From here the figures are frozen. A change is a further decision, taken by
 * reopening the year, and both acts are in the audit trail.
 */
export async function approveBudget(
  db: SqlDatabase,
  assemblyId: string,
  bahaiYear: number,
  note: string | null,
  actor: string,
  now: string,
  today: string,
): Promise<void> {
  await setAuditActor(db, actor)

  const status = await ensureBudgetYear(db, assemblyId, bahaiYear, now)
  if (status === 'approved') {
    throw new BudgetError(`The ${bahaiYear} B.E. budget is already approved.`)
  }

  const lines = await db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM budgets WHERE assembly_id = ? AND bahai_year = ?',
    [assemblyId, bahaiYear],
  )
  if ((lines?.n ?? 0) === 0) {
    throw new BudgetError('There is nothing to approve: the budget has no figures in it.')
  }

  await db.run(
    `UPDATE budget_years
        SET status = 'approved', approved_on = ?, approved_by = ?, note = ?, updated_at = ?
      WHERE assembly_id = ? AND bahai_year = ?`,
    [today, actor, note, now, assemblyId, bahaiYear],
  )
}

/** Reopen an approved budget for revision. Deliberate, and audited. */
export async function reopenBudget(
  db: SqlDatabase,
  assemblyId: string,
  bahaiYear: number,
  actor: string,
  now: string,
): Promise<void> {
  await setAuditActor(db, actor)

  const header = await db.get<{ status: string }>(
    'SELECT status FROM budget_years WHERE assembly_id = ? AND bahai_year = ?',
    [assemblyId, bahaiYear],
  )
  if (!header) throw new BudgetError(`There is no ${bahaiYear} B.E. budget.`)
  if (header.status !== 'approved') {
    throw new BudgetError(`The ${bahaiYear} B.E. budget is already open for revision.`)
  }

  await db.run(
    `UPDATE budget_years
        SET status = 'draft', approved_on = NULL, approved_by = NULL, updated_at = ?
      WHERE assembly_id = ? AND bahai_year = ?`,
    [now, assemblyId, bahaiYear],
  )
}
