import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { formatMoney, formatSigned, parseMoney } from '../lib/money'
import {
  fetchChoices,
  fetchOpeningPosition,
  restateOpening,
  type Choices,
  type OpeningView,
} from '../data/api'
import Loading from '../components/Loading'
import ErrorPanel from '../components/ErrorPanel'

/**
 * The opening position, after the books have been opened.
 *
 * Two things live here. The first is a record: what was declared on the day
 * the books opened, every decision taken about it since, and who took them.
 * None of it can be edited — the whole point of an opening position is that
 * every later figure is measured from it.
 *
 * The second is the one act that changes it. The previous year's cash journal
 * turns up in a drawer, and the Assembly wants that history in the books. The
 * date is a wall — nothing before it counts — so the wall has to move first,
 * and moving it means restating what was held on the new earlier date.
 *
 * What makes that safe rather than merely possible is the checkpoint. The
 * figure the books used to open with does not disappear; it becomes a claim
 * about a date that the newly imported history has to reproduce. If it does
 * not, this screen says by how much, and the audit package says so too.
 */
export default function OpeningPage() {
  const [view, setView] = useState<OpeningView | null>(null)
  const [choices, setChoices] = useState<Choices | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const [opening, options] = await Promise.all([fetchOpeningPosition(), fetchChoices()])
      setView(opening)
      setChoices(options)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  if (error) return <ErrorPanel message={error} />
  if (!view || !choices) return <Loading label="Reading the opening position" />

  return (
    <main className="bd-page">
      <div className="bd-pagehead">
        <div>
          <p className="bd-eyebrow">The opening position</p>
          <h1 className="bd-headline">
            {view.openedOn
              ? `These books open on ${view.openedOn}`
              : 'These books record no opening date'}
          </h1>
        </div>
        <div className="bd-actions">
          <Link className="bd-btn bd-btn--ghost" to="/">
            Back to the year
          </Link>
        </div>
      </div>

      {!view.openedOn && (
        <p className="bd-note">
          They predate the setup process, so there is no wall to move and nothing to restate.
          Everything below is empty for that reason rather than because nothing happened.
        </p>
      )}

      <Checkpoints view={view} />

      <section className="bd-card bd-card--wide">
        <div className="bd-card__head">
          <h2 className="bd-card__title">What each fund was said to hold</h2>
          <p className="bd-card__hint">
            The Assembly's own fund has no figure here on purpose: it is whatever is left
            once the funds held for others, the cash box and anything unaccounted for are
            set aside. Giving it a stored figure as well would count the same money twice.
          </p>
        </div>

        <table className="bd-table">
          <thead>
            <tr>
              <th>Fund</th>
              <th>Whose money</th>
              <th className="bd-table__num">Held at opening</th>
            </tr>
          </thead>
          <tbody>
            {view.funds.map((fund) => (
              <tr key={fund.fundId} className={fund.isPassthrough ? undefined : 'bd-tr--muted'}>
                <td>{fund.label}</td>
                <td className="bd-table__meta">
                  {fund.isPassthrough ? 'held and forwarded upward' : "the Assembly's own"}
                </td>
                <td className="bd-table__num">
                  {fund.isPassthrough ? formatMoney(fund.openingCents) : '—'}
                </td>
              </tr>
            ))}
            {view.unexplainedCents !== 0 && (
              <tr>
                <td>Unaccounted for</td>
                <td className="bd-table__meta">no fund claims it</td>
                <td className="bd-table__num">{formatMoney(view.unexplainedCents)}</td>
              </tr>
            )}
          </tbody>
        </table>

        {view.unexplainedCents !== 0 && (
          <p className="bd-note">
            <Link to="/funds">Account for it on the Funds screen</Link>, where the decision
            is recorded with its reason.
          </p>
        )}
      </section>

      <History view={view} />

      {view.openedOn && <RestateForm view={view} choices={choices} onRestated={reload} />}
    </main>
  )
}

/**
 * What the books used to say, against what they say now.
 *
 * Only ever shown when the opening date has moved, which for most Assemblies
 * is never. A checkpoint that holds is worth showing too — it is the evidence
 * that the history loaded behind the wall is complete, and an auditor asking
 * "how do you know nothing was lost when you did that?" has an answer here.
 */
function Checkpoints({ view }: { view: OpeningView }) {
  if (view.checkpoints.length === 0) return null

  return (
    <section className="bd-card bd-card--wide">
      <div className="bd-card__head">
        <h2 className="bd-card__title">Figures these books have already been proved against</h2>
        <p className="bd-card__hint">
          Each was the opening balance before the date was moved backwards. The history
          loaded since has to add up to it. A difference is the size of what is missing or
          counted twice — not a figure to adjust.
        </p>
      </div>

      <ul className="bd-checks">
        {view.checkpoints.map((c) => (
          <li key={c.id} className={c.holds ? 'bd-check' : 'bd-check bd-check--failed'}>
            <span className="bd-check__mark" aria-hidden="true">
              {c.holds ? '✓' : '!'}
            </span>
            <span className="bd-check__label">
              {formatMoney(c.expectedCents)} on {c.asOf}
              <span className="bd-check__detail">
                {c.reason}
                {c.decidedBy ? ` · ${c.decidedBy}` : ''} · the date moved back to {c.movedTo}
              </span>
            </span>
            <span className="bd-check__verdict">
              {c.holds
                ? 'the books reproduce it'
                : `out by ${formatSigned(c.differenceCents)}`}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Every declaration and decision, oldest first. Nothing here can be edited. */
function History({ view }: { view: OpeningView }) {
  if (view.entries.length === 0) {
    return (
      <p className="bd-note">
        Nothing was declared at opening — the books opened with every fund at nil.
      </p>
    )
  }

  return (
    <section className="bd-card bd-card--wide">
      <div className="bd-card__head">
        <h2 className="bd-card__title">Everything decided about the opening</h2>
        <p className="bd-card__hint">
          Append-only. A figure that turned out to be wrong is corrected by a further line
          saying so, never by changing the original, because every report already presented
          was computed against what it used to say.
        </p>
      </div>

      <table className="bd-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>What</th>
            <th>Whose</th>
            <th className="bd-table__num">Amount</th>
            <th>Why, and who decided</th>
          </tr>
        </thead>
        <tbody>
          {view.entries.map((entry) => (
            <tr key={entry.id}>
              <td className="bd-table__date">{entry.occurredOn}</td>
              <td>{KINDS[entry.kind]}</td>
              <td>{entry.fundLabel ?? 'Unaccounted for'}</td>
              <td className="bd-table__num">{formatSigned(entry.amountCents)}</td>
              <td className="bd-table__meta">
                {entry.reason ?? '—'}
                {entry.decidedBy && <span className="bd-memo">{entry.decidedBy}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

const KINDS: Record<string, string> = {
  declared: 'Declared at opening',
  resolved: 'Accounted for',
  restated: 'Restated',
}

/**
 * Moving the wall backwards.
 *
 * Deliberately not a casual control. It restates the figure every later
 * balance in the books is built from, so it asks for the same things a
 * resolution asks for — a reason and a name — and it explains what happens
 * next, because on its own it makes the books look wrong: the balances jump to
 * the earlier date and only come back once the history is imported.
 */
function RestateForm({
  view,
  choices,
  onRestated,
}: {
  view: OpeningView
  choices: Choices
  onRestated: () => void
}) {
  const [openedOn, setOpenedOn] = useState('')
  const [balances, setBalances] = useState<Record<string, string>>({})
  // Every fund, not just the ones with a stored figure. The Assembly's own has
  // none — it is the residual — but the remainder is derived by subtracting
  // what the funds claim from what is on hand, so omitting it would declare
  // the Assembly's entire balance unaccounted for.
  const [declared, setDeclared] = useState<Record<string, string>>(
    Object.fromEntries(
      view.funds.map((f) => [
        f.key,
        f.isPassthrough ? (f.openingCents / 100).toFixed(2) : '',
      ]),
    ),
  )
  const [reason, setReason] = useState('')
  const [decidedBy, setDecidedBy] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setProblem(null)

    const accounts: Record<string, number> = {}
    for (const account of choices.accounts) {
      const raw = balances[account.id]
      if (raw === undefined || raw.trim() === '') continue
      const cents = parseMoney(raw)
      if (cents === null) {
        setProblem(`"${raw}" is not an amount. Write it as 4312.18`)
        return
      }
      accounts[account.id] = cents
    }
    if (Object.keys(accounts).length === 0) {
      setProblem('Say what at least one account held on the earlier date.')
      return
    }

    const funds: Record<string, number> = {}
    for (const [key, raw] of Object.entries(declared)) {
      const cents = raw.trim() === '' ? 0 : parseMoney(raw)
      if (cents === null) {
        setProblem(`"${raw}" is not an amount. Write it as 250.00`)
        return
      }
      funds[key] = cents
    }

    setSaving(true)
    try {
      await restateOpening({
        openedOn,
        accounts,
        declared: funds,
        reason: reason.trim(),
        decidedBy: decidedBy.trim(),
      })
      setOpen(false)
      setReason('')
      onRestated()
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="bd-card bd-card--wide">
      <div className="bd-card__head">
        <h2 className="bd-card__title">Take on history from before {view.openedOn}</h2>
        <p className="bd-card__hint">
          The opening date is a wall: nothing before it is part of these books, and the
          importer refuses rows dated earlier because the opening balance already accounts
          for them. If the previous year's journal has turned up, move the wall back and say
          what was held then — the figure the books open with today is kept, and the history
          you import has to add up to it.
        </p>
      </div>

      {!open ? (
        <div className="bd-actions">
          <button type="button" className="bd-btn bd-btn--ghost" onClick={() => setOpen(true)}>
            Move the opening date back
          </button>
        </div>
      ) : (
        <form onSubmit={submit}>
          <div className="bd-formrow">
            <label className="bd-field">
              <span className="bd-field__label">The books should open on</span>
              <input
                type="date"
                className="bd-input"
                value={openedOn}
                max={view.openedOn ?? undefined}
                onChange={(e) => setOpenedOn(e.target.value)}
                required
              />
            </label>
          </div>

          <p className="bd-card__hint">
            What each account held immediately before that day — before the first entry on
            it, the same way the current figures were read.
          </p>
          <div className="bd-formrow">
            {choices.accounts.map((account) => (
              <label className="bd-field" key={account.id}>
                <span className="bd-field__label">{account.name}</span>
                <input
                  className="bd-input bd-input--money"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={balances[account.id] ?? ''}
                  onChange={(e) =>
                    setBalances((prev) => ({ ...prev, [account.id]: e.target.value }))
                  }
                />
              </label>
            ))}
          </div>

          <p className="bd-card__hint">
            And what each fund held on that day — including the Assembly's own. That one is
            never stored, because it is whatever is left over, but it is subtracted from
            what was on hand to work out anything unaccounted for. Leaving it blank would
            declare the whole balance unexplained.
          </p>
          <div className="bd-formrow">
            {view.funds.map((fund) => (
              <label className="bd-field" key={fund.fundId}>
                <span className="bd-field__label">
                  {fund.label}
                  {!fund.isPassthrough && ' (the Assembly’s own)'}
                </span>
                <input
                  className="bd-input bd-input--money"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={declared[fund.key] ?? ''}
                  onChange={(e) =>
                    setDeclared((prev) => ({ ...prev, [fund.key]: e.target.value }))
                  }
                />
              </label>
            ))}
          </div>

          <div className="bd-formrow">
            <label className="bd-field">
              <span className="bd-field__label">Who decided</span>
              <input
                className="bd-input"
                value={decidedBy}
                placeholder="The Assembly, minuted 3 ʿIzzat"
                onChange={(e) => setDecidedBy(e.target.value)}
                required
              />
            </label>
          </div>
          <label className="bd-field">
            <span className="bd-field__label">Why</span>
            <input
              className="bd-input"
              value={reason}
              placeholder="Last year's cash journal was found in the safe"
              onChange={(e) => setReason(e.target.value)}
              required
            />
          </label>

          <p className="bd-note">
            Straight after this the books will look wrong: the balances become what they
            were on the earlier date, and only come back to today's figures once the
            history between the two dates is imported. That is expected, and the checkpoint
            above is how you will know when it has come back exactly.
          </p>

          {problem && <p className="bd-warn">{problem}</p>}

          <div className="bd-actions">
            <button type="submit" className="bd-btn bd-btn--primary" disabled={saving}>
              {saving ? 'Restating…' : 'Move the date and restate'}
            </button>
            <button type="button" className="bd-btn bd-btn--ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  )
}
