import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useParams } from 'react-router-dom'
import { formatDateRange } from '../calendar/badi'
import { formatMoney, formatSigned } from '../lib/money'
import { fetchFundLedger, fetchFunds, type FundLedgerView, type FundsView } from '../data/api'
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

  useEffect(() => {
    let cancelled = false
    fetchFunds()
      .then((v) => !cancelled && setView(v))
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [])

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
                {fund.key === 'cash' ? (
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
    </>
  )
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
