import { formatMoney, share, sumCents } from '../lib/money'
import type { FundBalanceView } from '../shared/types'

/** Ramp for the split bar, in the order the funds are listed. */
const SWATCHES = [
  'var(--bd-primary)',
  'var(--bd-accent)',
  'var(--bd-accent-pale)',
  'var(--bd-ink)',
]

/**
 * The balance broken down by fund.
 *
 * The point of this card is the last line: some of what is on hand is not the
 * Assembly's to spend. Money contributed to the National or Continental Fund
 * passes through the local account and is owed upward.
 */
export default function WhereMoneySits({ funds }: { funds: readonly FundBalanceView[] }) {
  const total = sumCents(funds.map((f) => f.balanceCents))
  const heldForOthers = sumCents(
    funds.filter((f) => f.isPassthrough).map((f) => f.balanceCents),
  )

  return (
    <section className="bd-card">
      <h2 className="bd-card__label">Where the money sits</h2>

      <div
        className="bd-split"
        role="img"
        aria-label={funds
          .map((f) => `${f.label} ${formatMoney(f.balanceCents)}`)
          .join(', ')}
      >
        {funds.map((fund, i) => (
          <span
            key={fund.key}
            className="bd-split__part"
            style={{
              width: `${share(fund.balanceCents, total) * 100}%`,
              background: SWATCHES[i % SWATCHES.length],
            }}
          />
        ))}
      </div>

      <div className="bd-fundlist">
        {funds.map((fund, i) => (
          <div className="bd-fund" key={fund.key}>
            <span
              className="bd-fund__dot"
              style={{ background: SWATCHES[i % SWATCHES.length] }}
              aria-hidden="true"
            />
            <span className="bd-fund__label">
              {fund.label}
              {/* Said here rather than stored on the fund: in the Feast report
                  the same fund is just "National Fund". */}
              {fund.isPassthrough && ' — to forward'}
            </span>
            <span className="bd-fund__amount">{formatMoney(fund.balanceCents)}</span>
          </div>
        ))}
      </div>

      {heldForOthers > 0 && (
        <p className="bd-note">
          {formatMoney(heldForOthers)} belongs to other funds. Forward it before the
          books close.
        </p>
      )}
    </section>
  )
}
