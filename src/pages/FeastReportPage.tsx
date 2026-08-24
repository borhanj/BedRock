import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  formatDateRange,
  formatLongDate,
  formatPeriod,
  monthsForYear,
  type BadiPeriod,
} from '../calendar/badi'
import { formatMoney, formatSigned, share, sumCents } from '../lib/money'
import { fetchReport, startReport } from '../data/api'
import { useYearState } from '../data/YearContext'
import Loading from '../components/Loading'
import ErrorPanel from '../components/ErrorPanel'
import ReportControls from '../components/ReportControls'
import type { ReportLineView, ReportView } from '../shared/types'

/**
 * The Feast report — designed to be projected in a room or read from a phone.
 *
 * It is deliberately inverted on screen. Printed, tokens.css flips the ground
 * to white: a dark A4 page drinks toner and reads badly on paper, and §6 of
 * the requirements wants this in the Audit Package. Everything the treasurer
 * uses to manage the report is marked bd-noprint, so paper gets the report and
 * nothing else.
 */
export default function FeastReportPage() {
  const { year, month } = useParams()
  const bahaiYear = Number(year)
  const monthNumber = Number(month)

  const yearState = useYearState()
  const [report, setReport] = useState<ReportView | null>(null)
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  const load = useCallback(async () => {
    setReport(null)
    setMissing(false)
    setError(null)
    try {
      setReport(await fetchReport(bahaiYear, monthNumber))
    } catch (cause) {
      const status = (cause as { status?: number }).status
      if (status === 404) setMissing(true)
      else setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [bahaiYear, monthNumber])

  useEffect(() => {
    void load()
  }, [load])

  let periods: BadiPeriod[]
  try {
    periods = monthsForYear(bahaiYear)
  } catch (cause) {
    return (
      <ErrorPanel
        title="That year is not on file"
        message={cause instanceof Error ? cause.message : String(cause)}
      />
    )
  }

  const period = periods.find((p) => p.monthNumber === monthNumber)
  if (!period) {
    return (
      <ErrorPanel
        title="No such month"
        message={`A Bahá’í year has nineteen months. ${monthNumber} is not one of them.`}
      />
    )
  }

  if (error) return <ErrorPanel message={error} />

  if (missing) {
    return (
      <div className="bd-placeholder">
        <h1 className="bd-placeholder__title">No report yet for {period.name}</h1>
        <p className="bd-placeholder__body">
          {formatPeriod(period)} runs{' '}
          {formatDateRange(period.startDate, period.endDate)}. Building it opens a draft
          covering those dates, which you can adjust if the bank statement is late.
        </p>
        <p className="bd-placeholder__body">
          <button
            type="button"
            className="bd-btn bd-btn--primary"
            disabled={starting}
            onClick={async () => {
              setStarting(true)
              try {
                setReport(await startReport(bahaiYear, monthNumber))
                setMissing(false)
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : String(cause))
              } finally {
                setStarting(false)
              }
            }}
          >
            Build the {period.name} report
          </button>
        </p>
        <p className="bd-placeholder__body">
          <Link to="/">Back to the year</Link>
        </p>
      </div>
    )
  }

  if (!report) return <Loading label={`Building the ${period.name} report`} />

  const assemblyName =
    yearState.status === 'ready' ? yearState.year.assembly.name : 'Local Spiritual Assembly'

  return (
    <div className="bd-reportwrap">
      <div className="bd-reportbar bd-noprint">
        <Link to="/">← The year</Link>
        <span>
          <Link to={`/report/${bahaiYear}`}>The whole year</Link>
          {'  '}
          <button
            type="button"
            className="bd-btn bd-btn--primary"
            onClick={() => window.print()}
          >
            Print or save as PDF
          </button>
        </span>
      </div>

      <ReportControls report={report} monthName={period.name} onChanged={setReport} />

      <Report
        period={period}
        periods={periods}
        report={report}
        assemblyName={assemblyName}
      />
    </div>
  )
}

function Report({
  period,
  periods,
  report,
  assemblyName,
}: {
  period: BadiPeriod
  periods: BadiPeriod[]
  report: ReportView
  assemblyName: string
}) {
  const incomeCents = sumCents(report.income.map((l) => l.amountCents))
  const expensesCents = sumCents(report.expenses.map((l) => l.amountCents))
  const presentedAt = periods.find((p) => p.monthNumber === report.presentedAtMonth)

  return (
    <article className="bd-report">
      <header className="bd-report__head">
        <div>
          <p className="bd-report__eyebrow">Fund report · {assemblyName}</p>
          <h1 className="bd-report__title">{formatPeriod(period)}</h1>
        </div>
        <p className="bd-report__meta">
          {/*
            The cutoff is the report's own, not the calendar's — it can be
            moved when a statement is late. The title above keeps the Feast
            name regardless.
          */}
          {formatDateRange(report.cutoffStart, report.cutoffEnd)}
          {presentedAt && (
            <>
              <br />
              Presented at the Feast of {presentedAt.name}
            </>
          )}
        </p>
      </header>

      <div className="bd-report__figures">
        <Figure label="We began the month with" value={formatMoney(report.openingCents)} />
        <Figure label="Contributions received" value={formatSigned(incomeCents)} tone="in" />
        <Figure label="Expenses paid" value={formatSigned(-expensesCents)} tone="out" />
      </div>

      <div className="bd-report__cols">
        <section>
          <h2 className="bd-report__colhead">What came in</h2>
          {report.income.length === 0 && (
            <p className="bd-report__aside">No contributions in this period.</p>
          )}
          {report.income.map((line) => (
            <Line key={line.label} line={line} lines={report.income} tone="in" />
          ))}
          {report.contributionCount > 0 && (
            <p className="bd-report__aside">
              {report.contributionCount} contributions from {report.householdCount}{' '}
              households. Individual amounts remain confidential.
            </p>
          )}
        </section>

        <section>
          <h2 className="bd-report__colhead">What went out</h2>
          {report.expenses.length === 0 && (
            <p className="bd-report__aside">No expenses in this period.</p>
          )}
          {report.expenses.map((line) => (
            <Line key={line.label} line={line} lines={report.expenses} tone="out" />
          ))}
          {report.remittedCents > 0 && (
            <p className="bd-report__aside">
              {formatMoney(report.remittedCents)} was forwarded to the National Fund
              during the month.
            </p>
          )}
        </section>
      </div>

      <footer className="bd-report__foot">
        <div>
          <p className="bd-report__footlabel">Balance at the close of {period.name}</p>
          <p className="bd-report__footdetail">
            {report.closingBreakdown
              .map((l) => `${formatMoney(l.amountCents)} ${l.label}`)
              .join(' · ')}
          </p>
          {report.presentedAt && (
            <p className="bd-report__footlabel">
              Presented {formatLongDate(report.presentedAt.slice(0, 10))}
            </p>
          )}
        </div>
        <p className="bd-report__total">{formatMoney(report.closingCents)}</p>
      </footer>
    </article>
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
  // Bars are relative to the largest line in their own column, so the biggest
  // category always fills the track and the rest read against it.
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
