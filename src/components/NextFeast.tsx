import { useNavigate } from 'react-router-dom'
import {
  formatLongDate,
  nextFeastAfter,
  toISODate,
  toDayIndex,
  type BadiPeriod,
} from '../calendar/badi'


interface Props {
  bahaiYear: number
  /** The server's today, so the browser clock cannot shift the next Feast. */
  today: string
  /** The period we are currently living in — the report that is about to close. */
  current: BadiPeriod | null
}

/**
 * The next Nineteen Day Feast, and the report due for it.
 *
 * The distinction this card exists to make: the Feast NAME comes from the
 * calendar and never moves, but the reporting CUTOFF can. A bank statement
 * that posts late is the normal case, not an exception, so the treasurer can
 * shift the cutoff without the report losing its Feast label.
 */
export default function NextFeast({ bahaiYear, today, current }: Props) {
  const navigate = useNavigate()
  const feast = nextFeastAfter(today)

  // The report presented at the next Feast covers the month now closing, so it
  // closes the day before that Feast.
  const closes = toISODate(toDayIndex(feast.feastDate!) - 1)
  const reportMonth = current?.kind === 'month' ? current : null

  return (
    <section className="bd-card bd-card--inverse">
      <h2 className="bd-card__label">Next Feast</h2>

      <p className="bd-feast__name">{feast.name}</p>
      <p className="bd-feast__date">{formatLongDate(feast.feastDate!)}</p>

      <p className="bd-feast__note">
        {reportMonth ? (
          <>
            The report for {reportMonth.name} closes {formatLongDate(closes).replace(/^\w+ /, '')}.
            You can move the cutoff if the statement is late — the report keeps its Feast
            name.
          </>
        ) : (
          <>
            Ayyám-i-Há holds no Feast. The next report is due for {feast.name}.
          </>
        )}
      </p>

      <div className="bd-feast__actions">
        <button
          type="button"
          className="bd-btn bd-btn--primary bd-btn--block"
          onClick={() =>
            reportMonth && navigate(`/report/${bahaiYear}/${reportMonth.monthNumber}`)
          }
          disabled={!reportMonth}
        >
          Build the {reportMonth?.name ?? feast.name} report
        </button>
        <button type="button" className="bd-btn bd-btn--ghost bd-btn--block">
          Adjust the reporting cutoff
        </button>
      </div>
    </section>
  )
}
