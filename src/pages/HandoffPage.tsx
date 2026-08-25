import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { formatLongDate } from '../calendar/badi'
import {
  downloadHandoffExport,
  fetchHandoff,
  type HandoffStep,
  type HandoffView,
} from '../data/api'
import Loading from '../components/Loading'
import ErrorPanel from '../components/ErrorPanel'

/**
 * Handing the books to the next treasurer.
 *
 * An Assembly elects its officers annually, so the ordinary case is that
 * whoever is holding these books will not be holding them next year. The data
 * survives that easily — it is one file. What gets lost is everything that
 * lives in one person's head, and the donor PIN is the item on this list with
 * no second chance: if it leaves with the outgoing treasurer, the names are
 * gone. Not recoverable by the Assembly, not by this software, not at all.
 *
 * That step is first, and it says so plainly rather than sitting fifth in a
 * tidy checklist.
 */
export default function HandoffPage() {
  const [view, setView] = useState<HandoffView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchHandoff()
      .then((v) => !cancelled && setView(v))
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (error) return <ErrorPanel message={error} />
  if (!view) return <Loading label="Reading the state of the books" />

  const save = async () => {
    setBusy(true)
    setProblem(null)
    try {
      setSaved(await downloadHandoffExport())
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const rows = Object.entries(view.counts).filter(([, n]) => n > 0)
  const total = rows.reduce((sum, [, n]) => sum + n, 0)

  return (
    <>
      <div className="bd-pagehead">
        <div>
          <p className="bd-eyebrow">
            Audit · handing over · {view.assemblyName}
          </p>
          <h1 className="bd-headline">Leaving the books in order</h1>
        </div>
      </div>

      <p className="bd-note">
        Prepared {formatLongDate(view.today)} by {view.preparedBy}, at the close of{' '}
        {view.bahaiYear} B.E.
      </p>

      <ol className="bd-steps">
        {view.steps.map((step, i) => (
          <Step key={step.key} step={step} number={i + 1} />
        ))}
      </ol>

      <section className="bd-card bd-card--wide">
        <div className="bd-card__head">
          <h2 className="bd-card__title">The export</h2>
          <p className="bd-card__hint">
            Every row in one file — ledger, contributions, receipts and their voids,
            funds, budget, reconciliations and the whole audit trail. Lossless, so the
            books can be defended from it alone.
          </p>
        </div>

        <div className="bd-actions bd-actions--left">
          <button
            type="button"
            className="bd-btn bd-btn--primary"
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? 'Preparing…' : 'Save the export file'}
          </button>
          <Link className="bd-btn bd-btn--ghost" to="/audit">
            Draw the audit package
          </Link>
        </div>

        {problem && <p className="bd-warn">{problem}</p>}
        {saved && (
          <p className="bd-note">
            Saved as <strong>{saved}</strong>. It is no more encrypted than the database
            was — donor names stay ciphertext, everything else is readable. Treat it as
            you would the bank statements.
          </p>
        )}

        <table className="bd-table">
          <thead>
            <tr>
              <th>What the file contains</th>
              <th className="bd-table__num">Rows</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([table, n]) => (
              <tr key={table}>
                <td>{TABLE_NAMES[table] ?? table}</td>
                <td className="bd-table__num">{n.toLocaleString('en-US')}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>Format version {view.schemaVersion}</td>
              <td className="bd-table__num">{total.toLocaleString('en-US')}</td>
            </tr>
          </tfoot>
        </table>

        <p className="bd-note">
          The counts are here so a successor can check the file arrived whole rather
          than take it on trust.
        </p>
      </section>

      {/*
        Said rather than quietly omitted. The brief asked for encrypted backup
        to an Assembly-owned Drive folder; that needs OAuth credentials this
        project does not have, and a button that looked like it worked would be
        worse than none.
      */}
      <section className="bd-card bd-card--wide">
        <div className="bd-card__head">
          <h2 className="bd-card__title">Automatic backup is not wired up</h2>
          <p className="bd-card__hint">
            Backing up to an Assembly-owned Google Drive folder needs OAuth credentials
            this deployment does not have, so there is no button for it and no schedule
            running. Until there is, the export above is the backup, and taking one
            after each Feast is the habit worth keeping. There is no silent copy being
            made anywhere.
          </p>
        </div>
      </section>
    </>
  )
}

function Step({ step, number }: { step: HandoffStep; number: number }) {
  return (
    <li className={`bd-step${step.irreversible ? ' bd-step--irreversible' : ''}`}>
      <span className="bd-step__number" aria-hidden="true">
        {number}
      </span>
      <div>
        <p className="bd-step__title">
          {step.title}
          {step.irreversible && <span className="bd-flag bd-flag--warn">no second chance</span>}
        </p>
        <p className="bd-step__detail">{step.detail}</p>
        {step.status && <p className="bd-step__status">{step.status}</p>}
      </div>
    </li>
  )
}

/** The table names, said the way a treasurer would say them. */
const TABLE_NAMES: Record<string, string> = {
  assemblies: 'The Assembly',
  accounts: 'Accounts',
  funds: 'Funds',
  categories: 'Categories',
  donors: 'Donors — names encrypted',
  import_batches: 'Imported statements',
  transactions: 'Transactions',
  contributions: 'Contributions',
  receipts: 'Receipts, voids included',
  remittances: 'Remittances',
  reports: 'Feast reports and their frozen figures',
  attachments: 'Attached documents',
  rules: 'Learned categorisation rules',
  vault: 'Vault parameters — no PIN, no key',
  donor_access_log: 'Who looked at donor detail',
  budget_years: 'Budget years',
  budgets: 'Budget lines',
  reconciliations: 'Bank statements reconciled',
  reconciliation_items: 'What cleared on each statement',
  audit_log: 'The audit trail',
}
