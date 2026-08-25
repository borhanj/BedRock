import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useSearchParams } from 'react-router-dom'
import { formatDateRange, formatLongDate } from '../calendar/badi'
import { formatMoney, formatSigned } from '../lib/money'
import {
  fetchAuditPackage,
  type AuditCheck,
  type AuditGap,
  type AuditPackageView,
} from '../data/api'
import { useYearState } from '../data/YearContext'
import Loading from '../components/Loading'
import ErrorPanel from '../components/ErrorPanel'

/** Shared chrome for the audit package and the handover. */
export function AuditLayout() {
  return (
    <div className="bd-page">
      <nav className="bd-subnav bd-noprint" aria-label="Audit sections">
        <NavLink end to="/audit" className={subnavClass}>
          The audit package
        </NavLink>
        <NavLink to="/audit/handover" className={subnavClass}>
          Handing over
        </NavLink>
      </nav>
      <Outlet />
    </div>
  )
}

const subnavClass = ({ isActive }: { isActive: boolean }) =>
  isActive ? 'bd-subnav__link bd-subnav__link--active' : 'bd-subnav__link'

/**
 * The Audit Package.
 *
 * One document, drawn against the database at the moment it is asked for, and
 * printable as it stands. Everything on it comes from the same functions the
 * rest of the app reads, so the pack and the screens cannot show an auditor
 * two different numbers.
 *
 * It leads with what it cannot vouch for. A pack that opened with tidy totals
 * and buried eleven uncategorised rows on page four would not be a cleaner
 * audit — only the same findings, arriving later and from someone else.
 */
export default function AuditPage() {
  const state = useYearState()
  const [params, setParams] = useSearchParams()
  const [pack, setPack] = useState<AuditPackageView | null>(null)
  const [error, setError] = useState<string | null>(null)

  const asked = params.get('year')
  const year = asked ? Number(asked) : 'current'

  useEffect(() => {
    let cancelled = false
    setPack(null)
    setError(null)
    fetchAuditPackage(year)
      .then((p) => !cancelled && setPack(p))
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [year])

  if (error) return <ErrorPanel message={error} />
  if (!pack) return <Loading label="Drawing the audit package" />

  const current = state.status === 'ready' ? state.year.bahaiYear : pack.bahaiYear
  const failed = pack.checks.filter((c) => !c.holds)
  const outstanding = pack.gaps.filter((g) => g.count > 0)

  return (
    <>
      <div className="bd-pagehead bd-noprint">
        <div>
          <p className="bd-eyebrow">Audit</p>
          <h1 className="bd-headline">The audit package</h1>
        </div>
        <div className="bd-actions bd-actions--left">
          <select
            className="bd-select"
            value={pack.bahaiYear}
            onChange={(e) => setParams({ year: e.target.value })}
            aria-label="Which Bahá’í year"
          >
            {[current, current - 1, current - 2].map((y) => (
              <option key={y} value={y}>
                {y} B.E.
              </option>
            ))}
          </select>
          <button
            type="button"
            className="bd-btn bd-btn--primary"
            onClick={() => window.print()}
          >
            Print or save as PDF
          </button>
        </div>
      </div>

      <article className="bd-pack">
        <header className="bd-pack__head">
          <div>
            <p className="bd-pack__eyebrow">Audit package</p>
            <h2 className="bd-pack__title">
              {pack.assembly.name} · {pack.bahaiYear} B.E.
            </h2>
            <p className="bd-pack__meta">
              {formatDateRange(pack.nawRuz, pack.yearEnd)}
            </p>
          </div>
          <p className="bd-pack__meta">
            Drawn {formatLongDate(pack.preparedOn)}
            <br />
            by {pack.preparedBy}
            <br />
            {pack.yearComplete
              ? 'The year is complete.'
              : 'The year is still running; figures are to date.'}
          </p>
        </header>

        {/*
          Findings first, deliberately. An auditor reading this document is
          deciding whether to trust the figures behind it, and burying what
          does not hold behind six pages of tables answers a different
          question from the one being asked.
        */}
        <Section
          title="What was checked"
          note={
            failed.length === 0
              ? 'Every check below was computed against the database as this document was drawn. None is cached, and none is asserted from a flag.'
              : `${failed.length} of ${pack.checks.length} checks did not hold. They are listed first.`
          }
        >
          <ul className="bd-checks">
            {[...pack.checks].sort((a, b) => Number(a.holds) - Number(b.holds)).map((c) => (
              <CheckRow key={c.key} check={c} />
            ))}
          </ul>
        </Section>

        <Section
          title="What is not finished"
          note={
            outstanding.length === 0
              ? 'Nothing outstanding in this year.'
              : 'Disclosed here rather than omitted. None of these makes a figure wrong; each says something a reader would otherwise assume.'
          }
        >
          {outstanding.length === 0 ? (
            <p className="bd-pack__aside">
              Every transaction is categorised, every expense documented, every gift
              receipted, and every bank row proved against a statement.
            </p>
          ) : (
            <ul className="bd-checks">
              {outstanding.map((g) => (
                <GapRow key={g.key} gap={g} />
              ))}
            </ul>
          )}
        </Section>

        {/* ── the figures ─────────────────────────────────────────────── */}

        <Section title="The year">
          <div className="bd-pack__figures">
            <Figure label="Carried in at Naw-Rúz" value={pack.summary.openingCents} />
            <Figure
              label="Contributions received"
              value={pack.summary.incomeByFund.reduce((s, l) => s + l.amountCents, 0)}
            />
            <Figure
              label="Expenses paid"
              value={pack.summary.expensesByCategory.reduce((s, l) => s + l.amountCents, 0)}
            />
            <Figure label="Balance at close" value={pack.summary.closingCents} />
          </div>
          <p className="bd-pack__aside">
            {pack.summary.contributionCount} contributions from{' '}
            {pack.summary.householdCount} households. Individual amounts are
            confidential and are not in this document; donor identity is encrypted and
            was not decrypted to produce it.
          </p>
        </Section>

        <div className="bd-pack__cols">
          <Section title="Income by fund" compact>
            <LineTable
              rows={pack.summary.incomeByFund.map((l) => [l.label, l.amountCents])}
            />
          </Section>
          <Section title="Expenses by category" compact>
            <LineTable
              rows={pack.summary.expensesByCategory.map((l) => [l.label, l.amountCents])}
            />
          </Section>
        </div>

        <Section
          title="Funds held"
          note="A partition: the rows sum to everything on hand, so money cannot belong to two of them or to none."
        >
          <table className="bd-pack__table">
            <thead>
              <tr>
                <th>Fund</th>
                <th className="bd-table__num">Received</th>
                <th className="bd-table__num">Spent</th>
                <th className="bd-table__num">Forwarded</th>
                <th className="bd-table__num">Held</th>
              </tr>
            </thead>
            <tbody>
              {pack.funds.funds.map((f) => (
                <tr key={f.key}>
                  <td>
                    {f.label}
                    {f.isPassthrough && ' — held for another institution'}
                  </td>
                  <td className="bd-table__num">{dash(f.receivedCents)}</td>
                  <td className="bd-table__num">{dash(f.spentCents)}</td>
                  <td className="bd-table__num">{dash(f.forwardedCents)}</td>
                  <td className="bd-table__num">{formatMoney(f.balanceCents)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4}>On hand</td>
                <td className="bd-table__num">{formatMoney(pack.funds.onHandCents)}</td>
              </tr>
            </tfoot>
          </table>
        </Section>

        {pack.funds.remittances.length > 0 && (
          <Section
            title="Forwarded to other funds"
            note="Each line is both a withdrawal from the account and a discharge of the fund."
          >
            <table className="bd-pack__table">
              <thead>
                <tr>
                  <th>Sent</th>
                  <th>Fund</th>
                  <th className="bd-table__num">Amount</th>
                  <th>Reference</th>
                </tr>
              </thead>
              <tbody>
                {pack.funds.remittances.map((r) => (
                  <tr key={r.id}>
                    <td>{r.sentOn}</td>
                    <td>{r.fundLabel}</td>
                    <td className="bd-table__num">{formatMoney(r.amountCents)}</td>
                    <td>{r.reference ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        )}

        {pack.budget.status !== 'none' && (
          <Section
            title="Budget against actual"
            note={
              (pack.budget.status === 'approved'
                ? pack.budget.note ??
                  `Approved${pack.budget.approvedOn ? ` on ${pack.budget.approvedOn}` : ''}.`
                : 'This budget was drafted but never approved by the Assembly.') +
              // Said plainly, because every line of a mid-year pack is under a
              // whole-year figure and the variance column looks alarming until
              // you know that.
              (pack.yearComplete
                ? ''
                : ` The year is ${pack.budget.monthsElapsed} of 19 months old, so every` +
                  ' variance below is against a whole-year figure that has not been' +
                  ' reached yet.')
            }
          >
            <table className="bd-pack__table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th className="bd-table__num">Budget</th>
                  <th className="bd-table__num">Actual</th>
                  <th className="bd-table__num">Variance</th>
                </tr>
              </thead>
              <tbody>
                {[...pack.budget.income, ...pack.budget.expenses, ...pack.budget.passthrough]
                  .filter((l) => l.budgetCents !== 0 || l.actualCents !== 0)
                  .map((l) => (
                    <tr key={l.categoryId}>
                      <td>{l.label}</td>
                      <td className="bd-table__num">{dash(l.budgetCents)}</td>
                      <td className="bd-table__num">{dash(l.actualCents)}</td>
                      <td className="bd-table__num">
                        {l.budgetCents === 0 ? '—' : formatSigned(l.varianceCents)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </Section>
        )}

        <Section
          title="Bank reconciliation"
          note="A statement is balanced only at a difference of exactly zero. There is no adjusting entry in this system."
        >
          {pack.reconciliations.length === 0 ? (
            <p className="bd-pack__aside">
              No bank statement has been reconciled. The ledger is unproved against the
              bank.
            </p>
          ) : (
            <table className="bd-pack__table">
              <thead>
                <tr>
                  <th>Statement ended</th>
                  <th>Account</th>
                  <th className="bd-table__num">Statement balance</th>
                  <th className="bd-table__num">Difference</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {pack.reconciliations.map((r) => (
                  <tr key={r.id}>
                    <td>{r.statementEndedOn}</td>
                    <td>{r.accountName}</td>
                    <td className="bd-table__num">
                      {formatMoney(r.statementBalanceCents)}
                    </td>
                    <td className="bd-table__num">
                      {r.differenceCents === 0 ? '—' : formatSigned(r.differenceCents)}
                    </td>
                    <td>{r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        <Section
          title="The receipt book"
          note="Numbering is gapless. A mistake is voided with a stated reason and keeps its number; nothing is deleted."
        >
          <p className="bd-pack__aside">
            {pack.receiptSummary.issued} issued, {pack.receiptSummary.voided} voided,{' '}
            {formatMoney(pack.receiptSummary.totalCents)} acknowledged. Next number{' '}
            {pack.receiptSummary.nextNumber}.
          </p>
          {pack.receipts.length > 0 && (
            <table className="bd-pack__table">
              <thead>
                <tr>
                  <th>No.</th>
                  <th>Issued</th>
                  <th className="bd-table__num">Amount</th>
                  <th>Fund</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {pack.receipts.map((r) => (
                  <tr key={r.id}>
                    <td>{r.number}</td>
                    <td>{r.issuedOn}</td>
                    <td className="bd-table__num">{formatMoney(r.amountCents)}</td>
                    <td>{r.fundLabel}</td>
                    <td>{r.voidedAt ? `void — ${r.voidReason ?? 'no reason given'}` : 'issued'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        <Section
          title="Who looked at donor detail"
          note="Aggregate reporting never needs a donor's name, so a decryption means someone deliberately asked. The log records that a name was read, never the name."
        >
          {pack.donorAccess.length === 0 ? (
            <p className="bd-pack__aside">
              No donor identity has been decrypted. Every figure in this document was
              produced without one.
            </p>
          ) : (
            <table className="bd-pack__table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {pack.donorAccess.map((a, i) => (
                  <tr key={`${a.occurredAt}-${i}`}>
                    <td>{a.occurredAt}</td>
                    <td>{a.actor}</td>
                    <td>{a.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        <Section
          title={`The ledger — ${pack.ledger.length} transactions`}
          note="Every row in the year, as entered, in date order."
        >
          <table className="bd-pack__table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Payee</th>
                <th>Category</th>
                <th>Account</th>
                <th className="bd-table__num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {[...pack.ledger]
                .sort((a, b) => a.occurredOn.localeCompare(b.occurredOn))
                .map((r) => (
                  <tr key={r.id}>
                    <td>{r.occurredOn}</td>
                    <td>{r.payee ?? '—'}</td>
                    <td>
                      {r.categoryLabel ??
                        (r.kind === 'remittance' ? 'Forwarded upward' : '— none —')}
                    </td>
                    <td>{r.accountName}</td>
                    <td className="bd-table__num">{formatSigned(r.amountCents)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </Section>

        <footer className="bd-pack__foot">
          <p>
            Produced by Bedrock for {pack.assembly.name} on{' '}
            {formatLongDate(pack.preparedOn)}. Every figure was computed against the
            database at that moment; nothing in this document was typed by hand or
            carried forward from a previous version.
          </p>
        </footer>
      </article>

      <p className="bd-note bd-noprint">
        Working from this pack? The <Link to="/ledger">ledger</Link>,{' '}
        <Link to="/funds">funds</Link>, <Link to="/budget">budget</Link> and{' '}
        <Link to="/ledger/reconcile">reconciliation</Link> screens are the same figures,
        live.
      </p>
    </>
  )
}

function Section({
  title,
  note,
  compact,
  children,
}: {
  title: string
  note?: string
  compact?: boolean
  children: React.ReactNode
}) {
  return (
    <section className={compact ? 'bd-pack__block bd-pack__block--compact' : 'bd-pack__block'}>
      <h3 className="bd-pack__blockhead">{title}</h3>
      {note && <p className="bd-pack__note">{note}</p>}
      {children}
    </section>
  )
}

function CheckRow({ check }: { check: AuditCheck }) {
  return (
    <li className={`bd-check${check.holds ? '' : ' bd-check--failed'}`}>
      <span className="bd-check__mark" aria-hidden="true">
        {check.holds ? '✓' : '!'}
      </span>
      <span>
        <span className="bd-check__label">{check.label}</span>
        <span className="bd-check__detail">{check.detail}</span>
      </span>
      <span className="bd-check__verdict">{check.holds ? 'holds' : 'does not hold'}</span>
    </li>
  )
}

function GapRow({ gap }: { gap: AuditGap }) {
  return (
    <li className="bd-check bd-check--gap">
      <span className="bd-check__mark" aria-hidden="true">
        {gap.count}
      </span>
      <span>
        <span className="bd-check__label">{gap.label}</span>
        <span className="bd-check__detail">{gap.consequence}</span>
      </span>
    </li>
  )
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div className="bd-pack__figure">
      <span className="bd-pack__figurelabel">{label}</span>
      <span className="bd-pack__figurevalue">{formatMoney(value)}</span>
    </div>
  )
}

function LineTable({ rows }: { rows: readonly [string, number][] }) {
  return (
    <table className="bd-pack__table">
      <tbody>
        {rows.map(([label, cents]) => (
          <tr key={label}>
            <td>{label}</td>
            <td className="bd-table__num">{formatMoney(cents)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td>Total</td>
          <td className="bd-table__num">
            {formatMoney(rows.reduce((s, [, c]) => s + c, 0))}
          </td>
        </tr>
      </tfoot>
    </table>
  )
}

const dash = (cents: number) => (cents === 0 ? '—' : formatMoney(cents))
