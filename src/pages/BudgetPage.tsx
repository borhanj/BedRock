import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { formatLongDate, monthsForYear } from '../calendar/badi'
import { formatMoney, formatSigned, parseMoney, share } from '../lib/money'
import {
  approveBudget,
  fetchBudget,
  proposeBudget,
  reopenBudget,
  setBudgetLine,
  type BudgetLineView,
  type BudgetView,
} from '../data/api'
import { yearProgress } from '../lib/year-progress'
import { useYearState } from '../data/YearContext'
import Loading from '../components/Loading'
import ErrorPanel from '../components/ErrorPanel'

/**
 * Budget against actual, and next year's draft.
 *
 * Two audiences in one screen. Through the year the treasurer reads it as
 * "are we on track", which is why every line is paced against how much of the
 * year has actually run rather than compared with a whole-year figure that
 * will not be reached until ʿAláʼ. In the last month it becomes the place next
 * year's draft is prepared for the Assembly to approve.
 *
 * Nothing here is approved by the treasurer alone. The button says so.
 */
export default function BudgetPage() {
  const state = useYearState()
  const [params, setParams] = useSearchParams()
  const [budget, setBudget] = useState<BudgetView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const which = params.get('year') === 'next' ? 'next' : 'current'

  const load = useCallback(async () => {
    try {
      setBudget(await fetchBudget(which))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [which])

  useEffect(() => {
    void load()
  }, [load])

  if (error) return <ErrorPanel message={error} />
  if (!budget) return <Loading label="Reading the budget" />

  const currentYear = state.status === 'ready' ? state.year.bahaiYear : null

  /** Every action on this page ends the same way: reload, or say why not. */
  const run = async (action: () => Promise<BudgetView>) => {
    setBusy(true)
    setProblem(null)
    try {
      setBudget(await action())
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const empty = [...budget.income, ...budget.passthrough, ...budget.expenses].every(
    (l) => l.budgetCents === 0,
  )
  const editable = budget.status !== 'approved'

  return (
    <div className="bd-page">
      <div className="bd-pagehead">
        <div>
          <p className="bd-eyebrow">
            Budget · {budget.bahaiYear} B.E. ·{' '}
            {budget.status === 'approved'
              ? `approved ${budget.approvedOn ? formatLongDate(budget.approvedOn) : ''}`
              : budget.status === 'draft'
                ? 'draft, not yet approved'
                : 'not yet drafted'}
          </p>
          <h1 className="bd-headline">
            {budget.elapsed === 0
              ? 'The year has not begun'
              : budget.elapsed >= 1
                ? 'The year is complete'
                : `${budget.monthsElapsed} of 19 months gone`}
          </h1>
        </div>

        <nav className="bd-subnav" aria-label="Which year">
          <button
            type="button"
            className={tabClass(which === 'current')}
            onClick={() => setParams({})}
          >
            This year{currentYear ? ` · ${currentYear}` : ''}
          </button>
          <button
            type="button"
            className={tabClass(which === 'next')}
            onClick={() => setParams({ year: 'next' })}
          >
            Next year{currentYear ? ` · ${currentYear + 1}` : ''}
          </button>
        </nav>
      </div>

      {problem && <p className="bd-warn">{problem}</p>}

      {empty ? (
        <EmptyBudget
          budget={budget}
          busy={busy}
          onPropose={() => run(() => proposeBudget(which))}
        />
      ) : (
        <>
          <div className="bd-stats">
            <Stat
              label="Local Fund income"
              value={budget.budgetedIncomeCents}
              beside={budget.actualIncomeCents}
              tone="income"
            />
            <Stat
              label="Planned spending"
              value={budget.budgetedExpenseCents}
              beside={budget.actualExpenseCents}
            />
            <Stat
              label={budget.plannedSurplusCents < 0 ? 'Planned deficit' : 'Planned surplus'}
              value={budget.plannedSurplusCents}
              beside={budget.actualSurplusCents}
              tone="inverse"
            />
          </div>

          <BudgetTable
            title="Contributions to the Local Fund"
            lines={budget.income}
            budget={budget}
            editable={editable && !busy}
            onChanged={load}
            onProblem={setProblem}
          />
          <BudgetTable
            title="Spending planned"
            lines={budget.expenses}
            budget={budget}
            editable={editable && !busy}
            onChanged={load}
            onProblem={setProblem}
          />
          <BudgetTable
            title="Goals for other funds"
            hint="Contributed through this Assembly and forwarded upward. Counted here as
              a goal, and deliberately kept out of the surplus above — none of it is the
              Assembly’s to spend."
            lines={budget.passthrough}
            budget={budget}
            editable={editable && !busy}
            onChanged={load}
            onProblem={setProblem}
          />

          <Unassigned budget={budget} />

          <div className="bd-actions">
            {budget.status === 'approved' ? (
              <>
                <p className="bd-note">
                  {budget.note ??
                    `Approved${budget.approvedBy ? ` by ${budget.approvedBy}` : ''}${
                      budget.approvedOn ? ` on ${formatLongDate(budget.approvedOn)}` : ''
                    }.`}{' '}
                  Changing a figure is a further decision of the Assembly.
                </p>
                <button
                  type="button"
                  className="bd-btn bd-btn--ghost"
                  disabled={busy}
                  onClick={() => run(() => reopenBudget(which))}
                >
                  Reopen for revision
                </button>
              </>
            ) : (
              <>
                <p className="bd-note">
                  A budget is adopted by the Assembly, not by the treasurer. Record the
                  decision here once it has been taken.
                </p>
                <button
                  type="button"
                  className="bd-btn bd-btn--primary"
                  disabled={busy}
                  onClick={() => run(() => approveBudget(which, null))}
                >
                  Record the Assembly’s approval
                </button>
              </>
            )}
          </div>
        </>
      )}

      {budget.proposedFromYear !== null && (
        <p className="bd-note">
          Drafted from {budget.proposedFromYear} B.E. actuals
          {budget.proposedFromMonths !== null && budget.proposedFromMonths < 19
            ? `, which had ${budget.proposedFromMonths} of its 19 months complete at the time`
            : ''}
          .
        </p>
      )}
    </div>
  )
}

const tabClass = (active: boolean) =>
  active ? 'bd-subnav__link bd-subnav__link--active' : 'bd-subnav__link'

function EmptyBudget({
  budget,
  busy,
  onPropose,
}: {
  budget: BudgetView
  busy: boolean
  onPropose: () => void
}) {
  const state = useYearState()
  const source = budget.bahaiYear - 1

  // How much of the source year has actually happened. An Assembly drafts next
  // year's budget before this one has finished, so the figures it would get
  // are usually a part-year — worth saying before the button is pressed rather
  // than only in the footnote afterwards.
  const sourceMonths =
    state.status === 'ready'
      ? yearProgress(monthsForYear(source), state.year.today).monthsClosed
      : null

  return (
    <div className="bd-placeholder">
      <p className="bd-placeholder__title">No budget for {budget.bahaiYear} B.E.</p>
      <p className="bd-placeholder__body">
        Start from what actually happened in {source} B.E. Every figure comes across
        unrounded and unadjusted, as a starting point for the Assembly to argue with —
        nothing here decides anything.
        {sourceMonths !== null && sourceMonths < 19 && (
          <>
            {' '}
            <strong>
              {source} B.E. has {sourceMonths} of its 19 months complete
            </strong>
            , so the figures will cover that much of a year and no more. Every line is
            yours to raise before the Assembly sees it.
          </>
        )}
      </p>
      <button
        type="button"
        className="bd-btn bd-btn--primary"
        disabled={busy}
        onClick={onPropose}
      >
        Draft it from {source} B.E. actuals
      </button>
    </div>
  )
}

function BudgetTable({
  title,
  hint,
  lines,
  budget,
  editable,
  onChanged,
  onProblem,
}: {
  title: string
  hint?: string
  lines: readonly BudgetLineView[]
  budget: BudgetView
  editable: boolean
  onChanged: () => void
  onProblem: (message: string) => void
}) {
  // A category with neither a figure nor any activity is noise on this page.
  const shown = lines.filter((l) => l.budgetCents !== 0 || l.actualCents !== 0)
  if (shown.length === 0) return null

  return (
    <section className="bd-card bd-card--wide">
      <div className="bd-card__head">
        <h2 className="bd-card__title">{title}</h2>
        <p className="bd-card__hint">
          {hint ??
            'The mark on each track is where an even pace through the year would have this line today.'}
        </p>
      </div>

      <table className="bd-table">
        <thead>
          <tr>
            <th>Category</th>
            <th className="bd-table__num">Budget</th>
            <th>Progress</th>
            <th className="bd-table__num">Actual</th>
            <th className="bd-table__num">Variance</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((line) => (
            <BudgetRow
              key={line.categoryId}
              line={line}
              budget={budget}
              editable={editable}
              onChanged={onChanged}
              onProblem={onProblem}
            />
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>Total</td>
            <td className="bd-table__num">
              {formatMoney(shown.reduce((s, l) => s + l.budgetCents, 0))}
            </td>
            <td />
            <td className="bd-table__num">
              {formatMoney(shown.reduce((s, l) => s + l.actualCents, 0))}
            </td>
            <td className="bd-table__num">
              {budget.elapsed === 0
                ? '—'
                : formatSigned(shown.reduce((s, l) => s + l.varianceCents, 0))}
            </td>
          </tr>
        </tfoot>
      </table>
    </section>
  )
}

function BudgetRow({
  line,
  budget,
  editable,
  onChanged,
  onProblem,
}: {
  line: BudgetLineView
  budget: BudgetView
  editable: boolean
  onChanged: () => void
  onProblem: (message: string) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)

  const commit = async () => {
    if (draft === null) return
    const text = draft.trim()
    setDraft(null)

    // An emptied field clears the line, which is not the same as zero: zero is
    // a decision to spend nothing, empty is a question not yet asked.
    const cents = text === '' ? null : parseMoney(text)
    if (text !== '' && cents === null) {
      onProblem(`“${text}” is not an amount. Try 1,200 or 1200.00`)
      return
    }
    if (cents === line.budgetCents) return

    try {
      await setBudgetLine(budget.bahaiYear, {
        categoryId: line.categoryId,
        amountCents: cents,
        note: null,
      })
      onChanged()
    } catch (cause) {
      onProblem(cause instanceof Error ? cause.message : String(cause))
    }
  }

  // Coloured against pace, not against the whole-year figure.
  //
  // Half way through the year every expense line is under budget, so colouring
  // by that would paint the whole table as fine — including a line at 98% of
  // its budget in the fifth month, which is the one line worth looking at.
  // Nor is being under budget on an expense an achievement to celebrate in
  // teal; it is simply the normal state of a year still running.
  const tone = paceTone(line)

  return (
    <tr>
      <td>
        <span className="bd-payee">{line.label}</span>
      </td>
      <td className="bd-table__num">
        {editable ? (
          <input
            className="bd-input bd-input--money"
            inputMode="decimal"
            aria-label={`Budget for ${line.label}`}
            value={draft ?? (line.budgetCents === 0 ? '' : (line.budgetCents / 100).toFixed(2))}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') setDraft(null)
            }}
          />
        ) : (
          formatMoney(line.budgetCents)
        )}
      </td>
      <td>
        <PaceTrack line={line} />
      </td>
      <td className="bd-table__num">{formatMoney(line.actualCents)}</td>
      {/* Nothing has happened in a year that has not started, so there is
          nothing for the figures to vary from. A full-year shortfall printed
          against every line would be arithmetic, not information. */}
      <td className={`bd-table__num ${tone.className}`} title={tone.why}>
        {line.budgetCents === 0 || budget.elapsed === 0
          ? '—'
          : formatSigned(line.varianceCents)}
      </td>
    </tr>
  )
}

/** Where this line stands against an even pace, and how to say it in colour. */
function paceTone(line: BudgetLineView): { className: string; why: string } {
  if (line.budgetCents === 0) return { className: '', why: 'No budget set for this line' }

  if (line.kind === 'expense') {
    if (line.actualCents > line.budgetCents) {
      return { className: 'bd-amount--over', why: 'Past the whole year’s budget' }
    }
    if (line.actualCents > line.pacedCents) {
      return { className: 'bd-amount--pace', why: 'Ahead of an even pace for the year' }
    }
    return { className: '', why: 'Within pace for the year' }
  }

  return line.actualCents >= line.pacedCents
    ? { className: 'bd-amount--in', why: 'At or ahead of an even pace for the year' }
    : { className: 'bd-amount--pace', why: 'Behind an even pace for the year' }
}

/**
 * How far along this line is, against where an even pace would put it.
 *
 * The tick is the point of the whole chart. "Half the budget spent" means one
 * thing in the second month and another in the seventeenth, and a bare
 * percentage cannot tell a treasurer which they are looking at.
 */
function PaceTrack({ line }: { line: BudgetLineView }) {
  if (line.budgetCents === 0) {
    return <span className="bd-table__meta">not budgeted</span>
  }

  const filled = Math.min(1, share(line.actualCents, line.budgetCents))
  const over = line.actualCents > line.budgetCents
  const pace = Math.min(1, share(line.pacedCents, line.budgetCents))

  return (
    <span
      className="bd-pace"
      role="img"
      aria-label={`${Math.round(share(line.actualCents, line.budgetCents) * 100)}% of budget, ${Math.round(pace * 100)}% of the year gone`}
    >
      <span
        className={`bd-pace__fill${over ? ' bd-pace__fill--over' : ''}`}
        style={{ width: `${filled * 100}%` }}
      />
      <span className="bd-pace__tick" style={{ left: `${pace * 100}%` }} />
    </span>
  )
}

function Unassigned({ budget }: { budget: BudgetView }) {
  const { incomeCents, expenseCents } = budget.uncategorised
  if (incomeCents === 0 && expenseCents === 0) return null

  return (
    <p className="bd-note">
      Money in no category —{' '}
      {[
        incomeCents > 0 ? `${formatMoney(incomeCents)} received` : null,
        expenseCents > 0 ? `${formatMoney(expenseCents)} spent` : null,
      ]
        .filter(Boolean)
        .join(' and ')}{' '}
      in {budget.bahaiYear} B.E. — counts in the totals above but against no line.{' '}
      <Link to="/ledger?uncategorised=1">Categorise it</Link> and the variances become
      exact.
    </p>
  )
}

function Stat({
  label,
  value,
  beside,
  tone,
}: {
  label: string
  value: number
  beside: number
  tone?: 'income' | 'inverse'
}) {
  return (
    <div className={`bd-stat${tone ? ` bd-stat--${tone}` : ''}`}>
      <div className="bd-stat__label">{label}</div>
      <div className="bd-stat__value">{formatMoney(value)}</div>
      <div className="bd-stat__beside">{formatMoney(beside)} actual</div>
    </div>
  )
}
