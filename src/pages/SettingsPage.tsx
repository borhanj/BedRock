import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { formatMoney, parseMoney } from '../lib/money'
import {
  addAccount,
  addCategory,
  addFund,
  clearLetterhead,
  fetchSettings,
  renameAssembly,
  renameFund,
  resetEverything,
  setLetterhead,
  updateAccount,
  updateCategory,
  type SettingsView,
} from '../data/api'
import { LetterheadField } from './SetupPage'
import Loading from '../components/Loading'
import ErrorPanel from '../components/ErrorPanel'

/**
 * Everything that was typed once during setup, and got something wrong.
 *
 * The rule this whole screen follows: **rename freely, remove nothing.** An
 * account, fund or category that has ever had money against it is never
 * deleted — every past report points at it, and a Feast report that has been
 * read aloud cannot be made to refer to something that no longer exists.
 * Retiring a row takes it out of the lists a treasurer picks from and leaves
 * the history readable.
 *
 * The one exception is at the bottom, behind the Assembly's own name typed back
 * and a backup offered first.
 */
export default function SettingsPage() {
  const [view, setView] = useState<SettingsView | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setView(await fetchSettings())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (error) return <ErrorPanel message={error} />
  if (!view) return <Loading label="Reading the settings" />

  return (
    <div className="bd-page">
      <div className="bd-pagehead">
        <div>
          <p className="bd-eyebrow">Settings</p>
          <h1 className="bd-headline">{view.name}</h1>
        </div>
        <div className="bd-actions">
          <Link className="bd-btn bd-btn--ghost" to="/setup">
            The opening position
          </Link>
        </div>
      </div>

      <AssemblySection view={view} onSaved={setView} />
      <AccountsSection view={view} onSaved={setView} />
      <FundsSection view={view} onSaved={setView} />
      <CategoriesSection view={view} onSaved={setView} />
      <LetterheadSection view={view} onSaved={setView} />
      <DangerSection view={view} />
    </div>
  )
}

type Saved = (view: SettingsView) => void

/** Small wrapper so every section reports its own failure in its own place. */
function useAction(onSaved: Saved) {
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async (work: () => Promise<SettingsView>) => {
    setProblem(null)
    setBusy(true)
    try {
      onSaved(await work())
      return true
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      setBusy(false)
    }
  }

  return { problem, busy, run }
}

function AssemblySection({ view, onSaved }: { view: SettingsView; onSaved: Saved }) {
  const [name, setName] = useState(view.name)
  const [shortName, setShortName] = useState(view.shortName)
  const { problem, busy, run } = useAction(onSaved)

  return (
    <section className="bd-card bd-card--wide">
      <div className="bd-card__head">
        <h2 className="bd-card__title">The Assembly</h2>
        <p className="bd-card__hint">
          The short name is what appears in the corner of every screen. Renaming changes
          what future documents say; reports already presented keep the name they were
          presented under, because that is what the community heard.
        </p>
      </div>

      <div className="bd-formrow">
        <label className="bd-field">
          <span className="bd-field__label">Name</span>
          <input className="bd-input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="bd-field">
          <span className="bd-field__label">Short name</span>
          <input
            className="bd-input"
            value={shortName}
            onChange={(e) => setShortName(e.target.value)}
          />
        </label>
      </div>

      {problem && <p className="bd-warn">{problem}</p>}

      <div className="bd-actions">
        <button
          type="button"
          className="bd-btn bd-btn--primary"
          disabled={busy || (name === view.name && shortName === view.shortName)}
          onClick={() => void run(() => renameAssembly(name, shortName))}
        >
          Save
        </button>
      </div>
    </section>
  )
}

function AccountsSection({ view, onSaved }: { view: SettingsView; onSaved: Saved }) {
  const { problem, busy, run } = useAction(onSaved)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'bank' | 'cash'>('bank')
  const [amount, setAmount] = useState('')

  return (
    <section className="bd-card bd-card--wide">
      <div className="bd-card__head">
        <h2 className="bd-card__title">Bank accounts and cash journals</h2>
        <p className="bd-card__hint">
          An account with transactions against it is never deleted — the ledger rows and the
          reconciliations that proved them would lose what they were about. Retiring one
          takes it out of the lists without touching a figure.
        </p>
      </div>

      <table className="bd-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Kind</th>
            <th className="bd-table__num">Opened with</th>
            <th className="bd-table__num">Rows</th>
            <th>In use</th>
          </tr>
        </thead>
        <tbody>
          {view.accounts.map((account) => (
            <tr key={account.id} className={account.isActive ? undefined : 'bd-tr--muted'}>
              <td>
                <input
                  className="bd-input"
                  defaultValue={account.name}
                  onBlur={(e) => {
                    if (e.target.value !== account.name) {
                      void run(() => updateAccount(account.id, { name: e.target.value }))
                    }
                  }}
                />
              </td>
              <td className="bd-table__meta">
                {account.kind === 'bank' ? 'bank account' : 'cash journal'}
              </td>
              <td className="bd-table__num">{formatMoney(account.openingBalanceCents)}</td>
              <td className="bd-table__num">{account.transactionCount || '—'}</td>
              <td>
                <button
                  type="button"
                  className="bd-btn bd-btn--ghost"
                  disabled={busy}
                  onClick={() =>
                    void run(() => updateAccount(account.id, { isActive: !account.isActive }))
                  }
                >
                  {account.isActive ? 'Retire it' : 'Bring it back'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="bd-formrow">
        <label className="bd-field">
          <span className="bd-field__label">Add an account</span>
          <input
            className="bd-input"
            value={name}
            placeholder="Building Fund savings"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="bd-field">
          <span className="bd-field__label">Kind</span>
          <select
            className="bd-select"
            value={kind}
            onChange={(e) => setKind(e.target.value as 'bank' | 'cash')}
          >
            <option value="bank">Bank account</option>
            <option value="cash">Cash journal</option>
          </select>
        </label>
        <label className="bd-field">
          <span className="bd-field__label">Held when the books opened</span>
          <input
            className="bd-input bd-input--money"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
      </div>

      <p className="bd-note">
        An account added now still opens on {view.openedOn ?? 'the opening date'} — it is one
        the Assembly already had and had not recorded, not money appearing from nowhere. If
        it genuinely opened empty, leave the balance at nothing.
      </p>

      {problem && <p className="bd-warn">{problem}</p>}

      <div className="bd-actions">
        <button
          type="button"
          className="bd-btn bd-btn--primary"
          disabled={busy || !name.trim()}
          onClick={async () => {
            const ok = await run(() =>
              addAccount({
                name,
                kind,
                openingBalanceCents: parseMoney(amount) ?? 0,
              }),
            )
            if (ok) {
              setName('')
              setAmount('')
            }
          }}
        >
          Add it
        </button>
      </div>
    </section>
  )
}

function FundsSection({ view, onSaved }: { view: SettingsView; onSaved: Saved }) {
  const { problem, busy, run } = useAction(onSaved)
  const [label, setLabel] = useState('')

  return (
    <section className="bd-card bd-card--wide">
      <div className="bd-card__head">
        <h2 className="bd-card__title">Funds</h2>
        <p className="bd-card__hint">
          A fund cannot change sides here. The Assembly's own fund is the residual of the
          balance — everything left once the funds held for others and the cash box are set
          aside — so there is exactly one, and turning another into it would silently
          re-partition every figure the app has ever shown. A fund added here is one held
          for another institution and forwarded upward.
        </p>
      </div>

      <table className="bd-table">
        <thead>
          <tr>
            <th>Fund</th>
            <th>Whose money</th>
            <th className="bd-table__num">Gifts recorded</th>
          </tr>
        </thead>
        <tbody>
          {view.funds.map((fund) => (
            <tr key={fund.id}>
              <td>
                <input
                  className="bd-input"
                  defaultValue={fund.label}
                  onBlur={(e) => {
                    if (e.target.value !== fund.label) {
                      void run(() => renameFund(fund.id, e.target.value))
                    }
                  }}
                />
              </td>
              <td className="bd-table__meta">
                {fund.isPassthrough ? 'held and forwarded upward' : "the Assembly's own"}
              </td>
              <td className="bd-table__num">{fund.contributionCount || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {problem && <p className="bd-warn">{problem}</p>}

      <div className="bd-formrow">
        <label className="bd-field">
          <span className="bd-field__label">Add a fund held for another institution</span>
          <input
            className="bd-input"
            value={label}
            placeholder="Regional Council Fund"
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
      </div>
      <div className="bd-actions">
        <button
          type="button"
          className="bd-btn bd-btn--primary"
          disabled={busy || !label.trim()}
          onClick={async () => {
            const ok = await run(() => addFund({ key: label, label }))
            if (ok) setLabel('')
          }}
        >
          Add it
        </button>
      </div>
    </section>
  )
}

function CategoriesSection({ view, onSaved }: { view: SettingsView; onSaved: Saved }) {
  const { problem, busy, run } = useAction(onSaved)
  const [label, setLabel] = useState('')
  const [kind, setKind] = useState<'income' | 'expense'>('expense')
  const [fundKey, setFundKey] = useState('')

  return (
    <section className="bd-card bd-card--wide">
      <div className="bd-card__head">
        <h2 className="bd-card__title">Categories</h2>
        <p className="bd-card__hint">
          What the budget and the Feast report group spending by. An income category names
          the fund it feeds, so money owed upward stays out of what the Assembly can spend.
          Archived categories keep every past report readable and stop appearing in the
          lists.
        </p>
      </div>

      <table className="bd-table">
        <thead>
          <tr>
            <th>Category</th>
            <th>Kind</th>
            <th className="bd-table__num">Rows</th>
            <th>In use</th>
          </tr>
        </thead>
        <tbody>
          {view.categories.map((category) => (
            <tr key={category.id} className={category.isArchived ? 'bd-tr--muted' : undefined}>
              <td>
                <input
                  className="bd-input"
                  defaultValue={category.label}
                  onBlur={(e) => {
                    if (e.target.value !== category.label) {
                      void run(() => updateCategory(category.id, { label: e.target.value }))
                    }
                  }}
                />
              </td>
              <td className="bd-table__meta">{category.kind}</td>
              <td className="bd-table__num">{category.transactionCount || '—'}</td>
              <td>
                <button
                  type="button"
                  className="bd-btn bd-btn--ghost"
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      updateCategory(category.id, { isArchived: !category.isArchived }),
                    )
                  }
                >
                  {category.isArchived ? 'Bring it back' : 'Archive it'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="bd-formrow">
        <label className="bd-field">
          <span className="bd-field__label">Add a category</span>
          <input
            className="bd-input"
            value={label}
            placeholder="Youth activities"
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <label className="bd-field">
          <span className="bd-field__label">Kind</span>
          <select
            className="bd-select"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as 'income' | 'expense')
              setFundKey('')
            }}
          >
            <option value="expense">Expense</option>
            <option value="income">Income</option>
          </select>
        </label>
        {kind === 'income' && (
          <label className="bd-field">
            <span className="bd-field__label">Feeds which fund</span>
            <select
              className="bd-select"
              value={fundKey}
              onChange={(e) => setFundKey(e.target.value)}
            >
              <option value="">No particular fund</option>
              {view.funds.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {problem && <p className="bd-warn">{problem}</p>}

      <div className="bd-actions">
        <button
          type="button"
          className="bd-btn bd-btn--primary"
          disabled={busy || !label.trim()}
          onClick={async () => {
            const ok = await run(() =>
              addCategory({ label, kind, fundKey: kind === 'income' ? fundKey || null : null }),
            )
            if (ok) setLabel('')
          }}
        >
          Add it
        </button>
      </div>
    </section>
  )
}

function LetterheadSection({ view, onSaved }: { view: SettingsView; onSaved: Saved }) {
  const { problem, busy, run } = useAction(onSaved)
  const current = view.branding.letterheadDataUrl

  return (
    <>
      {current ? (
        <section className="bd-card bd-card--wide">
          <div className="bd-card__head">
            <h2 className="bd-card__title">Letterhead</h2>
            <p className="bd-card__hint">
              Printed at the top of every receipt.
              {view.branding.letterheadBytes
                ? ` ${Math.round(view.branding.letterheadBytes / 1024)}kB`
                : ''}
              {view.branding.letterheadFilename
                ? ` · ${view.branding.letterheadFilename}`
                : ''}
              {view.branding.updatedBy ? ` · uploaded by ${view.branding.updatedBy}` : ''}
            </p>
          </div>
          <img
            src={current}
            alt="The Assembly's letterhead"
            style={{ maxWidth: '320px', maxHeight: '120px' }}
          />
          {problem && <p className="bd-warn">{problem}</p>}
          <div className="bd-actions">
            <button
              type="button"
              className="bd-btn bd-btn--ghost"
              disabled={busy}
              onClick={() => void run(() => clearLetterhead())}
            >
              Remove it
            </button>
          </div>
        </section>
      ) : (
        <>
          <LetterheadField
            value={null}
            maxBytes={view.letterheadMaxBytes}
            onChange={(next) => {
              if (next) void run(() => setLetterhead(next.dataUrl, next.filename))
            }}
          />
          {problem && <p className="bd-warn">{problem}</p>}
        </>
      )}
    </>
  )
}

/**
 * Clearing the books.
 *
 * The backup comes first on the screen, not as an afterthought, because this is
 * the only thing in Bedrock that destroys records and the export is the only
 * way back from it. Typing the Assembly's name is checked on the server against
 * the stored name, so it cannot be shortcut by a client.
 */
function DangerSection({ view }: { view: SettingsView }) {
  const [confirmation, setConfirmation] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)

  const reset = async () => {
    setProblem(null)
    setBusy(true)
    try {
      await resetEverything(confirmation)
      // A full page load rather than a route change: every cached view in the
      // app is about an Assembly that no longer exists.
      window.location.assign('/setup')
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  return (
    <section className="bd-card bd-card--wide">
      <div className="bd-card__head">
        <h2 className="bd-card__title">Clear these books and start again</h2>
        <p className="bd-card__hint">
          For a deployment that was filled with a demonstration and needs to hold something
          true. It deletes every transaction, receipt, report, fund, donor record and audit
          entry, and it cannot be undone from inside the app.
        </p>
      </div>

      <ol className="bd-steps">
        <li className="bd-step">
          <span className="bd-step__number">1</span>
          <span className="bd-step__title">
            Take a backup first
            <span className="bd-step__detail">
              A complete copy of everything, as one file.{' '}
              <Link to="/audit/handover">Download it from the handover page</Link>, and keep
              it somewhere that is not this laptop. The same page reads one back in, which is
              the only way to undo what is below.
            </span>
          </span>
        </li>
        <li className="bd-step bd-step--irreversible">
          <span className="bd-step__number">2</span>
          <span className="bd-step__title">
            Then clear them
            <span className="bd-step__detail">
              The donor PIN goes too. Encrypted names in a backup taken before this stay
              unreadable without it — that is the encryption working correctly, and it is
              worth knowing before rather than after.
            </span>
          </span>
        </li>
      </ol>

      {!open ? (
        <div className="bd-actions">
          <button type="button" className="bd-btn bd-btn--ghost" onClick={() => setOpen(true)}>
            I have a backup — clear the books
          </button>
        </div>
      ) : (
        <>
          <label className="bd-field">
            <span className="bd-field__label">
              Type “{view.name}” to confirm
            </span>
            <input
              className="bd-input"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              placeholder={view.name}
            />
          </label>

          {problem && <p className="bd-warn">{problem}</p>}

          <div className="bd-actions">
            <button
              type="button"
              className="bd-btn bd-btn--primary"
              disabled={busy || confirmation !== view.name}
              onClick={() => void reset()}
            >
              {busy ? 'Clearing…' : 'Delete everything'}
            </button>
            <button type="button" className="bd-btn bd-btn--ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </>
      )}
    </section>
  )
}
