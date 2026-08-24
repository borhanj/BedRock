import { useState } from 'react'
import { formatDateRange, formatLongDate } from '../calendar/badi'
import { formatMoney } from '../lib/money'
import {
  finalizeReport,
  presentReport,
  setReportCutoff,
  unlockReport,
} from '../data/api'
import type { ReportView } from '../shared/types'

/**
 * The treasurer's controls for a Feast report. Screen only — `@media print`
 * hides this, so what goes on paper is the report and nothing else.
 *
 * The wording throughout avoids "finalize" and "unlock" in favour of what the
 * acts actually are: closing the books for a period, and reopening them.
 */
export default function ReportControls({
  report,
  monthName,
  onChanged,
}: {
  report: ReportView
  monthName: string
  onChanged: (next: ReportView) => void
}) {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [editingCutoff, setEditingCutoff] = useState(false)

  const run = async (action: () => Promise<ReportView>) => {
    setBusy(true)
    setProblem(null)
    try {
      onChanged(await action())
      setEditingCutoff(false)
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const { bahaiYear, monthNumber, status } = report
  const cutoffMoved =
    report.cutoffStart !== report.calendarStart || report.cutoffEnd !== report.calendarEnd

  return (
    <section className="bd-card bd-card--wide bd-noprint">
      <div className="bd-card__head">
        <h2 className="bd-card__title">
          {status === 'draft'
            ? 'This report is open'
            : status === 'ready'
              ? 'Books closed, not yet presented'
              : 'Presented at Feast'}
        </h2>
        <p className="bd-card__hint">
          {status === 'draft'
            ? 'Figures update as the ledger changes.'
            : `Closed ${report.finalizedAt ? formatLongDate(report.finalizedAt.slice(0, 10)) : ''}`}
        </p>
      </div>

      {/*
        A presented report is a statement already made to the community. If a
        later correction has moved the numbers, the report keeps saying what it
        said and this says so — quietly rewriting it, or quietly serving stale
        figures, would both be worse.
      */}
      {report.drift && (
        <p className="bd-warn">
          The ledger has changed since this report was closed. It still shows the figures
          as presented. Live, the month now reads{' '}
          {formatMoney(report.drift.liveIncomeCents)} in and{' '}
          {formatMoney(report.drift.liveExpensesCents)} out, closing at{' '}
          {formatMoney(report.drift.liveClosingCents)}. Reopen the period to rebuild it.
        </p>
      )}

      <div className="bd-cutoff">
        <div>
          <span className="bd-field__label">Reporting window</span>
          <p className="bd-cutoff__value">
            {formatDateRange(report.cutoffStart, report.cutoffEnd)}
            {cutoffMoved && (
              <span className="bd-flag" title="The calendar month runs to a different date">
                moved from {formatDateRange(report.calendarStart, report.calendarEnd)}
              </span>
            )}
          </p>
        </div>
        {status === 'draft' && !editingCutoff && (
          <button
            type="button"
            className="bd-btn bd-btn--quiet"
            onClick={() => setEditingCutoff(true)}
          >
            Adjust the cutoff
          </button>
        )}
      </div>

      {editingCutoff && (
        <CutoffEditor
          report={report}
          busy={busy}
          onCancel={() => setEditingCutoff(false)}
          onSave={(start, end) =>
            run(() => setReportCutoff(bahaiYear, monthNumber, start, end))
          }
        />
      )}

      <div className="bd-actions bd-actions--left">
        {status === 'draft' && (
          <button
            type="button"
            className="bd-btn bd-btn--primary"
            disabled={busy}
            onClick={() => run(() => finalizeReport(bahaiYear, monthNumber))}
          >
            Close the books for {monthName}
          </button>
        )}
        {status === 'ready' && (
          <button
            type="button"
            className="bd-btn bd-btn--primary"
            disabled={busy}
            onClick={() => run(() => presentReport(bahaiYear, monthNumber))}
          >
            Mark as presented at Feast
          </button>
        )}
        {status !== 'draft' && (
          <button
            type="button"
            className="bd-btn bd-btn--quiet"
            disabled={busy}
            onClick={() => run(() => unlockReport(bahaiYear, monthNumber))}
          >
            Reopen the period
          </button>
        )}
      </div>

      {status === 'draft' ? (
        <p className="bd-note">
          Closing the books freezes these figures and locks {monthName}’s transactions.
          They can be reopened, and the reopening is recorded.
        </p>
      ) : (
        <p className="bd-note">
          {monthName}’s transactions are locked. Reopening the period is recorded in the
          audit trail against your name.
        </p>
      )}

      {problem && <p className="bd-warn">{problem}</p>}
    </section>
  )
}

function CutoffEditor({
  report,
  busy,
  onSave,
  onCancel,
}: {
  report: ReportView
  busy: boolean
  onSave: (start: string, end: string) => void
  onCancel: () => void
}) {
  const [start, setStart] = useState(report.cutoffStart)
  const [end, setEnd] = useState(report.cutoffEnd)

  return (
    <form
      className="bd-formrow"
      onSubmit={(e) => {
        e.preventDefault()
        onSave(start, end)
      }}
    >
      <label className="bd-field">
        <span className="bd-field__label">From</span>
        <input
          className="bd-input"
          type="date"
          value={start}
          onChange={(e) => setStart(e.target.value)}
        />
      </label>
      <label className="bd-field">
        <span className="bd-field__label">To</span>
        <input
          className="bd-input"
          type="date"
          value={end}
          onChange={(e) => setEnd(e.target.value)}
        />
      </label>
      <button type="submit" className="bd-btn bd-btn--primary" disabled={busy}>
        Use this window
      </button>
      <button type="button" className="bd-btn bd-btn--quiet" onClick={onCancel}>
        Cancel
      </button>
      <button
        type="button"
        className="bd-btn bd-btn--quiet"
        onClick={() => {
          setStart(report.calendarStart)
          setEnd(report.calendarEnd)
        }}
      >
        Back to the calendar month
      </button>
      <p className="bd-note">
        The report keeps its Feast name whatever window you choose — the name comes from
        the Baháʼí month, not from these dates.
      </p>
    </form>
  )
}
