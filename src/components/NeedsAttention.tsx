import { useNavigate } from 'react-router-dom'
import type { AttentionView } from '../shared/types'

/**
 * The volunteer's worklist. A count of zero is not a failure state — it is the
 * good outcome, and reads in the settled tone rather than the amber one.
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
          const clear = item.count === 0
          const label = clear && item.resolvedLabel ? item.resolvedLabel : item.label
          return (
            <button
              key={item.key}
              type="button"
              className={`bd-attention__row${clear ? ' bd-attention__row--clear' : ''}`}
              disabled={clear}
              onClick={() => navigate('/ledger')}
            >
              <span className="bd-attention__count">{item.count}</span>
              <span className="bd-attention__label">{label}</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
