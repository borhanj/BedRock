import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { formatLongDate } from '../calendar/badi'
import { formatMoney, parseMoney } from '../lib/money'
import {
  fetchChoices,
  fetchFunds,
  recordRemittance,
  type Choices,
  type FundsView,
} from '../data/api'
import Loading from '../components/Loading'
import ErrorPanel from '../components/ErrorPanel'

/**
 * Forwarding upward.
 *
 * Contributions to the National and Continental Funds pass through the local
 * account on their way to the institution that owns them. This screen is the
 * record of that passage: what is still held, and what has been sent.
 *
 * Recording a remittance writes the bank withdrawal and the remittance
 * together, on the server. There is no way to say the money went without
 * saying it left the account.
 */
export default function RemittancePage() {
  const [view, setView] = useState<FundsView | null>(null)
  const [choices, setChoices] = useState<Choices | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [funds, options] = await Promise.all([fetchFunds(), fetchChoices()])
      setView(funds)
      setChoices(options)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (error) return <ErrorPanel message={error} />
  if (!view || !choices) return <Loading label="Reading what is owed upward" />

  const outstanding = view.funds.filter((f) => f.isPassthrough)

  return (
    <>
      <div className="bd-pagehead">
        <div>
          <p className="bd-eyebrow">Funds · forwarding upward</p>
          <h1 className="bd-headline">
            {view.owedUpwardCents === 0
              ? 'Everything received has been forwarded'
              : `${formatMoney(view.owedUpwardCents)} to forward`}
          </h1>
        </div>
      </div>

      <div className="bd-grid3">
        {outstanding.map((fund) => (
          <section className="bd-card" key={fund.key}>
            <h2 className="bd-card__label">{fund.label}</h2>
            <div className="bd-figure__value">{formatMoney(fund.balanceCents)}</div>
            <p className="bd-note">
              {formatMoney(fund.receivedCents)} received this year ·{' '}
              {formatMoney(fund.forwardedCents)} forwarded.{' '}
              <Link to={`/funds/${fund.key}`}>See the sub-ledger</Link>
            </p>
          </section>
        ))}
      </div>

      <ForwardForm view={view} choices={choices} onRecorded={load} />

      <section className="bd-card bd-card--wide">
        <div className="bd-card__head">
          <h2 className="bd-card__title">Forwarded this year</h2>
          <p className="bd-card__hint">
            Each line is both a withdrawal from the account and a discharge of the
            fund. The reference is what an audit will match against.
          </p>
        </div>

        {view.remittances.length === 0 ? (
          <p className="bd-note">Nothing has been forwarded in {view.bahaiYear} B.E.</p>
        ) : (
          <table className="bd-table">
            <thead>
              <tr>
                <th>Sent</th>
                <th>Fund</th>
                <th className="bd-table__num">Amount</th>
                <th>Reference</th>
              </tr>
            </thead>
            <tbody>
              {view.remittances.map((r) => (
                <tr key={r.id}>
                  <td className="bd-table__date">{r.sentOn}</td>
                  <td>{r.fundLabel}</td>
                  <td className="bd-table__num bd-amount--out">
                    {formatMoney(r.amountCents)}
                  </td>
                  <td className="bd-table__meta">{r.reference ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  )
}

function ForwardForm({
  view,
  choices,
  onRecorded,
}: {
  view: FundsView
  choices: Choices
  onRecorded: () => void
}) {
  const passthrough = view.funds.filter((f) => f.isPassthrough)
  const bank = choices.accounts.filter((a) => a.kind === 'bank')

  const [fundKey, setFundKey] = useState(passthrough[0]?.key ?? '')
  const [accountId, setAccountId] = useState(bank[0]?.id ?? choices.accounts[0]?.id ?? '')
  const [sentOn, setSentOn] = useState(todayISO())
  const [amount, setAmount] = useState('')
  const [reference, setReference] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const held = passthrough.find((f) => f.key === fundKey)?.balanceCents ?? 0

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setProblem(null)

    // Parsed once, here at the edge. Everything past this point is cents.
    const cents = parseMoney(amount)
    if (cents === null || cents <= 0) {
      setProblem('Enter the amount forwarded, for example 300.00')
      return
    }

    setSaving(true)
    try {
      await recordRemittance({
        fundKey,
        accountId,
        sentOn,
        amountCents: cents,
        reference: reference.trim() || null,
      })
      setAmount('')
      setReference('')
      onRecorded()
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  if (passthrough.length === 0) {
    return (
      <p className="bd-note">
        No fund is held for another institution, so nothing is forwarded upward.
      </p>
    )
  }

  return (
    <section className="bd-card bd-card--wide">
      <div className="bd-card__head">
        <h2 className="bd-card__title">Record a remittance</h2>
        <p className="bd-card__hint">
          {formatMoney(held)} is held for this fund. More than that cannot be sent —
          a larger figure means something was mis-recorded on the way in.
        </p>
      </div>

      <form className="bd-formrow" onSubmit={submit}>
        <label className="bd-field">
          <span className="bd-field__label">Fund</span>
          <select
            className="bd-select"
            value={fundKey}
            onChange={(e) => setFundKey(e.target.value)}
          >
            {passthrough.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label} — {formatMoney(f.balanceCents)} held
              </option>
            ))}
          </select>
        </label>

        <label className="bd-field">
          <span className="bd-field__label">Sent from</span>
          <select
            className="bd-select"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
          >
            {choices.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>

        <label className="bd-field">
          <span className="bd-field__label">Date sent</span>
          <input
            className="bd-input"
            type="date"
            value={sentOn}
            onChange={(e) => setSentOn(e.target.value)}
          />
        </label>

        <label className="bd-field">
          <span className="bd-field__label">Amount</span>
          <input
            className="bd-input"
            inputMode="decimal"
            placeholder="300.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>

        <label className="bd-field">
          <span className="bd-field__label">Reference</span>
          <input
            className="bd-input"
            placeholder="NF-2026-0912"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </label>

        <button type="submit" className="bd-btn bd-btn--primary" disabled={saving}>
          {saving ? 'Recording…' : 'Record it'}
        </button>
      </form>

      {problem && <p className="bd-warn">{problem}</p>}

      <p className="bd-note">
        Dated {formatLongDate(sentOn)}. The withdrawal and the discharge are written
        together, so the account balance and the fund balance move at the same moment.
      </p>
    </section>
  )
}

/** The date input wants a local yyyy-mm-dd, not a UTC one. */
function todayISO(): string {
  const now = new Date()
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 10)
}
