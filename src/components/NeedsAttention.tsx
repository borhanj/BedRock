import { useNavigate } from 'react-router-dom'
import type { AttentionView } from '../shared/types'

/**
 * The volunteer's worklist.
 *
 * A count of zero is not a failure state — it is the good outcome, and reads
 * in the settled tone rather than the amber one.
 *
 * A row can also be neither. "The bank has never been reconciled" is not a
 * finding of zero problems; it is the absence of a check, and it shows a dash
 * rather than a nought so it cannot be mistaken for one.
 */
export default function NeedsAttention({
  items,
}: {
  items: readonly AttentionView[]
}) {
  const navigate = useNavigate()

  return (
    <section className="bd-card">
      <h2 className="bd-card__label">Needs your attention</h2>

      <div className="bd-attention">
        {items.map((item) => {
          const unknown = item.tone === 'unknown'
          const clear = !unknown && item.count === 0
          const label = clear && item.resolvedLabel ? item.resolvedLabel : item.label
          return (
            <button
              key={item.key}
              type="button"
              className={`bd-attention__row${clear ? ' bd-attention__row--clear' : ''}${
                unknown ? ' bd-attention__row--unknown' : ''
              }`}
              disabled={clear}
              onClick={() => navigate(item.href)}
            >
              <span className="bd-attention__count">{unknown ? '—' : item.count}</span>
              <span className="bd-attention__label">{label}</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
