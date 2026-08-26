import { Link, NavLink, Outlet } from 'react-router-dom'
import { useYearState } from '../data/YearContext'

const NAV = [
  { to: '/', label: 'The year', end: true },
  { to: '/ledger', label: 'Ledger' },
  { to: '/funds', label: 'Funds' },
  { to: '/receipts', label: 'Receipts' },
  { to: '/budget', label: 'Budget' },
  { to: '/audit', label: 'Audit' },
  { to: '/settings', label: 'Settings' },
]

export default function AppShell() {
  const state = useYearState()
  const assembly = state.status === 'ready' ? state.year.assembly : null
  const bahaiYear = state.status === 'ready' ? state.year.bahaiYear : null
  const sample = state.status === 'ready' && state.year.isSampleData

  return (
    <>
      <header className="bd-topbar">
        <div className="bd-brand">
          <span className="bd-brand__name">{assembly?.shortName ?? 'Bedrock'}</span>
          <span className="bd-brand__year">
            {bahaiYear === null ? '' : `${bahaiYear} B.E.`}
          </span>
        </div>

        <nav className="bd-nav" aria-label="Main">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                isActive ? 'bd-nav__link bd-nav__link--active' : 'bd-nav__link'
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="bd-topbar__actions">
          <button type="button" className="bd-btn bd-btn--solid">
            Add a transaction
          </button>
          {assembly && (
            <span className="bd-avatar" title={`Treasurer · ${assembly.name}`}>
              {assembly.treasurerInitials}
            </span>
          )}
        </div>
      </header>

      {/* Said on every screen, not tucked into Settings.
          A deployment full of the worked example looks exactly like one in
          use — the same totals, the same confident figures — so a treasurer
          who does not already know has no reason to go looking for the way
          out. This is that reason. */}
      {sample && (
        <div className="bd-banner" role="status">
          <span>
            <strong>These are sample books.</strong> Everything here is a worked example
            for a community that does not exist. Clear it out when you are ready to keep
            your own.
          </span>
          <Link className="bd-btn bd-btn--solid" to="/settings#start-fresh">
            Start fresh
          </Link>
        </div>
      )}

      <main>
        <Outlet />
      </main>
    </>
  )
}
