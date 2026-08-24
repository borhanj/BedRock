import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { formatDateRange } from '../calendar/badi'
import { formatMoney, formatSigned, share, sumCents } from '../lib/money'
import { fetchYearSummary } from '../data/api'
import Loading from '../components/Loading'
import ErrorPanel from '../components/ErrorPanel'
import type { ReportLineView, YearSummaryView } from '../shared/types'

const STATUS_WORD: Record<string, string> = {
  presented: 'presented',
  ready: 'closed, not presented',
  draft: 'open',
  none: 'no report',
}

/**
 * The Bahá'í year end to end, for the Assembly's annual review.
 *
 * Computed over the whole year rather than by adding up the monthly reports.
 * A gift that fell on a day no report happened to cover still belongs in the
 * annual figures, and a summary that quietly omitted it would disagree with
 * the ledger at exactly the moment an auditor is looking.
 */
export default function YearSummaryPage() {
  const { year } = useParams()
  const bahaiYear = Number(year)
  const [summary, setSummary] = useState<YearSummaryView | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setSummary(null)
    setError(null)
    fetchYearSummary(bahaiYear)
      .then((s) => !cancelled && setSummary(s))
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [bahaiYear])

  if (error) return <ErrorPanel message={error} />
  if (!summary) return <Loading label={`Adding up ${bahaiYear} B.E.`} />

  const income = sumCents(summary.incomeByFund.map((l) => l.amountCents))
  const expenses = sumCents(summary.expensesByCategory.map((l) => l.amountCents))
  const remitted = sumCents(summary.remittancesByFund.map((l) => l.amountCents))

  return (
    <div className="bd-reportwrap">
      <div className="bd-reportbar bd-noprint">
        <Link to="/">← The year</Link>
        <button
          type="button"
          className="bd-btn bd-btn--primary"
          onClick={() => window.print()}
        >
          Print or save as PDF
        </button>
      </div>

      <article className="bd-report">
        <header className="bd-report__head">
          <div>
            <p className="bd-report__eyebrow">
              Year-end summary · {summary.assembly.name}
            </p>
            <h1 className="bd-report__title">{summary.bahaiYear} B.E.</h1>
          </div>
          <p className="bd-report__meta">
            {formatDateRange(summary.nawRuz, summary.yearEnd)}
            <br />
            {summary.reportsPresented} of 19 Feast reports presented
          </p>
        </header>

        <div className="bd-report__figures">
          <Figure label="Carried in at Naw-Rúz" value={formatMoney(summary.openingCents)} />
          <Figure label="Contributions received" value={formatSigned(income)} tone="in" />
          <Figure label="Expenses paid" value={formatSigned(-expenses)} tone="out" />
        </div>

        <div className="bd-report__cols">
          <section>
            <h2 className="bd-report__colhead">Contributions by fund</h2>
            {summary.incomeByFund.map((line) => (
              <Line key={line.label} line={line} lines={summary.incomeByFund} tone="in" />
            ))}
            <p className="bd-report__aside">
              {summary.contributionCount} contributions from {summary.householdCount}{' '}
              households across the year. Individual amounts remain confidential.
            </p>
          </section>

          <section>
            <h2 className="bd-report__colhead">Expenses by category</h2>
            {summary.expensesByCategory.map((line) => (
              <Line
                key={line.label}
                line={line}
                lines={summary.expensesByCategory}
                tone="out"
              />
            ))}
          </section>
        </div>

        {summary.remittancesByFund.length > 0 && (
          <section className="bd-report__block">
            <h2 className="bd-report__colhead">Forwarded to other funds</h2>
            {summary.remittancesByFund.map((line) => (
              <Line
                key={line.label}
                line={line}
                lines={summary.remittancesByFund}
                tone="out"
              />
            ))}
            <p className="bd-report__aside">
              {formatMoney(remitted)} passed through the local account on its way upward
              and was never the Assembly’s to spend.
            </p>
          </section>
        )}

        <section className="bd-report__block">
          <h2 className="bd-report__colhead">Month by month</h2>
          <table className="bd-report__table">
            <thead>
              <tr>
                <th>Month</th>
                <th className="bd-table__num">In</th>
                <th className="bd-table__num">Out</th>
                <th className="bd-table__num">Forwarded</th>
                <th className="bd-table__num">Closing</th>
                <th>Report</th>
              </tr>
            </thead>
            <tbody>
              {summary.months.map((m) => (
                <tr key={m.monthNumber}>
                  <td>{m.name}</td>
                  <td className="bd-table__num">
                    {m.contributionsCents ? formatMoney(m.contributionsCents) : '—'}
                  </td>
                  <td className="bd-table__num">
                    {m.expensesCents ? formatMoney(m.expensesCents) : '—'}
                  </td>
                  <td className="bd-table__num">
                    {m.remittedCents ? formatMoney(m.remittedCents) : '—'}
                  </td>
                  <td className="bd-table__num">{formatMoney(m.closingCents)}</td>
                  <td className="bd-report__status">{STATUS_WORD[m.status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <footer className="bd-report__foot">
          <div>
            <p className="bd-report__footlabel">Balance at the close of the year</p>
            <p className="bd-report__footdetail">
              {summary.closingBreakdown
                .map((l) => `${formatMoney(l.amountCents)} ${l.label}`)
                .join(' · ')}
            </p>
          </div>
          <p className="bd-report__total">{formatMoney(summary.closingCents)}</p>
        </footer>
      </article>
    </div>
  )
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'in' | 'out'
}) {
  return (
    <div className={tone ? `bd-figure bd-figure--${tone}` : 'bd-figure'}>
      <div className="bd-figure__label">{label}</div>
      <div className="bd-figure__value">{value}</div>
    </div>
  )
}

function Line({
  line,
  lines,
  tone,
}: {
  line: ReportLineView
  lines: readonly ReportLineView[]
  tone: 'in' | 'out'
}) {
  const largest = Math.max(...lines.map((l) => l.amountCents), 1)
  return (
    <div className="bd-line">
      <span className="bd-line__label">{line.label}</span>
      <span className="bd-line__track" aria-hidden="true">
        <span
          className={`bd-line__fill bd-line__fill--${tone}`}
          style={{ width: `${share(line.amountCents, largest) * 100}%` }}
        />
      </span>
      <span className="bd-line__amount">{formatMoney(line.amountCents)}</span>
    </div>
  )
}
