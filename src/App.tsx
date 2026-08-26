import { useEffect, useState } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import AppShell from './components/AppShell'
import Loading from './components/Loading'
import { useYearState } from './data/YearContext'
import { fetchSetupStatus } from './data/api'
import YearDashboard from './pages/YearDashboard'
import FeastReportPage from './pages/FeastReportPage'
import LedgerPage, { LedgerLayout } from './pages/LedgerPage'
import ImportPage from './pages/ImportPage'
import CashJournalPage from './pages/CashJournalPage'
import YearSummaryPage from './pages/YearSummaryPage'
import ReceiptsPage from './pages/ReceiptsPage'
import FundsPage, { FundsLayout, FundLedgerPage } from './pages/FundsPage'
import RemittancePage from './pages/RemittancePage'
import BudgetPage from './pages/BudgetPage'
import ReconcilePage, { ReconcileDetailPage } from './pages/ReconcilePage'
import AuditPage, { AuditLayout } from './pages/AuditPage'
import HandoffPage from './pages/HandoffPage'
import ReceiptPage from './pages/ReceiptPage'
import SetupPage from './pages/SetupPage'
import SettingsPage from './pages/SettingsPage'

/**
 * The nav is the six destinations from the source design, all of them now
 * built, plus one screen that lives outside it: setting up.
 */
export default function App() {
  return (
    <Routes>
      {/* Outside the shell on purpose. The shell reads a year, and on a fresh
          deployment there is no Assembly for a year to belong to. */}
      <Route path="setup" element={<SetupPage />} />

      <Route
        element={
          <RequireBooks>
            <AppShell />
          </RequireBooks>
        }
      >
        <Route index element={<YearDashboard />} />
        <Route path="report/:year" element={<YearSummaryPage />} />
        <Route path="report/:year/:month" element={<FeastReportPage />} />
        <Route path="ledger" element={<LedgerLayout />}>
          <Route index element={<LedgerPage />} />
          <Route path="cash" element={<CashJournalPage />} />
          <Route path="import" element={<ImportPage />} />
          <Route path="reconcile" element={<ReconcilePage />} />
          <Route path="reconcile/:id" element={<ReconcileDetailPage />} />
        </Route>
        <Route path="funds" element={<FundsLayout />}>
          <Route index element={<FundsPage />} />
          <Route path="forward" element={<RemittancePage />} />
          <Route path=":key" element={<FundLedgerPage />} />
        </Route>
        <Route path="receipts" element={<ReceiptsPage />} />
        <Route path="receipts/:id" element={<ReceiptPage />} />
        <Route path="budget" element={<BudgetPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="audit" element={<AuditLayout />}>
          <Route index element={<AuditPage />} />
          <Route path="handover" element={<HandoffPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}

/**
 * Send a treasurer with no books to the screen that makes some.
 *
 * The check is deliberately only made once the year has already failed to
 * load. An Assembly that is running normally should not pay a round trip on
 * every page load to be told what it already knows; a fresh deployment can
 * afford one, because the alternative it used to get was a 500 and no way
 * forward.
 *
 * A year that fails for any other reason — the database is down, Access is
 * misconfigured — falls through to the shell, which reports it. Redirecting to
 * setup on every error would offer to open books that already exist.
 */
function RequireBooks({ children }: { children: React.ReactNode }) {
  const state = useYearState()
  const [unopened, setUnopened] = useState<boolean | null>(null)

  useEffect(() => {
    if (state.status !== 'error') return
    let cancelled = false
    fetchSetupStatus()
      .then((status) => {
        if (!cancelled) setUnopened(!status.isSetUp)
      })
      .catch(() => {
        if (!cancelled) setUnopened(false)
      })
    return () => {
      cancelled = true
    }
  }, [state.status])

  if (state.status === 'error' && unopened === null) {
    return <Loading label="Looking for the books" />
  }
  if (unopened) return <Navigate to="/setup" replace />
  return <>{children}</>
}
