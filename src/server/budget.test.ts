import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from './db/migrate'
import { openNodeDatabase, type NodeSqlDatabase } from './db/node-sqlite'
import {
  approveBudget,
  BudgetError,
  loadBudget,
  proposeBudget,
  reopenBudget,
  setBudgetLine,
} from './repo/budget'
import { loadYearSummary } from './repo/report'
import { handleApi } from './api'
import { ASSEMBLY_ID, SEED_TODAY, SEED_YEAR, seed } from './seed'

const ACTOR = 'treasurer@riverbend'
const NOW = '2026-08-28T12:00:00Z'
const NEXT = SEED_YEAR + 1

async function freshDatabase(): Promise<NodeSqlDatabase> {
  const db = openNodeDatabase(':memory:')
  await migrate(db)
  await seed(db)
  return db
}

describe('budget against actual', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await freshDatabase()
  })

  it('reads the year the Assembly approved', async () => {
    const budget = await loadBudget(db, ASSEMBLY_ID, SEED_YEAR, SEED_TODAY)
    expect(budget.status).toBe('approved')
    expect(budget.approvedOn).toBe('2026-03-08')
    expect(budget.budgetedIncomeCents).toBe(1_700_000)
    expect(budget.budgetedExpenseCents).toBe(1_381_000)
    expect(budget.plannedSurplusCents).toBe(319_000)
  })

  it('keeps money owed upward out of the surplus', async () => {
    // The National and Continental goals are income to the account and none of
    // it is the Assembly's. Counted in the surplus they would overstate what
    // there is to spend by exactly the amount that has to be forwarded.
    const budget = await loadBudget(db, ASSEMBLY_ID, SEED_YEAR, SEED_TODAY)
    expect(budget.budgetedPassthroughCents).toBe(350_000)
    expect(budget.passthrough.map((l) => l.label)).toEqual([
      'National Fund contributions',
      'Continental Fund contributions',
    ])
    expect(budget.income.every((l) => !l.isPassthrough)).toBe(true)
    expect(budget.plannedSurplusCents).toBe(
      budget.budgetedIncomeCents - budget.budgetedExpenseCents,
    )
  })

  it('agrees with the year summary on what actually happened', async () => {
    const budget = await loadBudget(db, ASSEMBLY_ID, SEED_YEAR, SEED_TODAY)
    const summary = (await loadYearSummary(db, ASSEMBLY_ID, SEED_YEAR))!
    const contributions = summary.incomeByFund.reduce((s, l) => s + l.amountCents, 0)
    const expenses = summary.expensesByCategory.reduce((s, l) => s + l.amountCents, 0)

    // The budget splits income two ways that the summary does not, so the test
    // is that the two halves add back to the same total.
    expect(budget.actualIncomeCents + budget.actualPassthroughCents).toBe(contributions)
    expect(budget.actualExpenseCents).toBe(expenses)
  })

  it('counts uncategorised money in the totals and says so', async () => {
    const budget = await loadBudget(db, ASSEMBLY_ID, SEED_YEAR, SEED_TODAY)
    // Asmáʼ has arrived from the bank uncategorised, and the Feast cash tin
    // was never given a category either.
    expect(budget.uncategorised.expenseCents).toBe(30_040)
    expect(budget.uncategorised.incomeCents).toBe(21_450)

    const claimed = budget.expenses.reduce((s, l) => s + l.actualCents, 0)
    expect(budget.actualExpenseCents).toBe(claimed + 30_040)
  })

  it('knows a cash gift’s fund even when its category is missing', async () => {
    // The tin gifts are Local Fund money with no category. They belong in the
    // Assembly's own income, not in what is owed upward.
    const budget = await loadBudget(db, ASSEMBLY_ID, SEED_YEAR, SEED_TODAY)
    const claimed = budget.income.reduce((s, l) => s + l.actualCents, 0)
    expect(budget.actualIncomeCents).toBe(claimed + 21_450)
  })

  it('paces each line against how much of the year has run', async () => {
    const budget = await loadBudget(db, ASSEMBLY_ID, SEED_YEAR, SEED_TODAY)
    // 161 days of 365, from Naw-Rúz to 28 August.
    expect(budget.elapsed).toBeCloseTo(161 / 365, 5)
    expect(budget.monthsElapsed).toBe(8)

    const rent = budget.expenses.find((l) => l.label.startsWith('Rent'))!
    expect(rent.pacedCents).toBe(Math.round(665_000 * budget.elapsed))
    // Every paced figure is a whole number of cents, like every other figure.
    for (const line of budget.expenses) expect(Number.isInteger(line.pacedCents)).toBe(true)
  })

  it('flags the line that is already over for the whole year', async () => {
    const budget = await loadBudget(db, ASSEMBLY_ID, SEED_YEAR, SEED_TODAY)
    const deepening = budget.expenses.find((l) => l.label === 'Deepening materials')!
    expect(deepening.budgetCents).toBe(15_000)
    expect(deepening.actualCents).toBe(17_865)
    expect(deepening.varianceCents).toBe(2_865)
  })

  it('reports nothing for a year with no budget', async () => {
    const budget = await loadBudget(db, ASSEMBLY_ID, NEXT, SEED_TODAY)
    expect(budget.status).toBe('none')
    expect(budget.budgetedExpenseCents).toBe(0)
    // The year has not started, so nothing is paced into it.
    expect(budget.elapsed).toBe(0)
    expect(budget.expenses.every((l) => l.pacedCents === 0)).toBe(true)
  })
})

describe('setting a figure', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await freshDatabase()
  })

  it('records a line, and changes it', async () => {
    await setBudgetLine(db, ASSEMBLY_ID, NEXT, 'cat-rent', 700_000, null, ACTOR, NOW)
    let budget = await loadBudget(db, ASSEMBLY_ID, NEXT, SEED_TODAY)
    expect(budget.status).toBe('draft')
    expect(budget.expenses.find((l) => l.categoryId === 'cat-rent')!.budgetCents).toBe(700_000)

    await setBudgetLine(db, ASSEMBLY_ID, NEXT, 'cat-rent', 720_000, null, ACTOR, NOW)
    budget = await loadBudget(db, ASSEMBLY_ID, NEXT, SEED_TODAY)
    expect(budget.budgetedExpenseCents).toBe(720_000)
  })

  it('tells a decided zero from an unasked question', async () => {
    await setBudgetLine(db, ASSEMBLY_ID, NEXT, 'cat-travel', 0, null, ACTOR, NOW)
    const decided = await db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM budgets WHERE bahai_year = ? AND category_id = ?',
      [NEXT, 'cat-travel'],
    )
    expect(decided!.n).toBe(1)

    await setBudgetLine(db, ASSEMBLY_ID, NEXT, 'cat-travel', null, null, ACTOR, NOW)
    const cleared = await db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM budgets WHERE bahai_year = ? AND category_id = ?',
      [NEXT, 'cat-travel'],
    )
    expect(cleared!.n).toBe(0)
  })

  it('refuses a negative figure and a fraction of a cent', async () => {
    for (const amount of [-100, 12.5]) {
      await expect(
        setBudgetLine(db, ASSEMBLY_ID, NEXT, 'cat-rent', amount, null, ACTOR, NOW),
      ).rejects.toThrow(BudgetError)
    }
  })

  it('refuses a category that does not exist', async () => {
    await expect(
      setBudgetLine(db, ASSEMBLY_ID, NEXT, 'cat-yacht', 100, null, ACTOR, NOW),
    ).rejects.toThrow(/No such category/)
  })

  it('records who set it', async () => {
    await setBudgetLine(db, ASSEMBLY_ID, NEXT, 'cat-rent', 700_000, null, ACTOR, NOW)
    const logged = await db.get<{ actor: string }>(
      "SELECT actor FROM audit_log WHERE entity = 'budgets' ORDER BY id DESC LIMIT 1",
    )
    expect(logged!.actor).toBe(ACTOR)
  })
})

describe('approving, and reopening', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await freshDatabase()
  })

  it('refuses to change an approved figure', async () => {
    await expect(
      setBudgetLine(db, ASSEMBLY_ID, SEED_YEAR, 'cat-rent', 1, null, ACTOR, NOW),
    ).rejects.toThrow(/Reopen the year/)
  })

  it('refuses a raw SQL write to an approved budget too', async () => {
    // The rule is a trigger, not a convention, so it holds for a caller that
    // never went near setBudgetLine.
    await expect(
      db.run('UPDATE budgets SET amount_cents = 1 WHERE bahai_year = ? AND category_id = ?', [
        SEED_YEAR,
        'cat-rent',
      ]),
    ).rejects.toThrow(/approved/)
    await expect(
      db.run('DELETE FROM budgets WHERE bahai_year = ? AND category_id = ?', [
        SEED_YEAR,
        'cat-rent',
      ]),
    ).rejects.toThrow(/approved/)
  })

  it('lets a reopened year be changed, then approved again', async () => {
    await reopenBudget(db, ASSEMBLY_ID, SEED_YEAR, ACTOR, NOW)
    expect((await loadBudget(db, ASSEMBLY_ID, SEED_YEAR, SEED_TODAY)).status).toBe('draft')

    await setBudgetLine(db, ASSEMBLY_ID, SEED_YEAR, 'cat-deepening', 25_000, null, ACTOR, NOW)
    await approveBudget(db, ASSEMBLY_ID, SEED_YEAR, 'Revised at Feast.', ACTOR, NOW, SEED_TODAY)

    const budget = await loadBudget(db, ASSEMBLY_ID, SEED_YEAR, SEED_TODAY)
    expect(budget.status).toBe('approved')
    expect(budget.note).toBe('Revised at Feast.')
    expect(budget.expenses.find((l) => l.categoryId === 'cat-deepening')!.budgetCents).toBe(25_000)
  })

  it('refuses to reopen a budget that is not approved', async () => {
    await expect(reopenBudget(db, ASSEMBLY_ID, NEXT, ACTOR, NOW)).rejects.toThrow(
      /no 184 B.E. budget/,
    )
  })

  it('refuses to approve nothing', async () => {
    await expect(
      approveBudget(db, ASSEMBLY_ID, NEXT, null, ACTOR, NOW, SEED_TODAY),
    ).rejects.toThrow(/no figures/)
  })

  it('refuses to approve twice', async () => {
    await expect(
      approveBudget(db, ASSEMBLY_ID, SEED_YEAR, null, ACTOR, NOW, SEED_TODAY),
    ).rejects.toThrow(/already approved/)
  })
})

describe('proposing next year from this year', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await freshDatabase()
  })

  it('carries each category’s actual across unrounded', async () => {
    const result = await proposeBudget(
      db, ASSEMBLY_ID, NEXT, SEED_YEAR, ACTOR, NOW, SEED_TODAY,
    )
    expect(result.fromYear).toBe(SEED_YEAR)
    expect(result.lines).toBeGreaterThan(0)

    const proposed = await loadBudget(db, ASSEMBLY_ID, NEXT, SEED_TODAY)
    const thisYear = await loadBudget(db, ASSEMBLY_ID, SEED_YEAR, SEED_TODAY)

    for (const line of proposed.expenses) {
      if (line.budgetCents === 0) continue
      const actual = thisYear.expenses.find((l) => l.categoryId === line.categoryId)!
      // Unrounded and unadjusted: the software proposes, the Assembly decides.
      expect(line.budgetCents).toBe(actual.actualCents)
    }
  })

  it('records the part-year basis it was drafted from', async () => {
    await proposeBudget(db, ASSEMBLY_ID, NEXT, SEED_YEAR, ACTOR, NOW, SEED_TODAY)
    const proposed = await loadBudget(db, ASSEMBLY_ID, NEXT, SEED_TODAY)
    expect(proposed.proposedFromYear).toBe(SEED_YEAR)
    // Pinned now, because in a year's time 183 B.E. will look complete.
    expect(proposed.proposedFromMonths).toBe(8)
  })

  it('leaves a category nothing went through without a line', async () => {
    await proposeBudget(db, ASSEMBLY_ID, NEXT, SEED_YEAR, ACTOR, NOW, SEED_TODAY)
    const proposed = await loadBudget(db, ASSEMBLY_ID, NEXT, SEED_TODAY)
    // Zero is a decision to spend nothing; absence is a question not yet asked.
    const line = await db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM budgets WHERE bahai_year = ? AND amount_cents = 0',
      [NEXT],
    )
    expect(line!.n).toBe(0)
    expect(proposed.status).toBe('draft')
  })

  it('refuses to overwrite figures already there', async () => {
    await setBudgetLine(db, ASSEMBLY_ID, NEXT, 'cat-rent', 700_000, null, ACTOR, NOW)
    await expect(
      proposeBudget(db, ASSEMBLY_ID, NEXT, SEED_YEAR, ACTOR, NOW, SEED_TODAY),
    ).rejects.toThrow(/already has figures/)
  })

  it('refuses to propose from its own year', async () => {
    await expect(
      proposeBudget(db, ASSEMBLY_ID, NEXT, NEXT, ACTOR, NOW, SEED_TODAY),
    ).rejects.toThrow(/its own year/)
  })

  it('refuses to redraft an approved year', async () => {
    await expect(
      proposeBudget(db, ASSEMBLY_ID, SEED_YEAR, SEED_YEAR - 1, ACTOR, NOW, SEED_TODAY),
    ).rejects.toThrow(/Reopen the year/)
  })
})

describe('the budget API', () => {
  let db: NodeSqlDatabase
  beforeEach(async () => {
    db = await freshDatabase()
  })

  const call = (path: string, init?: RequestInit) =>
    handleApi(new Request(`http://localhost${path}`, init), {
      db,
      assemblyId: ASSEMBLY_ID,
      actor: 'test',
      today: SEED_TODAY,
      now: NOW,
    })

  it('resolves "current" and "next" against the calendar', async () => {
    expect((await (await call('/api/budget/current'))!.json()).bahaiYear).toBe(SEED_YEAR)
    expect((await (await call('/api/budget/next'))!.json()).bahaiYear).toBe(NEXT)
  })

  it('sets a line and returns the whole budget back', async () => {
    const response = (await call('/api/budget/next/line', {
      method: 'PUT',
      body: JSON.stringify({ categoryId: 'cat-rent', amountCents: 700_000 }),
    }))!
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.budgetedExpenseCents).toBe(700_000)
  })

  it('rejects a line with no amount rather than guessing at one', async () => {
    const response = (await call('/api/budget/next/line', {
      method: 'PUT',
      body: JSON.stringify({ categoryId: 'cat-rent' }),
    }))!
    expect(response.status).toBe(400)
  })

  it('proposes, then approves', async () => {
    expect((await call('/api/budget/next/propose', { method: 'POST', body: '{}' }))!.status).toBe(200)
    const approved = (await call('/api/budget/next/approve', {
      method: 'POST',
      body: JSON.stringify({ note: 'Adopted.' }),
    }))!
    expect((await approved.json()).status).toBe('approved')
  })

  it('answers 409 when an approved budget is edited', async () => {
    const response = (await call('/api/budget/183/line', {
      method: 'PUT',
      body: JSON.stringify({ categoryId: 'cat-rent', amountCents: 1 }),
    }))!
    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatch(/Reopen the year/)
  })
})
