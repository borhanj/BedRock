import { useNavigate } from 'react-router-dom'
import { formatDateRange, formatPeriod, type BadiPeriod } from '../calendar/badi'
import { formatMoney } from '../lib/money'
import type { MonthActivityView, MonthStatus } from '../shared/types'

const STATUS_CLASS: Record<MonthStatus, string> = {
  closed: 'bd-month__bar--closed',
  ready: 'bd-month__bar--ready',
  current: 'bd-month__bar--current',
  future: '',
}

const STATUS_WORD: Record<MonthStatus, string> = {
  closed: 'closed and reported',
  ready: 'report ready, not yet presented',
  current: 'in progress',
  future: 'not yet begun',
}

interface Props {
  bahaiYear: number
  periods: readonly BadiPeriod[]
  months: readonly MonthActivityView[]
}

/**
 * The year as nineteen bars — the app's primary navigation.
 *
 * Bar height encodes contributions received. That breaks down at zero: a
 * closed month that received nothing collapses to the same 6px stub as a month
 * that has not happened yet. Height alone cannot separate "nothing came in"
 * from "not yet", so an empty closed month gets a distinctly darker fill and
 * says so in its label.
 */
export default function NineteenMonths({ bahaiYear, periods, months }: Props) {
  const navigate = useNavigate()

  const byMonth = new Map(months.map((m) => [m.monthNumber, m]))
  const tallest = Math.max(...months.map((m) => m.contributionsCents), 1)

  return (
    <section className="bd-card bd-card--wide">
      <div className="bd-card__head">
        <h2 className="bd-card__title">The nineteen months</h2>
        <p className="bd-card__hint">
          Height shows contributions received · choose a month for its Feast report
        </p>
      </div>

      <div className="bd-year" role="list">
        {periods.map((period) => {
          if (period.kind === 'ayyam-i-ha') {
            return (
              <div
                key="ayyam"
                role="listitem"
                className="bd-month bd-month--intercalary"
                title={`${period.name} — ${formatDateRange(
                  period.startDate,
                  period.endDate,
                )} (${period.dayCount} days). Intercalary days; no Feast, so no report.`}
              >
                <span className="bd-month__track">
                  <span className="bd-month__bar" />
                </span>
                <span className="bd-month__label">{period.shortName}</span>
              </div>
            )
          }

          const monthNumber = period.monthNumber!
          const activity = byMonth.get(monthNumber)
          const status: MonthStatus = activity?.status ?? 'future'
          const contributionsCents = activity?.contributionsCents ?? 0
          const isEmpty = status !== 'future' && contributionsCents === 0
          const height = (contributionsCents / tallest) * 100

          const amount = isEmpty
            ? 'no contributions recorded'
            : `${formatMoney(contributionsCents)} received`
          const label =
            status === 'future'
              ? `${formatPeriod(period)} — ${STATUS_WORD[status]}`
              : `${formatPeriod(period)} — ${amount}, ${STATUS_WORD[status]}`

          const classes = [
            'bd-month',
            status === 'ready' ? 'bd-month--active' : '',
            status === 'current' ? 'bd-month--now' : '',
          ]
            .filter(Boolean)
            .join(' ')

          const barClasses = [
            'bd-month__bar',
            isEmpty ? 'bd-month__bar--empty' : STATUS_CLASS[status],
          ]
            .filter(Boolean)
            .join(' ')

          return (
            <button
              key={monthNumber}
              type="button"
              role="listitem"
              className={classes}
              title={`${label}\n${formatDateRange(period.startDate, period.endDate)}`}
              aria-label={label}
              disabled={status === 'future'}
              onClick={() => navigate(`/report/${bahaiYear}/${monthNumber}`)}
            >
              <span className="bd-month__track">
                <span
                  className={barClasses}
                  style={height > 0 ? { height: `${height}%` } : undefined}
                />
              </span>
              <span className="bd-month__label">{period.shortName}</span>
            </button>
          )
        })}
      </div>

      <div className="bd-legend">
        <Legend swatch={{ background: 'var(--bd-month-closed)' }} text="Closed & reported" />
        <Legend
          swatch={{ background: 'var(--bd-month-ready)' }}
          text="Report ready, not yet presented"
        />
        <Legend
          swatch={{
            background: 'var(--bd-month-current)',
            borderTop: '2px solid var(--bd-month-current-edge)',
          }}
          text="In progress"
        />
        <Legend
          swatch={{ background: 'var(--bd-month-empty)' }}
          text="Closed, nothing received"
        />
        <Legend
          swatch={{ background: 'var(--bd-intercalary-hatch)' }}
          text="Ayyám-i-Há (intercalary days)"
        />
      </div>
    </section>
  )
}

function Legend({ swatch, text }: { swatch: React.CSSProperties; text: string }) {
  return (
    <span className="bd-legend__item">
      <span className="bd-legend__swatch" style={swatch} aria-hidden="true" />
      {text}
    </span>
  )
}
