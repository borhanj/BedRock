import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { formatLongDate } from '../calendar/badi'
import { formatMoney } from '../lib/money'
import { fetchReceipt, listDonors, type ReceiptDocument } from '../data/api'
import { useVault } from '../data/vault'
import Loading from '../components/Loading'
import ErrorPanel from '../components/ErrorPanel'

/**
 * One receipt, to print and hand to someone.
 *
 * The name is the only part that needs the vault, and the document is built to
 * be useful without it: number, date, amount and fund are the acknowledgement,
 * and a treasurer working from a locked machine can still print one and write
 * the name on by hand. Asking for the name is the same gated, logged act it is
 * everywhere else — printing a receipt is not a loophole around it.
 *
 * A voided receipt still prints, marked void and carrying the stated reason.
 * It keeps its number, and the sequence stays gapless.
 */
export default function ReceiptPage() {
  const { id = '' } = useParams()
  const vault = useVault()
  const [doc, setDoc] = useState<ReceiptDocument | null>(null)
  const [name, setName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setDoc(null)
    setName(null)
    fetchReceipt(id)
      .then(async (d) => {
        if (cancelled) return
        setDoc(d)
        if (vault.pin && d.receipt.donorId) {
          const donors = await listDonors(vault.pin, `printed receipt ${d.receipt.number}`)
          if (!cancelled) {
            setName(donors.find((x) => x.id === d.receipt.donorId)?.name ?? null)
          }
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [id, vault.pin])

  if (error) return <ErrorPanel message={error} />
  if (!doc) return <Loading label="Reading the receipt" />

  const { receipt } = doc
  const voided = receipt.voidedAt !== null

  return (
    <div className="bd-reportwrap">
      <div className="bd-reportbar bd-noprint">
        <Link to="/receipts">← The receipt book</Link>
        <button
          type="button"
          className="bd-btn bd-btn--primary"
          onClick={() => window.print()}
        >
          Print this receipt
        </button>
      </div>

      <article className={`bd-receipt${voided ? ' bd-receipt--void' : ''}`}>
        <header className="bd-receipt__head">
          <div>
            <p className="bd-receipt__eyebrow">Receipt for a contribution</p>
            <h1 className="bd-receipt__assembly">{doc.assemblyName}</h1>
          </div>
          <div className="bd-receipt__number">
            <span className="bd-receipt__numberlabel">No.</span>
            <span className="bd-receipt__numbervalue">{receipt.number}</span>
          </div>
        </header>

        {voided && (
          <p className="bd-receipt__voidmark">
            {/* voided_at is a timestamp, not a civil date — the schema is
                explicit about the difference and formatLongDate takes the
                latter. The day is what belongs on a printed receipt anyway. */}
            Void — {receipt.voidReason ?? 'no reason recorded'}. Voided{' '}
            {formatLongDate(receipt.voidedAt!.slice(0, 10))}. This number is retained so
            the sequence stays gapless; a corrected receipt was issued under the next one.
          </p>
        )}

        <dl className="bd-receipt__rows">
          <Row label="Received from">
            {receipt.anonymous ? (
              <span className="bd-receipt__muted">An anonymous contributor</span>
            ) : name ? (
              name
            ) : receipt.donorId ? (
              <span className="bd-receipt__blank" aria-label="Space for the name">
                &nbsp;
              </span>
            ) : (
              <span className="bd-receipt__muted">No donor recorded</span>
            )}
          </Row>
          <Row label="Date received">{formatLongDate(receipt.issuedOn)}</Row>
          <Row label="Fund">{receipt.fundLabel}</Row>
          <Row label="By">{receipt.method}</Row>
          <Row label="Amount">
            <span className="bd-receipt__amount">{formatMoney(receipt.amountCents)}</span>
          </Row>
          {receipt.note && <Row label="Note">{receipt.note}</Row>}
        </dl>

        <footer className="bd-receipt__foot">
          <p>
            With gratitude for your contribution to the work of the Faith. This receipt
            is the Assembly’s acknowledgement of the gift recorded above.
          </p>
          <p className="bd-receipt__sign">
            <span className="bd-receipt__signline" />
            Treasurer, {doc.assemblyName}
          </p>
        </footer>
      </article>

      {receipt.donorId && !name && !receipt.anonymous && (
        <p className="bd-note bd-noprint">
          {vault.unlocked
            ? 'This gift is against a donor with no name on file, so the line is left blank to write on.'
            : 'The donor vault is locked, so the name is left blank to write on. Unlock it on the receipt book page to have it printed — that is a logged act, as it is everywhere else.'}
        </p>
      )}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bd-receipt__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}
