import { useCallback, useEffect, useMemo, useState } from 'react'
import { formatMoney, parseMoney } from '../lib/money'
import {
  fetchSetupStatus,
  openBooks,
  type SetupStatus,
} from '../data/api'
import Loading from '../components/Loading'
import ErrorPanel from '../components/ErrorPanel'
import OpeningPage from './OpeningPage'

/**
 * Opening a new Assembly's books.
 *
 * The screen a treasurer sees before there is anything to see. It runs outside
 * the app shell, because the shell reads a year that does not exist yet.
 *
 * The shape of it follows what the treasurer actually has in front of them, in
 * that order: a bank statement, a tin, and a page from their predecessor. The
 * last step is the one that matters — the difference between what the bank
 * says and what the funds claim, shown as they type, named rather than
 * quietly absorbed, and never a reason they cannot continue. A treasurer who
 * inherits books that do not balance has to be able to say so and start work.
 * Being held at a form until the figures agree teaches them to invent a
 * number, and an invented number is indistinguishable from a real one
 * afterwards.
 */

interface AccountDraft {
  name: string
  kind: 'bank' | 'cash'
  amount: string
}

interface FundDraft {
  key: string
  label: string
  isPassthrough: boolean
  chosen: boolean
  declared: string
}

/**
 * Leaving this screen is a page load, not a route change.
 *
 * The year is fetched once when the app mounts and shared from there, which is
 * right for every other screen and wrong for this one: the fetch that ran
 * before the books existed failed, and routing to the dashboard would show
 * that stale failure over a database that now has an Assembly in it. Reloading
 * is the honest way to start again from a different world.
 */
function leaveForTheBooks(): void {
  window.location.assign('/')
}

export default function SetupPage() {
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchSetupStatus()
      .then(setStatus)
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      )
  }, [])

  if (error) return <ErrorPanel message={error} />
  if (!status) return <Loading label="Looking for existing books" />

  // Books that already exist are not set up again — they are inspected. This
  // route is where a treasurer is sent from the importer when a statement
  // reaches back before the wall, so it has to be the screen that can move it
  // rather than one that says no and stops.
  if (status.isSetUp) return <OpeningPage />

  return <SetupForm status={status} onOpened={leaveForTheBooks} />
}

function SetupForm({
  status,
  onOpened,
}: {
  status: SetupStatus
  onOpened: () => void
}) {
  const [assemblyName, setAssemblyName] = useState('')
  const [shortName, setShortName] = useState('')
  const [openedOn, setOpenedOn] = useState(todayISO())
  const [declaredBy, setDeclaredBy] = useState('')

  const [accounts, setAccounts] = useState<AccountDraft[]>([
    { name: '', kind: 'bank', amount: '' },
    { name: 'Cash box', kind: 'cash', amount: '' },
  ])

  const [funds, setFunds] = useState<FundDraft[]>(
    status.suggestedFunds.map((f) => ({
      key: f.key,
      label: f.label,
      isPassthrough: f.isPassthrough,
      // Nothing is ticked. How a community organises its giving is its own
      // business, and a pre-ticked list is an assumption wearing a checkbox.
      chosen: false,
      declared: '',
    })),
  )

  const [categories, setCategories] = useState<Set<string>>(new Set())
  const [problem, setProblem] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const chosen = funds.filter((f) => f.chosen)

  // The arithmetic the treasurer is watching, recomputed as they type.
  const onHandCents = useMemo(
    () => accounts.reduce((sum, a) => sum + (parseMoney(a.amount) ?? 0), 0),
    [accounts],
  )
  const declaredCents = useMemo(
    () => chosen.reduce((sum, f) => sum + (parseMoney(f.declared) ?? 0), 0),
    [chosen],
  )
  const gapCents = onHandCents - declaredCents

  const setAccount = (i: number, patch: Partial<AccountDraft>) =>
    setAccounts((prev) => prev.map((a, j) => (j === i ? { ...a, ...patch } : a)))

  const setFund = (key: string, patch: Partial<FundDraft>) =>
    setFunds((prev) => prev.map((f) => (f.key === key ? { ...f, ...patch } : f)))

  const addFund = () =>
    setFunds((prev) => [
      ...prev,
      {
        key: `fund-${prev.length + 1}`,
        label: '',
        isPassthrough: true,
        chosen: true,
        declared: '',
      },
    ])

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault()
      setProblem(null)

      const usable = accounts.filter((a) => a.name.trim() && a.amount.trim() !== '')
      if (usable.length === 0) {
        setProblem(
          'Add at least one account with a balance — the bank, or the cash box, or both.',
        )
        return
      }
      for (const account of usable) {
        if (parseMoney(account.amount) === null) {
          setProblem(`"${account.amount}" is not an amount. Write it as 4312.18`)
          return
        }
      }
      for (const fund of chosen) {
        if (fund.declared.trim() !== '' && parseMoney(fund.declared) === null) {
          setProblem(`"${fund.declared}" is not an amount. Write it as 250.00`)
          return
        }
      }

      setSaving(true)
      try {
        await openBooks({
          assemblyName: assemblyName.trim(),
          shortName: shortName.trim() || assemblyName.trim(),
          openedOn,
          funds: chosen.map((f) => ({
            key: f.key,
            label: f.label.trim(),
            isPassthrough: f.isPassthrough,
          })),
          accounts: usable.map((a) => ({
            name: a.name.trim(),
            kind: a.kind,
            openingBalanceCents: parseMoney(a.amount) ?? 0,
          })),
          categories: status.suggestedCategories
            .filter((c) => categories.has(c.label))
            .map((c) => ({ label: c.label, kind: c.kind })),
          declared: Object.fromEntries(
            chosen.map((f) => [f.key, parseMoney(f.declared) ?? 0]),
          ),
          declaredBy: declaredBy.trim(),
        })
        onOpened()
      } catch (cause) {
        setProblem(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setSaving(false)
      }
    },
    [
      accounts, assemblyName, categories, chosen, declaredBy, onOpened, openedOn,
      shortName, status.suggestedCategories,
    ],
  )

  return (
    <main className="bd-page">
      <div className="bd-pagehead">
        <div>
          <p className="bd-eyebrow">Setting up</p>
          <h1 className="bd-headline">Open the books</h1>
        </div>
      </div>

      <form onSubmit={submit}>
        <section className="bd-card bd-card--wide">
          <div className="bd-card__head">
            <h2 className="bd-card__title">The Assembly</h2>
            <p className="bd-card__hint">
              The opening date is a wall: nothing before it is part of these books. Pick
              the date the balances below are true as of — usually the last statement, or
              the day you took over.
            </p>
          </div>

          <div className="bd-formrow">
            <label className="bd-field">
              <span className="bd-field__label">Name</span>
              <input
                className="bd-input"
                value={assemblyName}
                onChange={(e) => setAssemblyName(e.target.value)}
                placeholder="Riverbend Local Spiritual Assembly"
                required
              />
            </label>
            <label className="bd-field">
              <span className="bd-field__label">Short name</span>
              <input
                className="bd-input"
                value={shortName}
                onChange={(e) => setShortName(e.target.value)}
                placeholder="Riverbend"
              />
            </label>
            <label className="bd-field">
              <span className="bd-field__label">Books open on</span>
              <input
                type="date"
                className="bd-input"
                value={openedOn}
                onChange={(e) => setOpenedOn(e.target.value)}
                required
              />
            </label>
          </div>
        </section>

        <section className="bd-card bd-card--wide">
          <div className="bd-card__head">
            <h2 className="bd-card__title">Where the money is</h2>
            <p className="bd-card__hint">
              What the statement says, and what is actually in the tin. Leave a line blank
              if it does not apply.
            </p>
          </div>

          {accounts.map((account, i) => (
            <div className="bd-formrow" key={i}>
              <label className="bd-field">
                <span className="bd-field__label">
                  {account.kind === 'bank' ? 'Bank account' : 'Cash'}
                </span>
                <input
                  className="bd-input"
                  value={account.name}
                  onChange={(e) => setAccount(i, { name: e.target.value })}
                  placeholder={
                    account.kind === 'bank' ? 'Community Credit Union' : 'Cash box'
                  }
                />
              </label>
              <label className="bd-field">
                <span className="bd-field__label">Balance on the opening date</span>
                <input
                  className="bd-input bd-input--money"
                  inputMode="decimal"
                  value={account.amount}
                  onChange={(e) => setAccount(i, { amount: e.target.value })}
                  placeholder="0.00"
                />
              </label>
            </div>
          ))}

          <p className="bd-note">On hand at opening: {formatMoney(onHandCents)}</p>
        </section>

        <section className="bd-card bd-card--wide">
          <div className="bd-card__head">
            <h2 className="bd-card__title">Which funds this Assembly keeps</h2>
            <p className="bd-card__hint">
              Nothing is ticked in advance. One fund has to be the Assembly's own — the
              money it may actually spend. Every other fund is received locally and owed
              upward, and Bedrock will not let it be spent.
            </p>
          </div>

          <table className="bd-table">
            <thead>
              <tr>
                <th>Keep</th>
                <th>Fund</th>
                <th>Whose money</th>
                <th className="bd-table__num">Holds at opening</th>
              </tr>
            </thead>
            <tbody>
              {funds.map((fund) => (
                <tr key={fund.key} className={fund.chosen ? undefined : 'bd-tr--muted'}>
                  <td>
                    <input
                      type="checkbox"
                      checked={fund.chosen}
                      aria-label={`Keep ${fund.label || 'this fund'}`}
                      onChange={(e) => setFund(fund.key, { chosen: e.target.checked })}
                    />
                  </td>
                  <td>
                    <input
                      className="bd-input"
                      value={fund.label}
                      placeholder="Fund name"
                      onChange={(e) => setFund(fund.key, { label: e.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      className="bd-select"
                      value={fund.isPassthrough ? 'upward' : 'own'}
                      onChange={(e) =>
                        setFund(fund.key, { isPassthrough: e.target.value === 'upward' })
                      }
                    >
                      <option value="own">The Assembly's own</option>
                      <option value="upward">Held and forwarded upward</option>
                    </select>
                  </td>
                  <td className="bd-table__num">
                    <input
                      className="bd-input bd-input--money"
                      inputMode="decimal"
                      value={fund.declared}
                      placeholder="0.00"
                      disabled={!fund.chosen}
                      onChange={(e) => setFund(fund.key, { declared: e.target.value })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="bd-actions">
            <button type="button" className="bd-btn bd-btn--ghost" onClick={addFund}>
              Add another fund
            </button>
          </div>

          <details className="bd-amend">
            <summary>What these are</summary>
            <ul>
              {status.suggestedFunds.map((f) => (
                <li key={f.key}>
                  <strong>{f.label}</strong> — {f.note}
                </li>
              ))}
            </ul>
          </details>
        </section>

        <OpeningDifference
          onHandCents={onHandCents}
          declaredCents={declaredCents}
          gapCents={gapCents}
          anyFundChosen={chosen.length > 0}
          declaredBy={declaredBy}
          onDeclaredBy={setDeclaredBy}
        />

        <section className="bd-card bd-card--wide">
          <div className="bd-card__head">
            <h2 className="bd-card__title">Expense categories</h2>
            <p className="bd-card__hint">
              Optional, and easy to change later. These are what the budget and the Feast
              report group spending by.
            </p>
          </div>

          <div className="bd-fundlist">
            {status.suggestedCategories.map((category) => (
              <label className="bd-check" key={category.label}>
                <input
                  type="checkbox"
                  checked={categories.has(category.label)}
                  onChange={(e) => {
                    setCategories((prev) => {
                      const next = new Set(prev)
                      if (e.target.checked) next.add(category.label)
                      else next.delete(category.label)
                      return next
                    })
                  }}
                />
                <span>{category.label}</span>
              </label>
            ))}
          </div>
        </section>

        {problem && <p className="bd-warn">{problem}</p>}

        <div className="bd-actions">
          <button
            type="submit"
            className="bd-btn bd-btn--primary"
            disabled={saving || chosen.length === 0}
          >
            {saving ? 'Opening the books…' : 'Open the books'}
          </button>
        </div>
      </form>
    </main>
  )
}

/**
 * The difference, said out loud.
 *
 * This is the part of the screen the whole feature exists for. It is not a
 * validation error and it does not block anything — it is a figure being
 * named, so that it stays named. The alternative is what happens by default:
 * the Local Fund is the residual of the partition, so an unexplained
 * difference silently becomes part of what the Assembly believes it can spend.
 */
function OpeningDifference({
  onHandCents,
  declaredCents,
  gapCents,
  anyFundChosen,
  declaredBy,
  onDeclaredBy,
}: {
  onHandCents: number
  declaredCents: number
  gapCents: number
  anyFundChosen: boolean
  declaredBy: string
  onDeclaredBy: (value: string) => void
}) {
  return (
    <section className="bd-card bd-card--wide">
      <div className="bd-card__head">
        <h2 className="bd-card__title">Does it agree?</h2>
        <p className="bd-card__hint">
          What is on hand, against what the funds claim. These often do not match on the
          day a treasurer takes over, and that is not a reason to stop.
        </p>
      </div>

      <div className="bd-report__figures">
        <div className="bd-figure bd-figure--in">
          <span className="bd-figure__label">On hand</span>
          <span className="bd-figure__value">{formatMoney(onHandCents)}</span>
        </div>
        <div className="bd-figure">
          <span className="bd-figure__label">Claimed by the funds</span>
          <span className="bd-figure__value">{formatMoney(declaredCents)}</span>
        </div>
        <div className={gapCents === 0 ? 'bd-figure' : 'bd-figure bd-figure--out'}>
          <span className="bd-figure__label">Unaccounted for</span>
          <span className="bd-figure__value">{formatMoney(gapCents)}</span>
        </div>
      </div>

      {!anyFundChosen ? (
        <p className="bd-note">Choose at least one fund above.</p>
      ) : gapCents === 0 ? (
        <p className="bd-note">
          The statement and the funds agree. That is the happy case and not the common
          one — nothing will be carried forward as unexplained.
        </p>
      ) : gapCents > 0 ? (
        <p className="bd-note">
          {formatMoney(gapCents)} is on hand that no fund claims. Bedrock will carry it as
          its own line, under its own name, until the Assembly decides what it is — a
          deposit nobody recorded is the usual answer. It will <strong>not</strong> be
          added to the Local Fund, because money the Assembly cannot explain is not money
          it should be told it can spend.
        </p>
      ) : (
        <p className="bd-warn">
          The funds claim {formatMoney(-gapCents)} more than the Assembly actually holds.
          That is the more serious direction: it usually means money earmarked for another
          institution has been spent on something else. You can open the books with it
          recorded — it will show as a shortfall until it is resolved — but it is worth
          finding before the next Feast.
        </p>
      )}

      <div className="bd-formrow">
        <label className="bd-field">
          <span className="bd-field__label">Whose figures these are</span>
          <input
            className="bd-input"
            value={declaredBy}
            onChange={(e) => onDeclaredBy(e.target.value)}
            placeholder="The outgoing treasurer's name"
          />
        </label>
      </div>
    </section>
  )
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}
