import { useCallback, useMemo, useEffect, useState } from 'react'
import { formatMoney, parseMoney } from '../lib/money'
import { fetchSetupStatus, openBooks, type SetupStatus } from '../data/api'
import Loading from '../components/Loading'
import ErrorPanel from '../components/ErrorPanel'
import OpeningPage from './OpeningPage'

/**
 * Getting started: opening a new Assembly's books.
 *
 * Runs outside the app shell, because the shell reads a year that does not
 * exist yet.
 *
 * A walkthrough rather than one long form, and the difference is not
 * decoration. A treasurer arriving here has usually never done this job before,
 * is holding three pieces of paper that do not agree, and does not yet know
 * which of the questions matter. One page of thirty fields answers none of
 * that. Seven short steps, each explaining what it is asking for and why, is
 * the same work arranged so it can be finished.
 *
 * Two things are deliberate. Every step can be gone back to, and nothing is
 * written until the last one, so exploring costs nothing. And each step
 * validates itself before letting the treasurer past — being told at the end
 * that something on the second screen was wrong is how people abandon forms.
 *
 * The step that matters is the difference between what the bank says and what
 * the funds claim: shown live, named rather than quietly absorbed, and never a
 * reason the treasurer cannot continue. Being held at a form until the figures
 * agree teaches someone to invent a number, and an invented number is
 * indistinguishable from a real one afterwards.
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
 * before the books existed failed, and routing to the dashboard would show that
 * stale failure over a database that now has an Assembly in it.
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
  // route is also where the importer sends a treasurer when a statement reaches
  // back before the opening date, so it has to be the screen that can move that
  // wall rather than one that says no and stops.
  if (status.isSetUp) return <OpeningPage />

  return <SetupWizard status={status} onOpened={leaveForTheBooks} />
}

const STEPS = [
  'Before you start',
  'Your Assembly',
  'Where the money is',
  'Which funds',
  'What each fund holds',
  'Finishing touches',
  'Review and open',
] as const

function SetupWizard({ status, onOpened }: { status: SetupStatus; onOpened: () => void }) {
  const [step, setStep] = useState(0)

  const [assemblyName, setAssemblyName] = useState('')
  const [shortName, setShortName] = useState('')
  const [openedOn, setOpenedOn] = useState(todayISO())
  const [declaredBy, setDeclaredBy] = useState('')

  // Two accounts to start with because almost every Assembly has exactly these
  // two — but both removable and any number addable. Some keep a second bank
  // account for a building fund, some run entirely on cash, and some keep two
  // tins because two people collect at Feast.
  const [accounts, setAccounts] = useState<AccountDraft[]>([
    { name: '', kind: 'bank', amount: '' },
    { name: 'Cash box', kind: 'cash', amount: '' },
  ])
  const [letterhead, setLetterhead] = useState<{ dataUrl: string; filename: string } | null>(
    null,
  )
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
  const ownFund = chosen.find((f) => !f.isPassthrough)
  const usableAccounts = accounts.filter((a) => a.name.trim() && a.amount.trim() !== '')

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

  const addAccount = (kind: 'bank' | 'cash') =>
    setAccounts((prev) => [...prev, { name: '', kind, amount: '' }])

  const removeAccount = (i: number) => setAccounts((prev) => prev.filter((_, j) => j !== i))

  /**
   * Exactly one fund is the Assembly's own, kept true as the treasurer types.
   *
   * The server refuses a second, because the partition treats the single
   * non-pass-through fund as the residual and a second would never appear in it
   * at all. Steering here means the refusal is never reached: marking one as the
   * Assembly's own quietly makes the previous one held-for-others, which is what
   * someone changing their mind meant anyway.
   */
  const setFund = (key: string, patch: Partial<FundDraft>) =>
    setFunds((prev) =>
      prev.map((f) => {
        if (f.key === key) return { ...f, ...patch }
        if (patch.isPassthrough === false) return { ...f, isPassthrough: true }
        return f
      }),
    )

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

  /** What stops this step being finished, or null. */
  const blocker = (which: number): string | null => {
    if (which === 1) {
      if (!assemblyName.trim()) return 'The Assembly needs a name.'
      if (!/^\d{4}-\d{2}-\d{2}$/.test(openedOn)) return 'Pick the day the books open.'
      return null
    }
    if (which === 2) {
      for (const account of accounts) {
        if (account.amount.trim() !== '' && parseMoney(account.amount) === null) {
          return `"${account.amount}" is not an amount. Write it as 4312.18`
        }
      }
      if (usableAccounts.length === 0) {
        return 'Add at least one account with a name and a balance — the bank, the cash box, or both.'
      }
      return null
    }
    if (which === 3) {
      if (chosen.length === 0) return 'Choose at least one fund.'
      if (!ownFund) {
        return 'One fund has to be the Assembly’s own — the money it may actually spend.'
      }
      if (chosen.some((f) => !f.label.trim())) return 'Every fund you keep needs a name.'
      return null
    }
    if (which === 4) {
      for (const fund of chosen) {
        if (fund.declared.trim() !== '' && parseMoney(fund.declared) === null) {
          return `"${fund.declared}" is not an amount. Write it as 250.00`
        }
      }
      if (ownFund && ownFund.declared.trim() === '') {
        return (
          `Say what the ${ownFund.label} held, even if it is nothing. It is the one fund ` +
          'worked out by subtraction, so leaving it blank would report the whole balance ' +
          'as unaccounted for.'
        )
      }
      return null
    }
    return null
  }

  const submit = useCallback(async () => {
    setProblem(null)
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
        accounts: usableAccounts.map((a) => ({
          name: a.name.trim(),
          kind: a.kind,
          openingBalanceCents: parseMoney(a.amount) ?? 0,
        })),
        categories: status.suggestedCategories
          .filter((c) => categories.has(c.label))
          .map((c) => ({ label: c.label, kind: c.kind })),
        declared: Object.fromEntries(chosen.map((f) => [f.key, parseMoney(f.declared) ?? 0])),
        declaredBy: declaredBy.trim(),
        letterheadDataUrl: letterhead?.dataUrl ?? null,
        letterheadFilename: letterhead?.filename ?? null,
      })
      onOpened()
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }, [
    assemblyName, categories, chosen, declaredBy, letterhead, onOpened, openedOn,
    shortName, status.suggestedCategories, usableAccounts,
  ])

  const stuck = blocker(step)

  return (
    <main className="bd-page">
      <div className="bd-pagehead">
        <div>
          <p className="bd-eyebrow">
            Getting started · step {step + 1} of {STEPS.length}
          </p>
          <h1 className="bd-headline">{STEPS[step]}</h1>
        </div>
      </div>

      <ol className="bd-wizard" aria-label="Setup steps">
        {STEPS.map((label, i) => (
          <li
            key={label}
            className={
              i === step
                ? 'bd-wizard__step bd-wizard__step--current'
                : i < step
                  ? 'bd-wizard__step bd-wizard__step--done'
                  : 'bd-wizard__step'
            }
            aria-current={i === step ? 'step' : undefined}
          >
            {/* Backwards only. Skipping ahead past a step that is not finished
                would land the treasurer somewhere that cannot be completed. */}
            <button
              type="button"
              className="bd-wizard__link"
              disabled={i > step}
              aria-label={`Step ${i + 1}: ${label}`}
              onClick={() => setStep(i)}
            >
              {label}
            </button>
          </li>
        ))}
      </ol>

      {step === 0 && <Welcome />}

      {step === 1 && (
        <section className="bd-card bd-card--wide">
          <div className="bd-card__head">
            <h2 className="bd-card__title">Your Assembly</h2>
            <p className="bd-card__hint">
              The opening date is a wall: nothing before it is part of these books. Pick the
              date the balances you are about to enter are true as of — usually the last
              statement, or the day you took over. If last year's journal turns up later, the
              wall can be moved back.
            </p>
          </div>

          <div className="bd-formrow">
            <label className="bd-field">
              <span className="bd-field__label">Name</span>
              <input
                className="bd-input"
                value={assemblyName}
                onChange={(e) => setAssemblyName(e.target.value)}
                placeholder="Local Spiritual Assembly of Riverbend"
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
              />
            </label>
          </div>

          <p className="bd-note">
            The short name is what appears in the corner of every screen. Both can be changed
            later in Settings.
          </p>
        </section>
      )}

      {step === 2 && (
        <section className="bd-card bd-card--wide">
          <div className="bd-card__head">
            <h2 className="bd-card__title">Where the money is</h2>
            <p className="bd-card__hint">
              What the statement says, and what is actually in the tin, on {openedOn}. Add as
              many of each as the Assembly keeps — a second bank account for a building fund,
              a second cash box, or no cash at all.
            </p>
          </div>

          {accounts.map((account, i) => (
            <div className="bd-formrow" key={i}>
              <label className="bd-field">
                <span className="bd-field__label">
                  {account.kind === 'bank' ? 'Bank account' : 'Cash journal'}
                </span>
                <input
                  className="bd-input"
                  value={account.name}
                  onChange={(e) => setAccount(i, { name: e.target.value })}
                  placeholder={account.kind === 'bank' ? 'Community Credit Union' : 'Cash box'}
                />
              </label>
              <label className="bd-field">
                <span className="bd-field__label">Balance on {openedOn}</span>
                <input
                  className="bd-input bd-input--money"
                  inputMode="decimal"
                  value={account.amount}
                  onChange={(e) => setAccount(i, { amount: e.target.value })}
                  placeholder="0.00"
                />
              </label>
              <div className="bd-field">
                <span className="bd-field__label">&nbsp;</span>
                <button
                  type="button"
                  className="bd-btn bd-btn--ghost"
                  onClick={() => removeAccount(i)}
                  disabled={accounts.length === 1}
                  aria-label={`Remove ${account.name || 'this account'}`}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}

          <div className="bd-actions">
            <button
              type="button"
              className="bd-btn bd-btn--ghost"
              onClick={() => addAccount('bank')}
            >
              Add a bank account
            </button>
            <button
              type="button"
              className="bd-btn bd-btn--ghost"
              onClick={() => addAccount('cash')}
            >
              Add a cash journal
            </button>
          </div>

          <p className="bd-note">On hand at opening: {formatMoney(onHandCents)}</p>
        </section>
      )}

      {step === 3 && (
        <section className="bd-card bd-card--wide">
          <div className="bd-card__head">
            <h2 className="bd-card__title">Which funds this Assembly keeps</h2>
            <p className="bd-card__hint">
              Nothing is ticked in advance. One fund has to be the Assembly's own — the money
              it may actually spend. Every other fund is received locally and owed upward, and
              Bedrock will not let it be spent.
            </p>
          </div>

          <table className="bd-table">
            <thead>
              <tr>
                <th>Keep</th>
                <th>Fund</th>
                <th>Whose money</th>
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
      )}

      {step === 4 && (
        <>
          <section className="bd-card bd-card--wide">
            <div className="bd-card__head">
              <h2 className="bd-card__title">What each fund held on {openedOn}</h2>
              <p className="bd-card__hint">
                From the page your predecessor left, or the last Feast report. If you do not
                know a figure, put what you believe and read the panel below — being out is
                normal, and it is handled rather than hidden.
              </p>
            </div>

            <div className="bd-formrow">
              {chosen.map((fund) => (
                <label className="bd-field" key={fund.key}>
                  <span className="bd-field__label">
                    {fund.label}
                    {!fund.isPassthrough && ' (the Assembly’s own)'}
                  </span>
                  <input
                    className="bd-input bd-input--money"
                    inputMode="decimal"
                    value={fund.declared}
                    placeholder="0.00"
                    onChange={(e) => setFund(fund.key, { declared: e.target.value })}
                  />
                </label>
              ))}
            </div>
          </section>

          <OpeningDifference
            onHandCents={onHandCents}
            declaredCents={declaredCents}
            gapCents={gapCents}
            declaredBy={declaredBy}
            onDeclaredBy={setDeclaredBy}
          />
        </>
      )}

      {step === 5 && (
        <>
          <section className="bd-card bd-card--wide">
            <div className="bd-card__head">
              <h2 className="bd-card__title">Expense categories</h2>
              <p className="bd-card__hint">
                Optional, and easy to change later. These are what the budget and the Feast
                report group spending by — tick the ones that sound like your Assembly.
              </p>
            </div>

            <div className="bd-fundlist">
              {status.suggestedCategories.map((category) => (
                <label className="bd-check" key={category.label}>
                  <input
                    type="checkbox"
                    checked={categories.has(category.label)}
                    onChange={(e) =>
                      setCategories((prev) => {
                        const next = new Set(prev)
                        if (e.target.checked) next.add(category.label)
                        else next.delete(category.label)
                        return next
                      })
                    }
                  />
                  <span>{category.label}</span>
                </label>
              ))}
            </div>

            <div className="bd-actions">
              <button
                type="button"
                className="bd-btn bd-btn--ghost"
                onClick={() =>
                  setCategories(
                    categories.size === status.suggestedCategories.length
                      ? new Set()
                      : new Set(status.suggestedCategories.map((c) => c.label)),
                  )
                }
              >
                {categories.size === status.suggestedCategories.length
                  ? 'Tick none'
                  : 'Tick them all'}
              </button>
            </div>
          </section>

          <LetterheadField
            value={letterhead}
            maxBytes={status.letterheadMaxBytes}
            onChange={setLetterhead}
          />
        </>
      )}

      {step === 6 && (
        <Review
          assemblyName={assemblyName}
          openedOn={openedOn}
          accounts={usableAccounts}
          funds={chosen}
          categoryCount={categories.size}
          hasLetterhead={letterhead !== null}
          onHandCents={onHandCents}
          gapCents={gapCents}
        />
      )}

      {stuck && step > 0 && <p className="bd-warn">{stuck}</p>}
      {problem && <p className="bd-warn">{problem}</p>}

      <div className="bd-actions">
        {step > 0 && (
          <button
            type="button"
            className="bd-btn bd-btn--ghost"
            onClick={() => setStep(step - 1)}
          >
            Back
          </button>
        )}
        {step < STEPS.length - 1 ? (
          <button
            type="button"
            className="bd-btn bd-btn--primary"
            disabled={stuck !== null}
            onClick={() => setStep(step + 1)}
          >
            {step === 0 ? 'Start' : 'Next'}
          </button>
        ) : (
          <button
            type="button"
            className="bd-btn bd-btn--primary"
            disabled={saving}
            onClick={() => void submit()}
          >
            {saving ? 'Opening the books…' : 'Open the books'}
          </button>
        )}
      </div>
    </main>
  )
}

/** What the treasurer should have to hand before they begin. */
function Welcome() {
  return (
    <section className="bd-card bd-card--wide">
      <div className="bd-card__head">
        <h2 className="bd-card__title">This takes about five minutes</h2>
        <p className="bd-card__hint">
          Bedrock keeps a Local Spiritual Assembly's accounts on the Bahá'í calendar: the
          nineteen months, a report for each Feast, and books a successor can be handed. It
          needs to know where you are starting from.
        </p>
      </div>

      <ol className="bd-steps">
        <li className="bd-step">
          <span className="bd-step__number">1</span>
          <span className="bd-step__title">
            Your most recent bank statement
            <span className="bd-step__detail">
              The closing balance, and the date it is true as of. That date becomes the day
              your books open.
            </span>
          </span>
        </li>
        <li className="bd-step">
          <span className="bd-step__number">2</span>
          <span className="bd-step__title">
            A count of any cash on hand
            <span className="bd-step__detail">
              What is in the tin. If the Assembly holds no cash, skip it.
            </span>
          </span>
        </li>
        <li className="bd-step">
          <span className="bd-step__number">3</span>
          <span className="bd-step__title">
            Whatever the last treasurer left you
            <span className="bd-step__detail">
              A note, a spreadsheet, or the last Feast report — anything saying how much
              belongs to the Local Fund and how much is being held for the National or
              Continental Funds. If you have nothing, say what you believe; the screens ahead
              are built for not knowing.
            </span>
          </span>
        </li>
      </ol>

      <p className="bd-note">
        Nothing is saved until the last step, so you can move back and forth freely. Every
        answer can be changed afterwards in Settings — except the figures themselves, which
        are corrected by recording a correction rather than by editing, so the books always
        show what changed and when.
      </p>
    </section>
  )
}

/** The last look before anything is written. */
function Review({
  assemblyName,
  openedOn,
  accounts,
  funds,
  categoryCount,
  hasLetterhead,
  onHandCents,
  gapCents,
}: {
  assemblyName: string
  openedOn: string
  accounts: AccountDraft[]
  funds: FundDraft[]
  categoryCount: number
  hasLetterhead: boolean
  onHandCents: number
  gapCents: number
}) {
  return (
    <section className="bd-card bd-card--wide">
      <div className="bd-card__head">
        <h2 className="bd-card__title">{assemblyName}</h2>
        <p className="bd-card__hint">
          Opening on {openedOn} with {formatMoney(onHandCents)} on hand. Nothing has been
          written yet — go back and change anything that is not right.
        </p>
      </div>

      <table className="bd-table">
        <tbody>
          {accounts.map((a, i) => (
            <tr key={`${a.name}-${i}`}>
              <td>{a.name}</td>
              <td className="bd-table__meta">
                {a.kind === 'bank' ? 'bank account' : 'cash journal'}
              </td>
              <td className="bd-table__num">{formatMoney(parseMoney(a.amount) ?? 0)}</td>
            </tr>
          ))}
          {funds.map((f) => (
            <tr key={f.key}>
              <td>{f.label}</td>
              <td className="bd-table__meta">
                {f.isPassthrough ? 'held and forwarded upward' : "the Assembly's own"}
              </td>
              <td className="bd-table__num">{formatMoney(parseMoney(f.declared) ?? 0)}</td>
            </tr>
          ))}
          {gapCents !== 0 && (
            <tr>
              <td>Unaccounted for</td>
              <td className="bd-table__meta">carried under its own name until explained</td>
              <td className="bd-table__num">{formatMoney(gapCents)}</td>
            </tr>
          )}
        </tbody>
      </table>

      <p className="bd-note">
        {categoryCount} expense {categoryCount === 1 ? 'category' : 'categories'} ·{' '}
        {hasLetterhead ? 'a letterhead is loaded' : 'no letterhead yet'}. After this you land
        on the year dashboard, where the first thing to do is import a bank statement under
        Ledger.
      </p>
    </section>
  )
}

/**
 * The Assembly's letterhead, for the top of a receipt.
 *
 * Optional here and changeable later from Settings — a treasurer opening the
 * books on a Sunday afternoon should not be stopped by not having the logo to
 * hand. Read in the browser and sent as a data URL: the server checks the type
 * and the size again on arrival, because a limit enforced only by the page that
 * happens to be open is not a limit.
 */
export function LetterheadField({
  value,
  maxBytes,
  onChange,
}: {
  value: { dataUrl: string; filename: string } | null
  maxBytes: number
  onChange: (value: { dataUrl: string; filename: string } | null) => void
}) {
  const [problem, setProblem] = useState<string | null>(null)

  const read = (file: File) => {
    setProblem(null)
    if (file.size > maxBytes) {
      setProblem(
        `That image is ${Math.round(file.size / 1024)}kB and the limit is ` +
          `${Math.round(maxBytes / 1024)}kB. It is stored in the database and carried ` +
          'inside every backup, so scale it down first.',
      )
      return
    }
    const reader = new FileReader()
    reader.onload = () => onChange({ dataUrl: String(reader.result), filename: file.name })
    reader.onerror = () => setProblem('That file could not be read.')
    reader.readAsDataURL(file)
  }

  return (
    <section className="bd-card bd-card--wide">
      <div className="bd-card__head">
        <h2 className="bd-card__title">Letterhead</h2>
        <p className="bd-card__hint">
          Printed at the top of every receipt, so what a contributor is handed looks like it
          came from the Assembly. Optional, and changeable later in Settings. Up to{' '}
          {Math.round(maxBytes / 1024)}kB — a logo, not a photograph.
        </p>
      </div>

      {value ? (
        <>
          <img
            src={value.dataUrl}
            alt="The Assembly's letterhead"
            style={{ maxWidth: '320px', maxHeight: '120px' }}
          />
          <p className="bd-note">{value.filename}</p>
          <div className="bd-actions">
            <button type="button" className="bd-btn bd-btn--ghost" onClick={() => onChange(null)}>
              Remove it
            </button>
          </div>
        </>
      ) : (
        <label className="bd-field">
          <span className="bd-field__label">Choose an image</span>
          <input
            type="file"
            className="bd-input"
            accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) read(file)
            }}
          />
        </label>
      )}

      {problem && <p className="bd-warn">{problem}</p>}
    </section>
  )
}

/**
 * The difference, said out loud.
 *
 * The part of setup the whole feature exists for. It is not a validation error
 * and it blocks nothing — it is a figure being named, so that it stays named.
 * The alternative is what happens by default: the Local Fund is the residual of
 * the partition, so an unexplained difference silently becomes part of what the
 * Assembly believes it can spend.
 */
function OpeningDifference({
  onHandCents,
  declaredCents,
  gapCents,
  declaredBy,
  onDeclaredBy,
}: {
  onHandCents: number
  declaredCents: number
  gapCents: number
  declaredBy: string
  onDeclaredBy: (value: string) => void
}) {
  return (
    <section className="bd-card bd-card--wide">
      <div className="bd-card__head">
        <h2 className="bd-card__title">Does it agree?</h2>
        <p className="bd-card__hint">
          What is on hand, against what the funds claim. These often do not match on the day a
          treasurer takes over, and that is not a reason to stop.
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

      {gapCents === 0 ? (
        <p className="bd-note">
          The statement and the funds agree. That is the happy case and not the common one —
          nothing will be carried forward as unexplained.
        </p>
      ) : gapCents > 0 ? (
        <p className="bd-note">
          {formatMoney(gapCents)} is on hand that no fund claims. Bedrock will carry it as its
          own line, under its own name, until the Assembly decides what it is — a deposit
          nobody recorded is the usual answer. It will <strong>not</strong> be added to the
          Local Fund, because money the Assembly cannot explain is not money it should be told
          it can spend.
        </p>
      ) : (
        <p className="bd-warn">
          The funds claim {formatMoney(-gapCents)} more than the Assembly actually holds. That
          is the more serious direction: it usually means money earmarked for another
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
