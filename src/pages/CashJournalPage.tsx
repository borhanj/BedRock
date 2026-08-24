import { useCallback, useEffect, useState } from 'react'
import { formatMoney, formatSigned, parseMoney } from '../lib/money'
import {
  createTransaction,
  fetchCashJournal,
  fetchChoices,
  type CashJournal,
  type Choices,
} from '../data/api'
import Loading from '../components/Loading'
import ErrorPanel from '../components/ErrorPanel'

/**
 * Cash in and out, with a running balance.
 *
 * Oldest first, unlike the ledger: the point of this page is to follow the
 * balance down to a figure the treasurer can count against what is actually in
 * the tin.
 */
export default function CashJournalPage() {
  const [journal, setJournal] = useState<CashJournal | null>(null)
  const [choices, setChoices] = useState<Choices | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [j, c] = await Promise.all([fetchCashJournal('current'), fetchChoices()])
      setJournal(j)
      setChoices(c)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (error) return <ErrorPanel message={error} />
  if (!journal || !choices) return <Loading label="Counting the cash" />

  const cashAccount = choices.accounts.find((a) => a.kind === 'cash')

  return (
    <>
      <div className="bd-pagehead">
        <div>
          <p className="bd-eyebrow">Cash journal</p>
          <h1 className="bd-headline">
            {formatMoney(journal.closingCents)} should be in the tin
          </h1>
        </div>
        <div className="bd-stats">
          <div className="bd-stat">
            <div className="bd-stat__label">Opened the year with</div>
            <div className="bd-stat__value">{formatMoney(journal.openingCents)}</div>
          </div>
          <div className="bd-stat bd-stat--inverse">
            <div className="bd-stat__label">On hand now</div>
            <div className="bd-stat__value">{formatMoney(journal.closingCents)}</div>
          </div>
        </div>
      </div>

      {cashAccount && (
        <CashEntryForm account={cashAccount.id} choices={choices} onAdded={load} />
      )}

      {journal.entries.length === 0 ? (
        <div className="bd-placeholder">
          <p className="bd-placeholder__body">No cash has moved this year.</p>
        </div>
      ) : (
        <table className="bd-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Payee</th>
              <th className="bd-table__num">In / out</th>
              <th className="bd-table__num">Balance</th>
              <th>Category</th>
            </tr>
          </thead>
          <tbody>
            {journal.entries.map((entry) => (
              <tr key={entry.id}>
                <td className="bd-table__date">{entry.occurredOn}</td>
                <td>
                  <span className="bd-payee">{entry.payee ?? '—'}</span>
                  {entry.memo && <span className="bd-memo">{entry.memo}</span>}
                </td>
                <td
                  className={`bd-table__num ${
                    entry.amountCents > 0 ? 'bd-amount--in' : 'bd-amount--out'
                  }`}
                >
                  {formatSigned(entry.amountCents)}
                </td>
                <td className="bd-table__num bd-running">
                  {formatMoney(entry.balanceCents)}
                </td>
                <td className="bd-table__meta">{entry.categoryLabel ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

function CashEntryForm({
  account,
  choices,
  onAdded,
}: {
  account: string
  choices: Choices
  onAdded: () => void
}) {
  const [direction, setDirection] = useState<'in' | 'out'>('in')
  const [occurredOn, setOccurredOn] = useState('')
  const [payee, setPayee] = useState('')
  const [amount, setAmount] = useState('')
  const [fundId, setFundId] = useState(choices.funds[0]?.id ?? '')
  const [categoryId, setCategoryId] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const relevant = choices.categories.filter((c) =>
    direction === 'in' ? c.kind === 'income' : c.kind === 'expense',
  )

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setProblem(null)

    // Parsed once, at the edge. Everything downstream is integer cents.
    const cents = parseMoney(amount)
    if (cents === null || cents === 0) {
      setProblem('Enter an amount, for example 25.00')
      return
    }
    if (!occurredOn) {
      setProblem('Enter the date the cash changed hands')
      return
    }

    setSaving(true)
    try {
      await createTransaction({
        accountId: account,
        occurredOn,
        amountCents: direction === 'in' ? Math.abs(cents) : -Math.abs(cents),
        payee: payee || (direction === 'in' ? 'Cash received' : 'Cash paid out'),
        memo: null,
        method: 'cash',
        kind: direction === 'in' ? 'contribution' : 'expense',
        categoryId: categoryId || null,
        fundId: direction === 'in' ? fundId || null : null,
      })
      setPayee('')
      setAmount('')
      onAdded()
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="bd-card bd-card--wide">
      <div className="bd-card__head">
        <h2 className="bd-card__title">Record cash</h2>
        <p className="bd-card__hint">
          For money that never touches the bank — a gift at Feast, a small expense paid
          from the tin.
        </p>
      </div>

      <form className="bd-formrow" onSubmit={submit}>
        <label className="bd-field">
          <span className="bd-field__label">Direction</span>
          <select
            className="bd-select"
            value={direction}
            onChange={(e) => {
              setDirection(e.target.value as 'in' | 'out')
              setCategoryId('')
            }}
          >
            <option value="in">Received</option>
            <option value="out">Paid out</option>
          </select>
        </label>

        <label className="bd-field">
          <span className="bd-field__label">Date</span>
          <input
            className="bd-input"
            type="date"
            value={occurredOn}
            onChange={(e) => setOccurredOn(e.target.value)}
          />
        </label>

        <label className="bd-field">
          <span className="bd-field__label">
            {direction === 'in' ? 'From' : 'Paid to'}
          </span>
          <input
            className="bd-input"
            type="text"
            value={payee}
            placeholder={direction === 'in' ? 'Cash at Feast' : 'Hospitality'}
            onChange={(e) => setPayee(e.target.value)}
          />
        </label>

        <label className="bd-field">
          <span className="bd-field__label">Amount</span>
          <input
            className="bd-input"
            type="text"
            inputMode="decimal"
            value={amount}
            placeholder="25.00"
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>

        {direction === 'in' ? (
          <label className="bd-field">
            <span className="bd-field__label">Fund</span>
            <select
              className="bd-select"
              value={fundId}
              onChange={(e) => setFundId(e.target.value)}
            >
              {choices.funds.map((f) => (
                <option key={f.id} value={f.id}>{f.label}</option>
              ))}
            </select>
          </label>
        ) : (
          <label className="bd-field">
            <span className="bd-field__label">Category</span>
            <select
              className="bd-select"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
            >
              <option value="">Choose later…</option>
              {relevant.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
          </label>
        )}

        <button type="submit" className="bd-btn bd-btn--primary" disabled={saving}>
          Record it
        </button>
      </form>

      {problem && <p className="bd-warn">{problem}</p>}
      {direction === 'in' && (
        <p className="bd-note">
          Cash gifts are recorded without a donor name. Receipts and donor records
          arrive in Phase 5.
        </p>
      )}
    </section>
  )
}
