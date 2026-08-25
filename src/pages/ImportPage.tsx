import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { formatSigned } from '../lib/money'
import {
  commitImport,
  fetchChoices,
  previewImport,
  type Choices,
  type ColumnMapping,
  type ImportPreview,
} from '../data/api'
import Loading from '../components/Loading'
import ErrorPanel from '../components/ErrorPanel'

/**
 * Importing a bank statement.
 *
 * Three steps, and nothing is written until the last one. The middle step —
 * confirming the columns and the date order — exists because getting either
 * wrong silently puts wrong numbers in the books, and a preview costs a click
 * where a bad import costs an evening.
 */
export default function ImportPage() {
  const [choices, setChoices] = useState<Choices | null>(null)
  const [accountId, setAccountId] = useState('')
  const [filename, setFilename] = useState<string | null>(null)
  const [csvText, setCsvText] = useState<string | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [mapping, setMapping] = useState<ColumnMapping | null>(null)
  const [accepted, setAccepted] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ imported: number; skipped: number } | null>(null)

  useEffect(() => {
    fetchChoices()
      .then((c) => {
        setChoices(c)
        setAccountId(c.accounts.find((a) => a.kind === 'bank')?.id ?? c.accounts[0]?.id ?? '')
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      )
  }, [])

  const runPreview = async (text: string, override?: ColumnMapping) => {
    setBusy(true)
    setError(null)
    try {
      const result = await previewImport(accountId, text, override)
      setPreview(result)
      setMapping(result.mapping)
      // Everything unambiguous is ticked; flagged rows start unticked so a
      // possible duplicate is only imported by a deliberate act.
      setAccepted(
        new Set(result.rows.filter((r) => r.verdict === 'new').map((r) => r.dedupeHash)),
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const onFile = async (file: File) => {
    const text = await file.text()
    setFilename(file.name)
    setCsvText(text)
    setDone(null)
    await runPreview(text)
  }

  if (error) return <ErrorPanel message={error} />
  if (!choices) return <Loading label="Getting ready" />

  if (done) {
    return (
      <div className="bd-placeholder">
        <h1 className="bd-placeholder__title">
          {done.imported} transaction{done.imported === 1 ? '' : 's'} imported
        </h1>
        <p className="bd-placeholder__body">
          {done.skipped > 0
            ? `${done.skipped} row${done.skipped === 1 ? ' was' : 's were'} skipped — already on file, or not accepted.`
            : 'Nothing was skipped.'}
        </p>
        <p className="bd-placeholder__body">
          <button
            type="button"
            className="bd-btn bd-btn--primary"
            onClick={() => {
              setDone(null)
              setPreview(null)
              setCsvText(null)
              setFilename(null)
            }}
          >
            Import another
          </button>
        </p>
      </div>
    )
  }

  return (
    <>
      <div className="bd-pagehead">
        <div>
          <p className="bd-eyebrow">Import</p>
          <h1 className="bd-headline">Bring in a bank statement</h1>
        </div>
      </div>

      <section className="bd-card bd-card--wide">
        <div className="bd-formrow">
          <label className="bd-field">
            <span className="bd-field__label">Account</span>
            <select
              className="bd-select"
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
            >
              {choices.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>

          <label className="bd-field">
            <span className="bd-field__label">CSV file</span>
            <input
              className="bd-input"
              type="file"
              accept=".csv,text/csv,text/plain"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void onFile(file)
              }}
            />
          </label>
        </div>
        {filename && <p className="bd-card__hint">Reading {filename}</p>}
      </section>

      {busy && <Loading label="Reading the file" />}

      {preview && mapping && csvText && (
        <>
          <MappingCard
            preview={preview}
            mapping={mapping}
            onChange={(next) => {
              setMapping(next)
              void runPreview(csvText, next)
            }}
          />

          <PreviewTable
            preview={preview}
            accepted={accepted}
            onToggle={(hash) => {
              const next = new Set(accepted)
              if (next.has(hash)) next.delete(hash)
              else next.add(hash)
              setAccepted(next)
            }}
          />

          <div className="bd-actions">
            <button
              type="button"
              className="bd-btn bd-btn--primary"
              disabled={busy || accepted.size === 0}
              onClick={async () => {
                setBusy(true)
                try {
                  const result = await commitImport({
                    accountId,
                    csvText,
                    filename,
                    mapping,
                    accept: [...accepted],
                  })
                  setDone(result)
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : String(cause))
                } finally {
                  setBusy(false)
                }
              }}
            >
              Import {accepted.size} transaction{accepted.size === 1 ? '' : 's'}
            </button>
          </div>
        </>
      )}
    </>
  )
}

function MappingCard({
  preview,
  mapping,
  onChange,
}: {
  preview: ImportPreview
  mapping: ColumnMapping
  onChange: (next: ColumnMapping) => void
}) {
  const columns = preview.header.map((name, index) => ({ name: name || `Column ${index + 1}`, index }))
  const ambiguous = preview.dateDetection.kind === 'ambiguous'

  return (
    <section className="bd-card bd-card--wide">
      <div className="bd-card__head">
        <h2 className="bd-card__title">Which column is which</h2>
        {preview.skippedPreamble > 0 && (
          <p className="bd-card__hint">
            Skipped {preview.skippedPreamble} line
            {preview.skippedPreamble === 1 ? '' : 's'} above the header
          </p>
        )}
      </div>

      <div className="bd-formrow">
        <label className="bd-field">
          <span className="bd-field__label">Date</span>
          <select
            className="bd-select"
            value={mapping.date}
            onChange={(e) => onChange({ ...mapping, date: Number(e.target.value) })}
          >
            {columns.map((c) => (
              <option key={c.index} value={c.index}>{c.name}</option>
            ))}
          </select>
        </label>

        <label className="bd-field">
          <span className="bd-field__label">Date order</span>
          <select
            className={`bd-select${ambiguous ? ' bd-select--warn' : ''}`}
            value={mapping.dateFormat}
            onChange={(e) =>
              onChange({ ...mapping, dateFormat: e.target.value as ColumnMapping['dateFormat'] })
            }
          >
            <option value="dmy">Day / Month / Year</option>
            <option value="mdy">Month / Day / Year</option>
            <option value="ymd">Year – Month – Day</option>
          </select>
        </label>

        <label className="bd-field">
          <span className="bd-field__label">Description</span>
          <select
            className="bd-select"
            value={mapping.description}
            onChange={(e) => onChange({ ...mapping, description: Number(e.target.value) })}
          >
            {columns.map((c) => (
              <option key={c.index} value={c.index}>{c.name}</option>
            ))}
          </select>
        </label>
      </div>

      {/*
        The one thing on this screen that can silently corrupt a year of
        reports. 03/04 is 3 April or 4 March and the file does not say; when
        the data cannot settle it, the treasurer must.
      */}
      {ambiguous ? (
        <p className="bd-warn">
          This file’s dates could be read either way — every value is 12 or under on
          both sides, so nothing in it proves the order. Check a transaction you
          remember against the dates below before importing.
        </p>
      ) : preview.dateDetection.kind === 'detected' ? (
        <p className="bd-note">Read as {preview.dateDetection.reason}.</p>
      ) : (
        <p className="bd-warn">
          The dates in that column were not recognised. Try a different column or
          date order.
        </p>
      )}

      {preview.problems.length > 0 && (
        <p className="bd-warn">
          {preview.problems.length} row{preview.problems.length === 1 ? '' : 's'} could
          not be read and will not be imported — line{' '}
          {preview.problems.slice(0, 5).map((p) => p.line).join(', ')}
          {preview.problems.length > 5 && '…'}. {preview.problems[0].reason}.
        </p>
      )}
    </section>
  )
}

function PreviewTable({
  preview,
  accepted,
  onToggle,
}: {
  preview: ImportPreview
  accepted: Set<string>
  onToggle: (hash: string) => void
}) {
  const { counts } = preview
  return (
    <section className="bd-card bd-card--wide">
      <div className="bd-card__head">
        <h2 className="bd-card__title">What this will do</h2>
        <p className="bd-card__hint">
          {counts.fresh} new · {counts.duplicates} already on file
          {counts.possible > 0 && ` · ${counts.possible} to check`}
        </p>
      </div>

      <table className="bd-table">
        <thead>
          <tr>
            <th />
            <th>Date</th>
            <th>Description</th>
            <th className="bd-table__num">Amount</th>
            <th>Status</th>
          </tr>
        </thead>
        <caption className="bd-note">
          {preview.counts.beforeOpening > 0 ? (
            <>
              {preview.counts.beforeOpening}{' '}
              {preview.counts.beforeOpening === 1 ? 'row is' : 'rows are'} dated before{' '}
              {preview.openedOn}, the day these books open, so{' '}
              {preview.counts.beforeOpening === 1 ? 'it is' : 'they are'} not part of them.
              The opening balance already accounts for what happened before that day —
              importing{' '}
              {preview.counts.beforeOpening === 1 ? 'it' : 'them'} would count the same money
              twice. To take this history on, <Link to="/setup">move the opening date back</Link>{' '}
              and restate what was held then, and these rows become importable.
            </>
          ) : null}
        </caption>
        <tbody>
          {preview.rows.map((row) => {
            const duplicate = row.verdict === 'duplicate'
            const outside = row.verdict === 'before-opening'
            return (
              <tr
                key={row.dedupeHash}
                className={duplicate || outside ? 'bd-tr--muted' : undefined}
              >
                <td>
                  <input
                    type="checkbox"
                    checked={accepted.has(row.dedupeHash) && !outside}
                    disabled={duplicate || outside}
                    onChange={() => onToggle(row.dedupeHash)}
                    aria-label={`Import ${row.description}`}
                  />
                </td>
                <td className="bd-table__date">{row.occurredOn}</td>
                <td>
                  <span className="bd-payee">{row.description}</span>
                  {row.suggestion?.categoryLabel && (
                    <span className="bd-memo">
                      Will suggest “{row.suggestion.categoryLabel}” — {row.suggestion.because}
                    </span>
                  )}
                </td>
                <td
                  className={`bd-table__num ${
                    row.amountCents > 0 ? 'bd-amount--in' : 'bd-amount--out'
                  }`}
                >
                  {formatSigned(row.amountCents)}
                </td>
                <td className="bd-table__meta">
                  {duplicate && <span className="bd-flag">already on file</span>}
                  {row.verdict === 'possible-duplicate' && (
                    <span className="bd-flag bd-flag--warn">
                      looks like {row.nearMatch?.occurredOn}
                      {row.nearMatch?.daysApart
                        ? ` (${row.nearMatch.daysApart} days apart)`
                        : ''}
                    </span>
                  )}
                  {outside && (
                    <span className="bd-flag bd-flag--warn">before the books open</span>
                  )}
                  {row.verdict === 'new' && 'new'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}
