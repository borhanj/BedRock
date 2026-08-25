import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { formatLongDate } from '../calendar/badi'
import { formatMoney } from '../lib/money'
import {
  downloadHandoffExport,
  fetchHandoff,
  inspectBundle,
  restoreBundle,
  type BundleReport,
  type HandoffStep,
  type HandoffView,
  type RestoreResult,
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

      <RestorePanel />

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

/**
 * The other end of the export: reading a book back in.
 *
 * Two steps, never one. Choosing a file only inspects it — the server writes
 * nothing and reports what it found, including anything that would stop the
 * restore. Only then is there a button, and only if the file and the target
 * both allow it.
 *
 * The split is the point. A restore is reached for in a bad moment, and the
 * question worth answering before anything is written is "is this the right
 * file, and is this the right place for it".
 */
function RestorePanel() {
  const [name, setName] = useState<string | null>(null)
  const [bundle, setBundle] = useState<unknown>(null)
  const [report, setReport] = useState<BundleReport | null>(null)
  const [done, setDone] = useState<RestoreResult | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const choose = async (file: File | undefined) => {
    setReport(null)
    setBundle(null)
    setDone(null)
    setProblem(null)
    if (!file) return

    setName(file.name)
    setBusy(true)
    try {
      // Parsed here so a file that is not JSON at all fails immediately and
      // locally, rather than as a puzzling error from the server.
      const parsed = JSON.parse(await file.text())
      setBundle(parsed)
      setReport(await inspectBundle(parsed))
    } catch (cause) {
      setProblem(
        cause instanceof SyntaxError
          ? `${file.name} is not readable as JSON, so it is not a Bedrock export.`
          : cause instanceof Error
            ? cause.message
            : String(cause),
      )
    } finally {
      setBusy(false)
    }
  }

  const run = async () => {
    setBusy(true)
    setProblem(null)
    try {
      setDone(await restoreBundle(bundle))
      setReport(null)
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="bd-card bd-card--wide">
      <div className="bd-card__head">
        <h2 className="bd-card__title">Restoring a book</h2>
        <p className="bd-card__hint">
          For a successor standing up a fresh Bedrock, or for recovering from a backup.
          Choosing a file only looks at it — nothing is written until the figures below
          are the ones you expected.
        </p>
      </div>

      <label className="bd-field">
        <span className="bd-field__label">An export file</span>
        <input
          className="bd-input"
          type="file"
          accept="application/json,.json"
          disabled={busy}
          onChange={(e) => void choose(e.target.files?.[0])}
        />
      </label>

      {problem && <p className="bd-warn">{problem}</p>}

      {report && (
        <>
          <table className="bd-table">
            <tbody>
              <tr>
                <td>Assembly</td>
                <td>{report.assemblyName ?? report.assemblyId}</td>
              </tr>
              <tr>
                <td>Exported</td>
                <td>
                  {report.exportedAt.slice(0, 10)} by {report.exportedBy}
                </td>
              </tr>
              <tr>
                <td>On hand in the file</td>
                <td className="bd-table__num">{formatMoney(report.onHandCents)}</td>
              </tr>
              <tr>
                <td>Rows</td>
                <td className="bd-table__num">
                  {report.totalRows.toLocaleString('en-US')} ·{' '}
                  {report.counts.transactions.toLocaleString('en-US')} transactions
                </td>
              </tr>
            </tbody>
          </table>

          {report.notes.length > 0 && (
            <ul className="bd-checks">
              {report.notes.map((note) => (
                <li className="bd-check bd-check--gap" key={note}>
                  <span className="bd-check__mark" aria-hidden="true">
                    !
                  </span>
                  <span className="bd-check__detail">{note}</span>
                </li>
              ))}
            </ul>
          )}

          {report.problems.length > 0 ? (
            <ul className="bd-checks">
              {report.problems.map((p) => (
                <li className="bd-check bd-check--failed" key={p}>
                  <span className="bd-check__mark" aria-hidden="true">
                    !
                  </span>
                  <span className="bd-check__detail">{p}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="bd-actions">
              <p className="bd-note">
                {name} checks out: every reference in it resolves, every figure is whole
                cents, and this database is empty of {report.assemblyName ?? 'that Assembly'}.
                The original audit trail comes across with it.
              </p>
              <button
                type="button"
                className="bd-btn bd-btn--primary"
                disabled={busy}
                onClick={() => void run()}
              >
                {busy ? 'Restoring…' : 'Restore these books'}
              </button>
            </div>
          )}
        </>
      )}

      {done && (
        <p className="bd-note">
          Restored {done.assemblyName ?? done.assemblyId}:{' '}
          {done.rowsWritten.toLocaleString('en-US')} rows, including{' '}
          {done.auditRowsCarried.toLocaleString('en-US')} audit entries carried across
          with their original actors and dates. The restore itself is recorded as its own
          event. <Link to="/">Open the year</Link>.
        </p>
      )}
    </section>
  )
}
