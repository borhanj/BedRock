import { useCallback, useEffect, useState } from 'react'
import { formatMoney } from '../lib/money'
import {
  fetchAccessLog,
  fetchReceipts,
  fetchVaultStatus,
  issueReceipt,
  listDonors,
  setupVault,
  unlockVault,
  voidReceipt,
  type AccessLogEntry,
  type DonorView,
  type ReceiptBook,
  type UnreceiptedGift,
  type VaultStatus,
} from '../data/api'
import { useVault } from '../data/vault'
import Loading from '../components/Loading'
import ErrorPanel from '../components/ErrorPanel'

/**
 * Receipts, and the donor vault behind them.
 *
 * The log — numbers, dates, amounts, funds — is visible without the PIN,
 * because that is what reconciling and auditing need. Names are not, and
 * asking for them is recorded.
 */
export default function ReceiptsPage() {
  const vault = useVault()
  const [book, setBook] = useState<ReceiptBook | null>(null)
  const [status, setStatus] = useState<VaultStatus | null>(null)
  const [donors, setDonors] = useState<DonorView[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [b, s] = await Promise.all([fetchReceipts(), fetchVaultStatus()])
      setBook(b)
      setStatus(s)
      if (vault.pin) {
        setDonors(await listDonors(vault.pin, 'viewed the receipt book'))
      } else {
        setDonors(null)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [vault.pin])

  useEffect(() => {
    void load()
  }, [load])

  if (error) return <ErrorPanel message={error} />
  if (!book || !status) return <Loading label="Opening the receipt book" />

  const nameFor = (donorId: string | null) => {
    if (!donorId) return null
    return donors?.find((d) => d.id === donorId)?.name ?? null
  }

  return (
    <div className="bd-page">
      <div className="bd-pagehead">
        <div>
          <p className="bd-eyebrow">Receipts</p>
          <h1 className="bd-headline">
            {book.summary.issued} issued · next number {book.summary.nextNumber}
          </h1>
        </div>
        <div className="bd-stats">
          <div className="bd-stat bd-stat--income">
            <div className="bd-stat__label">Receipted</div>
            <div className="bd-stat__value">{formatMoney(book.summary.totalCents)}</div>
          </div>
          <div className="bd-stat">
            <div className="bd-stat__label">Awaiting a receipt</div>
            <div className="bd-stat__value">{book.summary.awaiting}</div>
          </div>
        </div>
      </div>

      <VaultPanel status={status} onChanged={load} />

      {book.awaiting.length > 0 && (
        <AwaitingReceipts
          gifts={book.awaiting}
          donors={donors}
          onIssued={load}
          onError={setError}
        />
      )}

      <section className="bd-card bd-card--wide">
        <div className="bd-card__head">
          <h2 className="bd-card__title">The receipt book</h2>
          <p className="bd-card__hint">
            Numbering is gapless. A mistake is voided, never deleted — a missing number
            reads as a destroyed record.
          </p>
        </div>

        {book.receipts.length === 0 ? (
          <p className="bd-note">No receipts issued yet.</p>
        ) : (
          <table className="bd-table">
            <thead>
              <tr>
                <th>No.</th>
                <th>Issued</th>
                <th className="bd-table__num">Amount</th>
                <th>Fund</th>
                <th>Given by</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {book.receipts.map((r) => (
                <tr key={r.id} className={r.voidedAt ? 'bd-tr--muted' : undefined}>
                  <td className="bd-table__num">{r.number}</td>
                  <td className="bd-table__date">{r.issuedOn}</td>
                  <td className="bd-table__num">{formatMoney(r.amountCents)}</td>
                  <td className="bd-table__meta">
                    {r.fundLabel} · {r.method}
                  </td>
                  <td>
                    {r.anonymous ? (
                      <span className="bd-table__meta">given anonymously</span>
                    ) : r.donorId === null ? (
                      <span className="bd-table__meta">no name recorded</span>
                    ) : nameFor(r.donorId) ? (
                      <span className="bd-payee">{nameFor(r.donorId)}</span>
                    ) : (
                      <span className="bd-locked" title="Unlock the donor records to see this">
                        held privately
                      </span>
                    )}
                  </td>
                  <td className="bd-table__meta">
                    {r.voidedAt ? (
                      <span className="bd-flag">void — {r.voidReason}</span>
                    ) : (
                      <VoidButton id={r.id} onVoided={load} onError={setError} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <AccessLog />
    </div>
  )
}

function VaultPanel({
  status,
  onChanged,
}: {
  status: VaultStatus
  onChanged: () => void
}) {
  const vault = useVault()
  const [pin, setPin] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setProblem(null)
    setBusy(true)
    try {
      if (status.configured) {
        await unlockVault(pin)
      } else {
        await setupVault(pin)
      }
      vault.unlock(pin)
      setPin('')
      onChanged()
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  if (vault.unlocked) {
    return (
      <section className="bd-card bd-card--wide">
        <div className="bd-card__head">
          <h2 className="bd-card__title">Donor records are open</h2>
          <button type="button" className="bd-btn bd-btn--quiet" onClick={vault.lock}>
            Lock them again
          </button>
        </div>
        <p className="bd-note">
          Names are visible on this device until you lock them or close the tab. Every
          time they are read is recorded below.
        </p>
      </section>
    )
  }

  return (
    <section className="bd-card bd-card--wide">
      <div className="bd-card__head">
        <h2 className="bd-card__title">
          {status.configured ? 'Donor records are locked' : 'Set a PIN for donor records'}
        </h2>
        <p className="bd-card__hint">
          {status.donorCount} household{status.donorCount === 1 ? '' : 's'} on file
        </p>
      </div>

      <form className="bd-formrow" onSubmit={submit}>
        <label className="bd-field">
          <span className="bd-field__label">
            {status.configured ? 'PIN' : 'Choose a PIN or phrase'}
          </span>
          <input
            className="bd-input"
            type="password"
            autoComplete="off"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
          />
        </label>
        <button type="submit" className="bd-btn bd-btn--primary" disabled={busy}>
          {status.configured ? 'Unlock' : 'Set the PIN'}
        </button>
      </form>

      {problem && <p className="bd-warn">{problem}</p>}

      <p className="bd-note">
        {status.configured
          ? 'Contribution amounts stay confidential to the treasurer. Reports show only totals; who gave what needs this PIN.'
          : 'A phrase you can remember is far stronger than a short number. This protects donor names on a shared or Assembly-owned device — it is not protection against someone who obtains the database itself.'}
      </p>
    </section>
  )
}

function AwaitingReceipts({
  gifts,
  donors,
  onIssued,
  onError,
}: {
  gifts: readonly UnreceiptedGift[]
  donors: DonorView[] | null
  onIssued: () => void
  onError: (message: string) => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [chosen, setChosen] = useState<Record<string, string>>({})

  const issue = async (gift: UnreceiptedGift) => {
    setBusy(gift.contributionId)
    try {
      await issueReceipt({
        contributionId: gift.contributionId,
        donorId: chosen[gift.contributionId] || gift.donorId || null,
        note: null,
      })
      onIssued()
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="bd-card bd-card--wide">
      <div className="bd-card__head">
        <h2 className="bd-card__title">Gifts awaiting a receipt</h2>
        <p className="bd-card__hint">
          Mostly cash taken at Feast, where no name was written down at the time.
        </p>
      </div>

      <table className="bd-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>From</th>
            <th className="bd-table__num">Amount</th>
            <th>Fund</th>
            <th>Attribute to</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {gifts.map((gift) => (
            <tr key={gift.contributionId}>
              <td className="bd-table__date">{gift.occurredOn}</td>
              <td className="bd-payee">{gift.payee ?? '—'}</td>
              <td className="bd-table__num">{formatMoney(gift.amountCents)}</td>
              <td className="bd-table__meta">
                {gift.fundLabel} · {gift.method}
              </td>
              <td>
                {donors ? (
                  <select
                    className="bd-select"
                    value={chosen[gift.contributionId] ?? gift.donorId ?? ''}
                    onChange={(e) =>
                      setChosen({ ...chosen, [gift.contributionId]: e.target.value })
                    }
                  >
                    <option value="">No name recorded</option>
                    {donors
                      .filter((d) => !d.isAnonymous && d.name)
                      .map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                  </select>
                ) : (
                  <span className="bd-table__meta">
                    unlock donor records to attribute a name
                  </span>
                )}
              </td>
              <td>
                <button
                  type="button"
                  className="bd-btn bd-btn--primary"
                  disabled={busy === gift.contributionId}
                  onClick={() => void issue(gift)}
                >
                  Issue receipt
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function VoidButton({
  id,
  onVoided,
  onError,
}: {
  id: string
  onVoided: () => void
  onError: (message: string) => void
}) {
  const [asking, setAsking] = useState(false)
  const [reason, setReason] = useState('')

  if (!asking) {
    return (
      <button type="button" className="bd-btn bd-btn--quiet" onClick={() => setAsking(true)}>
        Void
      </button>
    )
  }

  return (
    <form
      className="bd-voidform"
      onSubmit={async (e) => {
        e.preventDefault()
        try {
          await voidReceipt(id, reason)
          onVoided()
        } catch (cause) {
          onError(cause instanceof Error ? cause.message : String(cause))
        }
      }}
    >
      <input
        className="bd-input"
        type="text"
        placeholder="Why?"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <button type="submit" className="bd-btn bd-btn--quiet">
        Void it
      </button>
    </form>
  )
}

function AccessLog() {
  const [entries, setEntries] = useState<AccessLogEntry[] | null>(null)

  useEffect(() => {
    fetchAccessLog().then(setEntries).catch(() => setEntries([]))
  }, [])

  if (!entries || entries.length === 0) return null

  return (
    <section className="bd-card bd-card--wide">
      <div className="bd-card__head">
        <h2 className="bd-card__title">Who has looked at donor detail</h2>
        <p className="bd-card__hint">
          Readable without the PIN. Oversight only the treasurer can read is not oversight.
        </p>
      </div>
      <table className="bd-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Who</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          {entries.slice(0, 15).map((e, i) => (
            <tr key={i}>
              <td className="bd-table__date">{e.occurredAt.slice(0, 16).replace('T', ' ')}</td>
              <td>{e.actor}</td>
              <td className="bd-table__meta">
                {e.reason}
                {e.donorId ? ' · one household' : ' · the whole list'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
