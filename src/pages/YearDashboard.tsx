import { formatLongDate, monthsForYear, nawRuz } from '../calendar/badi'
import { formatMoney } from '../lib/money'
import { yearProgress } from '../lib/year-progress'
import NineteenMonths from '../components/NineteenMonths'
import WhereMoneySits from '../components/WhereMoneySits'
import NeedsAttention from '../components/NeedsAttention'
import NextFeast from '../components/NextFeast'
import Loading from '../components/Loading'
import ErrorPanel from '../components/ErrorPanel'
import { useYearState } from '../data/YearContext'

/**
 * "The year" — the app's home. Option 1b of the source design: the calendar is
 * the navigation, and everything else on this page hangs off it.
 *
 * Every figure here is computed by the Worker against the database. Nothing on
 * this page does arithmetic on money.
 */
export default function YearDashboard() {
  const state = useYearState()
  if (state.status === 'loading') return <Loading label="Reading the year" />
  if (state.status === 'error') return <ErrorPanel message={state.message} />

  const { year } = state
  const periods = monthsForYear(year.bahaiYear)
  const progress = yearProgress(periods, year.today)

  // Naw-Rúz moves with the vernal equinox, so it is read from the calendar and
  // never assumed to be 21 March.
  const nawRuzDate = formatLongDate(nawRuz(year.bahaiYear)).replace(/^\w+ /, '')

  return (
    <div className="bd-page">
      <div className="bd-pagehead">
        <div>
          <p className="bd-eyebrow">
            Bahá’í year {year.bahaiYear} · Naw-Rúz {nawRuzDate}
          </p>
          <h1 className="bd-headline">{progress.headline}</h1>
        </div>

        <div className="bd-stats">
          <Stat label="Received to date" value={year.receivedToDateCents} tone="income" />
          <Stat label="Paid to date" value={year.paidToDateCents} />
          <Stat label="On hand today" value={year.onHandTodayCents} tone="inverse" />
        </div>
      </div>

      <NineteenMonths
        bahaiYear={year.bahaiYear}
        periods={periods}
        months={year.months}
      />

      <div className="bd-grid3">
        <WhereMoneySits funds={year.funds} />
        <NeedsAttention items={year.attention} />
        <NextFeast
          bahaiYear={year.bahaiYear}
          today={year.today}
          current={progress.current}
        />
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone?: 'income' | 'inverse'
}) {
  const modifier = tone ? ` bd-stat--${tone}` : ''
  return (
    <div className={`bd-stat${modifier}`}>
      <div className="bd-stat__label">{label}</div>
      <div className="bd-stat__value">{formatMoney(value)}</div>
    </div>
  )
}
