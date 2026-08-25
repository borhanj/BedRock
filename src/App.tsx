import { Navigate, Route, Routes } from 'react-router-dom'
import AppShell from './components/AppShell'
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
import AuditPage from './pages/AuditPage'

/**
 * The nav is the six destinations from the source design, all of them now
 * built. The placeholder component that stood in for the unbuilt ones is gone
 * with the last of them.
 */
export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
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
        <Route path="budget" element={<BudgetPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
