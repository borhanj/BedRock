import { NavLink, Outlet } from 'react-router-dom'
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

      <main>
        <Outlet />
      </main>
    </>
  )
}
