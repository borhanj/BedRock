import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { formatLongDate } from '../calendar/badi'
import { formatMoney, formatSigned, parseMoney } from '../lib/money'
import {
  completeReconciliation,
  fetchChoices,
  fetchReconciliation,
  fetchReconciliations,
  reopenReconciliation,
  setCleared,
  setStatement,
  startReconciliation,
  type Choices,
  type ReconciliationSummary,
  type ReconciliationView,
} from '../data/api'
import Loading from '../components/Loading'
import ErrorPanel from '../components/ErrorPanel'

/**
 * The statements, and where each one stands.
 *
 * Reconciliation is the check that catches what nothing else will: a payment
 * that never left, a deposit that never arrived, a figure typed twice. It is
 * also the only screen here where the treasurer works from paper, so it is
 * built to be read beside a statement rather than instead of one.
 */
export default function ReconcilePage() {
  const [list, setList] = useState<ReconciliationSummary[] | null>(null)
  const [choices, setChoices] = useState<Choices | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [rows, options] = await Promise.all([fetchReconciliations(), fetchChoices()])
      setList(rows)
      setChoices(options)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (error) return <ErrorPanel message={error} />
  if (!list || !choices) return <Loading label="Reading the statements" />

  const open = list.filter((r) => r.status === 'open')

  return (
    <>
      <div className="bd-pagehead">
        <div>
          <p className="bd-eyebrow">Ledger · reconcile</p>
          <h1 className="bd-headline">
            {list.length === 0
              ? 'No statement has been reconciled yet'
              : open.length > 0
                ? `${open.length} statement${open.length === 1 ? '' : 's'} still open`
                : `Reconciled to ${list[0].statementEndedOn}`}
          </h1>
        </div>
      </div>

      <StartForm choices={choices} onStarted={load} />

      {list.length > 0 && (
        <table className="bd-table">
          <thead>
            <tr>
              <th>Statement ended</th>
              <th>Account</th>
              <th className="bd-table__num">Statement balance</th>
              <th className="bd-table__num">Difference</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {list.map((row) => (
              <tr key={row.id}>
                <td className="bd-table__date">
                  <Link to={`/ledger/reconcile/${encodeURIComponent(row.id)}`}>
                    {row.statementEndedOn}
                  </Link>
                </td>
                <td>{row.accountName}</td>
                <td className="bd-table__num">
                  {formatMoney(row.statementBalanceCents)}
                </td>
                <td
                  className={`bd-table__num ${
                    row.differenceCents === 0 ? '' : 'bd-amount--pace'
                  }`}
                >
                  {row.differenceCents === 0 ? '—' : formatSigned(row.differenceCents)}
                </td>
                <td className="bd-table__meta">
                  {row.status === 'balanced' ? 'balanced' : 'open'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

function StartForm({
  choices,
  onStarted,
}: {
  choices: Choices
  onStarted: () => void
}) {
  const navigate = useNavigate()
  const bank = choices.accounts.filter((a) => a.kind === 'bank')
  const [accountId, setAccountId] = useState(bank[0]?.id ?? choices.accounts[0]?.id ?? '')
  const [endedOn, setEndedOn] = useState('')
  const [balance, setBalance] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setProblem(null)

    // A statement can legitimately end overdrawn, so a negative is allowed
    // here where it is not on a contribution.
    const cents = parseMoney(balance)
    if (cents === null) {
      setProblem('Enter the closing balance printed on the statement, for example 5,172.40')
      return
    }
    if (!endedOn) {
      setProblem('Enter the date the statement ends.')
      return
    }

    setBusy(true)
    try {
      const view = await startReconciliation({
        accountId,
        statementEndedOn: endedOn,
        statementBalanceCents: cents,
      })
      onStarted()
      navigate(`/ledger/reconcile/${encodeURIComponent(view.id)}`)
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="bd-card bd-card--wide">
      <div className="bd-card__head">
        <h2 className="bd-card__title">Start from a statement</h2>
        <p className="bd-card__hint">
          Two figures off the paper: the date it ends and the closing balance it prints.
          Everything else is worked out from the ledger.
        </p>
      </div>

      <form className="bd-formrow" onSubmit={submit}>
        <label className="bd-field">
          <span className="bd-field__label">Account</span>
          <select
            className="bd-select"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
          >
            {choices.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>

        <label className="bd-field">
          <span className="bd-field__label">Statement ends</span>
          <input
            className="bd-input"
            type="date"
            value={endedOn}
            onChange={(e) => setEndedOn(e.target.value)}
          />
        </label>

        <label className="bd-field">
          <span className="bd-field__label">Closing balance</span>
          <input
            className="bd-input"
            inputMode="decimal"
            placeholder="5,172.40"
            value={balance}
            onChange={(e) => setBalance(e.target.value)}
          />
        </label>

        <button type="submit" className="bd-btn bd-btn--primary" disabled={busy}>
          {busy ? 'Starting…' : 'Start reconciling'}
        </button>
      </form>

      {problem && <p className="bd-warn">{problem}</p>}
    </section>
  )
}

/**
 * One statement, ticked off.
 *
 * The difference is the headline, because it is the only number that decides
 * anything. There is no adjustment control anywhere on this page and there
 * will not be one: a plug entry makes the books agree with the bank while
 * hiding the reason they did not, and that reason is what this screen exists
 * to surface.
 */
export function ReconcileDetailPage() {
  const { id = '' } = useParams()
  const [view, setView] = useState<ReconciliationView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    setView(null)
    fetchReconciliation(id)
      .then((v) => !cancelled && setView(v))
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [id])

  if (error) return <ErrorPanel message={error} />
  if (!view) return <Loading label="Reading the statement" />

  const run = async (action: () => Promise<ReconciliationView>) => {
    setBusy(true)
    setProblem(null)
    try {
      setView(await action())
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const balanced = view.status === 'balanced'
  const agrees = view.differenceCents === 0

  return (
    <>
      <div className="bd-pagehead">
        <div>
          <p className="bd-eyebrow">
            <Link to="/ledger/reconcile">← All statements</Link> · {view.accountName}
          </p>
          <h1 className="bd-headline">
            Statement to {formatLongDate(view.statementEndedOn)}
          </h1>
        </div>

        <div className="bd-stats">
          <div className="bd-stat">
            <div className="bd-stat__label">The statement says</div>
            <div className="bd-stat__value">
              {formatMoney(view.statementBalanceCents)}
            </div>
          </div>
          <div className="bd-stat">
            <div className="bd-stat__label">The books say</div>
            <div className="bd-stat__value">
              {formatMoney(view.reconciledBalanceCents)}
            </div>
            <div className="bd-stat__beside">
              opening, plus everything cleared
            </div>
          </div>
          <div className={`bd-stat ${agrees ? 'bd-stat--income' : 'bd-stat--inverse'}`}>
            <div className="bd-stat__label">Difference</div>
            <div className="bd-stat__value">
              {agrees ? formatMoney(0) : formatSigned(view.differenceCents)}
            </div>
          </div>
        </div>
      </div>

      {problem && <p className="bd-warn">{problem}</p>}

      <div className="bd-actions">
        {balanced ? (
          <>
            <p className="bd-note">
              Balanced
              {view.completedBy ? ` by ${view.completedBy}` : ''}. The ledger and the
              statement agreed to the cent on {view.statementEndedOn}.
            </p>
            <button
              type="button"
              className="bd-btn bd-btn--ghost"
              disabled={busy}
              onClick={() => run(() => reopenReconciliation(view.id))}
            >
              Reopen it
            </button>
          </>
        ) : (
          <>
            <p className="bd-note">
              {view.outstandingCount === 0
                ? 'Everything on the account up to this date has been ticked.'
                : `${view.outstandingCount} item${
                    view.outstandingCount === 1 ? '' : 's'
                  } not ticked, worth ${formatMoney(
                    Math.abs(view.outstandingCents),
                  )} — cheques that have not reached the bank, or deposits still in transit.`}{' '}
              {agrees
                ? 'The difference is nothing, so the account is proved.'
                : 'There is no adjusting entry here: an unexplained difference is the finding, not an inconvenience.'}
            </p>
            <button
              type="button"
              className="bd-btn bd-btn--primary"
              disabled={busy || !agrees}
              title={
                agrees ? undefined : 'The statement and the books still differ'
              }
              onClick={() => run(() => completeReconciliation(view.id))}
            >
              Mark it balanced
            </button>
          </>
        )}
      </div>

      {!balanced && <AmendStatement view={view} busy={busy} onAmended={run} />}

      <table className="bd-table">
        <thead>
          <tr>
            <th>On the statement</th>
            <th>Date</th>
            <th>Payee</th>
            <th className="bd-table__num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {view.items.map((item) => (
            <tr key={item.id} className={item.isCleared ? undefined : 'bd-tr--todo'}>
              <td>
                <input
                  type="checkbox"
                  checked={item.isCleared}
                  disabled={balanced || busy}
                  aria-label={`${item.payee ?? item.id} has cleared the bank`}
                  onChange={(e) =>
                    void run(() => setCleared(view.id, item.id, e.target.checked))
                  }
                />
              </td>
              <td className="bd-table__date">{item.occurredOn}</td>
              <td>
                <span className="bd-payee">{item.payee ?? '—'}</span>
                {item.memo && <span className="bd-memo">{item.memo}</span>}
              </td>
              <td
                className={`bd-table__num ${
                  item.amountCents > 0 ? 'bd-amount--in' : 'bd-amount--out'
                }`}
              >
                {formatSigned(item.amountCents)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={3}>Cleared on this statement</td>
            <td className="bd-table__num">{formatMoney(view.clearedHereCents)}</td>
          </tr>
        </tfoot>
      </table>

      {view.items.length === 0 && (
        <p className="bd-note">
          Nothing on this account is dated on or before {view.statementEndedOn} and still
          waiting to clear.
        </p>
      )}
    </>
  )
}

/**
 * Correct what was read off the paper.
 *
 * A mistyped closing balance is the commonest reason a reconciliation will not
 * close, and without this the treasurer would be stuck: the statement date is
 * unique per account, so starting again is refused, and there is deliberately
 * no adjusting entry to paper over the gap. Amending the figure is the honest
 * fix, and it is audited like every other write.
 */
function AmendStatement({
  view,
  busy,
  onAmended,
}: {
  view: ReconciliationView
  busy: boolean
  onAmended: (action: () => Promise<ReconciliationView>) => void
}) {
  const [endedOn, setEndedOn] = useState(view.statementEndedOn)
  const [balance, setBalance] = useState((view.statementBalanceCents / 100).toFixed(2))
  const [problem, setProblem] = useState<string | null>(null)

  return (
    <details className="bd-amend">
      <summary>The statement says something else</summary>
      <form
        className="bd-formrow"
        onSubmit={(event) => {
          event.preventDefault()
          const cents = parseMoney(balance)
          if (cents === null) {
            setProblem('That is not an amount. Try 5,045.90')
            return
          }
          setProblem(null)
          onAmended(() => setStatement(view.id, endedOn, cents))
        }}
      >
        <label className="bd-field">
          <span className="bd-field__label">Statement ends</span>
          <input
            className="bd-input"
            type="date"
            value={endedOn}
            onChange={(e) => setEndedOn(e.target.value)}
          />
        </label>
        <label className="bd-field">
          <span className="bd-field__label">Closing balance</span>
          <input
            className="bd-input"
            inputMode="decimal"
            value={balance}
            onChange={(e) => setBalance(e.target.value)}
          />
        </label>
        <button type="submit" className="bd-btn bd-btn--ghost" disabled={busy}>
          Correct it
        </button>
      </form>
      {problem && <p className="bd-warn">{problem}</p>}
    </details>
  )
}
