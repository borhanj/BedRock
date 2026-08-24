import { Navigate, Route, Routes } from 'react-router-dom'
import AppShell from './components/AppShell'
import YearDashboard from './pages/YearDashboard'
import FeastReportPage from './pages/FeastReportPage'
import Placeholder from './pages/Placeholder'
import LedgerPage, { LedgerLayout } from './pages/LedgerPage'
import ImportPage from './pages/ImportPage'
import CashJournalPage from './pages/CashJournalPage'
import YearSummaryPage from './pages/YearSummaryPage'

/**
 * The nav is the six destinations from the source design. Those not yet built
 * are honest placeholders naming the phase that fills them in, rather than
 * dead links.
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
        </Route>
        <Route
          path="funds"
          element={
            <Placeholder
              title="Funds"
              body="Sub-ledgers for the Local, National and Continental Funds, and a record of what has been forwarded upward. Phase 6."
            />
          }
        />
        <Route
          path="receipts"
          element={
            <Placeholder
              title="Receipts"
              body="Sequentially numbered receipts for cash and cheque contributions. Donor names live behind the treasurer's PIN. Phase 5."
            />
          }
        />
        <Route
          path="budget"
          element={
            <Placeholder
              title="Budget"
              body="Budget against actual by category, and a draft next-year budget proposed from this year's figures for the Assembly to approve. Phase 6."
            />
          }
        />
        <Route
          path="audit"
          element={
            <Placeholder
              title="Audit"
              body="The one-click Audit Package: full ledger, category summaries, bank reconciliation, receipt log and the source documents behind every line. Phase 7."
            />
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
