import { useCallback, useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useParams } from 'react-router-dom'
import { formatDateRange } from '../calendar/badi'
import { formatMoney, formatSigned, parseMoney } from '../lib/money'
import {
  fetchFundLedger,
  fetchFunds,
  resolveOpeningDifference,
  type FundLedgerView,
  type FundsView,
} from '../data/api'
import Loading from '../components/Loading'
import ErrorPanel from '../components/ErrorPanel'

/** Shared chrome for the fund sub-ledgers and the forwarding screen. */
export function FundsLayout() {
  return (
    <div className="bd-page">
      <nav className="bd-subnav" aria-label="Fund sections">
        <NavLink end to="/funds" className={subnavClass}>
          Sub-ledgers
        </NavLink>
        <NavLink to="/funds/forward" className={subnavClass}>
          Forwarding upward
        </NavLink>
      </nav>
      <Outlet />
    </div>
  )
}

const subnavClass = ({ isActive }: { isActive: boolean }) =>
  isActive ? 'bd-subnav__link bd-subnav__link--active' : 'bd-subnav__link'

/**
 * What each fund holds, and what has moved through it this year.
 *
 * The balance column is the same query the dashboard card reads, so the two
 * screens cannot show a treasurer two different answers to the same question.
 * It is a partition: the rows sum to everything on hand, and the table says so
 * on its last line rather than leaving it to be taken on trust.
 */
export default function FundsPage() {
  const [view, setView] = useState<FundsView | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      setView(await fetchFunds())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  if (error) return <ErrorPanel message={error} />
  if (!view) return <Loading label="Reading the funds" />

  const owed = view.funds.filter((f) => f.isPassthrough && f.balanceCents !== 0)

  return (
    <>
      <div className="bd-pagehead">
        <div>
          <p className="bd-eyebrow">
            Funds · {view.bahaiYear} B.E. · {formatDateRange(view.nawRuz, view.yearEnd)}
          </p>
          <h1 className="bd-headline">
            {owed.length === 0
              ? 'Nothing is waiting to go upward'
              : `${formatMoney(view.owedUpwardCents)} belongs to other funds`}
          </h1>
        </div>
        {owed.length > 0 && (
          <div className="bd-actions">
            <Link className="bd-btn bd-btn--primary" to="/funds/forward">
              Forward it
            </Link>
          </div>
        )}
      </div>

      <table className="bd-table">
        <thead>
          <tr>
            <th>Fund</th>
            <th className="bd-table__num">Received</th>
            <th className="bd-table__num">Spent</th>
            <th className="bd-table__num">Forwarded</th>
            <th className="bd-table__num">Held now</th>
          </tr>
        </thead>
        <tbody>
          {view.funds.map((fund) => (
            <tr key={fund.key}>
              <td>
                {/* The cash box is a place money sits, not a fund it belongs
                    to, so it has no sub-ledger of its own — the cash journal
                    under Ledger is that view. */}
                {fund.isUnexplained ? (
                  <>
                    {fund.label}
                    <span className="bd-memo">
                      no fund claims this — nobody has decided what it is
                    </span>
                  </>
                ) : fund.key === 'cash' ? (
                  <>
                    <Link to="/ledger/cash">{fund.label}</Link>
                    <span className="bd-memo">counted in the cash journal</span>
                  </>
                ) : (
                  <>
                    <Link to={`/funds/${fund.key}`}>{fund.label}</Link>
                    {fund.isPassthrough && (
                      <span className="bd-memo">held for another institution</span>
                    )}
                  </>
                )}
              </td>
              <td className="bd-table__num">
                {fund.receivedCents ? formatMoney(fund.receivedCents) : '—'}
              </td>
              <td className="bd-table__num">
                {fund.spentCents ? formatMoney(fund.spentCents) : '—'}
              </td>
              <td className="bd-table__num">
                {fund.forwardedCents ? formatMoney(fund.forwardedCents) : '—'}
              </td>
              <td className="bd-table__num">{formatMoney(fund.balanceCents)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>On hand today</td>
            <td className="bd-table__num" colSpan={3} />
            <td className="bd-table__num">{formatMoney(view.onHandCents)}</td>
          </tr>
        </tfoot>
      </table>

      <p className="bd-note">
        Every fund above is part of one balance: the rows add up to what is on hand,
        so money cannot belong to two of them or to none.
      </p>

      <OpeningDifference funds={view.funds} onResolved={reload} />
    </>
  )
}

/**
 * Deciding what the opening difference was.
 *
 * Absent unless there is something to decide, which is the point: an Assembly
 * whose books opened clean never sees this, and one that sees it is being
 * asked a real question. The answer is an Assembly decision rather than a
 * treasurer's tidy-up, so the form asks who decided and refuses to record
 * anything without a reason — a figure that moved with nothing beside it is
 * what an auditor asks about and nobody remembers.
 *
 * Part of it can be accounted for and the rest left standing. Finding the
 * missing deposit and still not explaining the last $42 is the normal shape of
 * this, and a form that only took the whole amount would push a treasurer into
 * writing off something they had half explained.
 */
function OpeningDifference({
  funds,
  onResolved,
}: {
  funds: FundsView['funds']
  onResolved: () => void
}) {
  const outstanding = funds.find((f) => f.isUnexplained)
  const destinations = funds.filter((f) => !f.isUnexplained && f.key !== 'cash')

  const [amount, setAmount] = useState('')
  const [toKey, setToKey] = useState('')
  const [reason, setReason] = useState('')
  const [decidedBy, setDecidedBy] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  if (!outstanding) return null

  const gap = outstanding.balanceCents
  const short = gap < 0

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setProblem(null)

    // Blank means all of it, which is the common case and saves retyping a
    // figure that is already on the screen.
    const cents = amount.trim() === '' ? gap : (parseMoney(amount) ?? null)
    if (cents === null || cents === 0) {
      setProblem('Enter how much is being accounted for, or leave it blank for all of it.')
      return
    }

    setSaving(true)
    try {
      await resolveOpeningDifference({
        // Sign is the screen's business, not the treasurer's: they type a
        // positive figure either way and the direction comes from which of
        // the two situations they are in.
        amountCents: short ? -Math.abs(cents) : Math.abs(cents),
        toFundKey: toKey || null,
        reason: reason.trim(),
        decidedBy: decidedBy.trim(),
        occurredOn: todayISO(),
      })
      setAmount('')
      setReason('')
      onResolved()
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="bd-card bd-card--wide">
      <div className="bd-card__head">
        <h2 className="bd-card__title">
          {short
            ? `${formatMoney(-gap)} the funds claim and the Assembly does not hold`
            : `${formatMoney(gap)} nobody has accounted for`}
        </h2>
        <p className="bd-card__hint">
          {short
            ? 'Carried since the books opened. It usually means money earmarked for ' +
              'another institution was spent on something else.'
            : 'On hand since the books opened, claimed by no fund. An unrecorded ' +
              'deposit is the usual answer.'}
        </p>
      </div>

      <form onSubmit={submit}>
        <div className="bd-formrow">
          <label className="bd-field">
            <span className="bd-field__label">How much of it</span>
            <input
              className="bd-input bd-input--money"
              inputMode="decimal"
              value={amount}
              placeholder={formatMoney(Math.abs(gap)).replace(/[^0-9.]/g, '')}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <label className="bd-field">
            <span className="bd-field__label">Belongs to</span>
            <select
              className="bd-select"
              value={toKey}
              onChange={(e) => setToKey(e.target.value)}
            >
              <option value="">The Assembly's own money</option>
              {destinations
                .filter((f) => f.isPassthrough)
                .map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
            </select>
          </label>
          <label className="bd-field">
            <span className="bd-field__label">Who decided</span>
            <input
              className="bd-input"
              value={decidedBy}
              placeholder="The Assembly, minuted 12 Kamál"
              onChange={(e) => setDecidedBy(e.target.value)}
              required
            />
          </label>
        </div>

        <label className="bd-field">
          <span className="bd-field__label">Why — what was it?</span>
          <input
            className="bd-input"
            value={reason}
            placeholder="A deposit made before the books opened and never recorded"
            onChange={(e) => setReason(e.target.value)}
            required
          />
        </label>

        {problem && <p className="bd-warn">{problem}</p>}

        <div className="bd-actions">
          <button type="submit" className="bd-btn bd-btn--primary" disabled={saving}>
            {saving ? 'Recording…' : 'Record the decision'}
          </button>
        </div>
      </form>
    </section>
  )
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * One fund's own ledger, oldest first.
 *
 * A pass-through fund's closing figure is the number the Assembly owes the
 * institution that owns it. The Local Fund's is what remains to be spent.
 */
export function FundLedgerPage() {
  const { key = '' } = useParams()
  const [view, setView] = useState<FundLedgerView | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setView(null)
    setError(null)
    fetchFundLedger(key)
      .then((v) => !cancelled && setView(v))
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [key])

  if (error) return <ErrorPanel message={error} />
  if (!view) return <Loading label="Reading the sub-ledger" />

  return (
    <>
      <div className="bd-pagehead">
        <div>
          <p className="bd-eyebrow">
            <Link to="/funds">← All funds</Link> · {view.bahaiYear} B.E.
          </p>
          <h1 className="bd-headline">{view.label}</h1>
        </div>
        <div className="bd-stats">
          <div className="bd-stat">
            <div className="bd-stat__label">Held at Naw-Rúz</div>
            <div className="bd-stat__value">{formatMoney(view.openingCents)}</div>
          </div>
          <div className="bd-stat bd-stat--inverse">
            <div className="bd-stat__label">
              {view.isPassthrough ? 'Owed upward now' : 'Held now'}
            </div>
            <div className="bd-stat__value">{formatMoney(view.closingCents)}</div>
          </div>
        </div>
      </div>

      {view.entries.length === 0 ? (
        <div className="bd-placeholder">
          <p className="bd-placeholder__body">
            Nothing has moved through {view.label} this year.
          </p>
        </div>
      ) : (
        <table className="bd-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>What</th>
              <th className="bd-table__num">Amount</th>
              <th className="bd-table__num">Balance</th>
            </tr>
          </thead>
          <tbody>
            {view.entries.map((entry) => (
              <tr key={`${entry.movement}-${entry.id}`}>
                <td className="bd-table__date">{entry.occurredOn}</td>
                <td>
                  <span className="bd-payee">{entry.description}</span>
                  {entry.isLocked && (
                    <span className="bd-memo">in a closed period</span>
                  )}
                </td>
                <td
                  className={`bd-table__num ${
                    entry.amountCents > 0 ? 'bd-amount--in' : 'bd-amount--out'
                  }`}
                >
                  {formatSigned(entry.amountCents)}
                </td>
                <td className="bd-table__num bd-running">
                  {formatMoney(entry.balanceCents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {view.isPassthrough && view.closingCents > 0 && (
        <p className="bd-note">
          {formatMoney(view.closingCents)} has been contributed to this fund and not yet
          forwarded. <Link to="/funds/forward">Record a remittance</Link> when it is
          sent.
        </p>
      )}
    </>
  )
}
