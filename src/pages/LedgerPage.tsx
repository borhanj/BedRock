import { useCallback, useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useSearchParams } from 'react-router-dom'
import { formatSigned } from '../lib/money'
import {
  fetchChoices,
  fetchLedger,
  setCategory,
  type Choices,
  type LedgerRow,
} from '../data/api'
import Loading from '../components/Loading'
import ErrorPanel from '../components/ErrorPanel'

/** Shared chrome for the ledger, cash journal and import screens. */
export function LedgerLayout() {
  return (
    <div className="bd-page">
      <nav className="bd-subnav" aria-label="Ledger sections">
        <NavLink end to="/ledger" className={subnavClass}>
          All transactions
        </NavLink>
        <NavLink to="/ledger/cash" className={subnavClass}>
          Cash journal
        </NavLink>
        <NavLink to="/ledger/import" className={subnavClass}>
          Import a statement
        </NavLink>
      </nav>
      <Outlet />
    </div>
  )
}

const subnavClass = ({ isActive }: { isActive: boolean }) =>
  isActive ? 'bd-subnav__link bd-subnav__link--active' : 'bd-subnav__link'

export default function LedgerPage() {
  const [params, setParams] = useSearchParams()
  const [rows, setRows] = useState<LedgerRow[] | null>(null)
  const [choices, setChoices] = useState<Choices | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState(params.get('search') ?? '')

  const uncategorisedOnly = params.get('uncategorised') === '1'

  const load = useCallback(async () => {
    try {
      const [ledger, options] = await Promise.all([
        fetchLedger({
          year: 'current',
          uncategorisedOnly,
          search: params.get('search') ?? undefined,
        }),
        fetchChoices(),
      ])
      setRows(ledger)
      setChoices(options)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [uncategorisedOnly, params])

  useEffect(() => {
    void load()
  }, [load])

  if (error) return <ErrorPanel message={error} />
  if (!rows || !choices) return <Loading label="Reading the ledger" />

  // Same predicate as the dashboard's worklist. Counting remittances here too
  // would show the treasurer two different numbers for the same question.
  const outstanding = rows.filter(
    (r) => r.categoryId === null && (r.kind === 'contribution' || r.kind === 'expense'),
  ).length

  return (
    <>
      <div className="bd-pagehead">
        <div>
          <p className="bd-eyebrow">Ledger</p>
          <h1 className="bd-headline">
            {rows.length} transaction{rows.length === 1 ? '' : 's'}
            {outstanding > 0 && ` · ${outstanding} still to categorise`}
          </h1>
        </div>
      </div>

      <form
        className="bd-filters"
        onSubmit={(event) => {
          event.preventDefault()
          const next = new URLSearchParams(params)
          if (search) next.set('search', search)
          else next.delete('search')
          setParams(next)
        }}
      >
        <input
          className="bd-input"
          type="search"
          value={search}
          placeholder="Search payee or memo"
          onChange={(event) => setSearch(event.target.value)}
        />
        <label className="bd-check">
          <input
            type="checkbox"
            checked={uncategorisedOnly}
            onChange={(event) => {
              const next = new URLSearchParams(params)
              if (event.target.checked) next.set('uncategorised', '1')
              else next.delete('uncategorised')
              setParams(next)
            }}
          />
          Only what needs a category
        </label>
        <button type="submit" className="bd-btn bd-btn--primary">
          Search
        </button>
      </form>

      {rows.length === 0 ? (
        <div className="bd-placeholder">
          <p className="bd-placeholder__body">
            Nothing here.{' '}
            <Link to="/ledger/import">Import a statement</Link> to get started.
          </p>
        </div>
      ) : (
        <table className="bd-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Payee</th>
              <th className="bd-table__num">Amount</th>
              <th>Category</th>
              <th>Where</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <LedgerRowView
                key={row.id}
                row={row}
                choices={choices}
                onChanged={load}
              />
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

function LedgerRowView({
  row,
  choices,
  onChanged,
}: {
  row: LedgerRow
  choices: Choices
  onChanged: () => void
}) {
  const [saving, setSaving] = useState(false)
  const income = row.amountCents > 0

  const apply = async (categoryId: string) => {
    setSaving(true)
    try {
      await setCategory(row.id, {
        categoryId: categoryId || null,
        fundId: row.fundId,
        txnKind: null,
      })
      onChanged()
    } finally {
      setSaving(false)
    }
  }

  const relevant = choices.categories.filter((c) =>
    income ? c.kind === 'income' : c.kind === 'expense',
  )

  // A remittance is money passed upward to another institution, not an
  // expense of the Assembly, so it takes no income/expense category.
  const categorisable = row.kind === 'contribution' || row.kind === 'expense'

  return (
    <tr className={row.categoryId === null && categorisable ? 'bd-tr--todo' : undefined}>
      <td className="bd-table__date">{row.occurredOn}</td>
      <td>
        <span className="bd-payee">{row.payee ?? '—'}</span>
        {row.memo && <span className="bd-memo">{row.memo}</span>}
      </td>
      <td
        className={`bd-table__num ${income ? 'bd-amount--in' : 'bd-amount--out'}`}
      >
        {formatSigned(row.amountCents)}
      </td>
      <td>
        {!categorisable ? (
          <span className="bd-table__meta">
            {row.kind === 'remittance' ? 'Forwarded upward' : row.kind}
          </span>
        ) : row.isLocked ? (
          <span className="bd-locked" title="This period is closed. Unlock its report to edit.">
            {row.categoryLabel ?? 'Uncategorised'} · locked
          </span>
        ) : (
          <>
            <select
              className="bd-select"
              value={row.categoryId ?? ''}
              disabled={saving}
              onChange={(event) => void apply(event.target.value)}
            >
              <option value="">Choose a category…</option>
              {relevant.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            {/*
              A suggestion is offered, never applied. The treasurer clicking it
              is what teaches the rule; silently filling it in would put a
              number in the books that nobody chose.
            */}
            {row.categoryId === null && row.suggestion?.categoryId && (
              <button
                type="button"
                className="bd-suggest"
                disabled={saving}
                title={`Suggested because ${row.suggestion.because}`}
                onClick={() => void apply(row.suggestion!.categoryId!)}
              >
                Use “{row.suggestion.categoryLabel}”?
              </button>
            )}
          </>
        )}
      </td>
      <td className="bd-table__meta">
        {row.accountName}
        {row.accountKind === 'cash' && ' · cash'}
        {row.kind === 'expense' && !row.hasReceiptImage && (
          <span className="bd-flag" title="No receipt image on file for this expense">
            no receipt
          </span>
        )}
      </td>
    </tr>
  )
}
