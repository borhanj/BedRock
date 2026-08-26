import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchGettingStarted, type GettingStarted as Started } from '../data/api'

/**
 * What a new treasurer does next.
 *
 * A dashboard of zeroes and six nav items tells someone who has just opened
 * their books nothing about which one comes first. This card answers that, and
 * then gets out of the way: it disappears by itself once every step is done,
 * with no flag to set and nothing to remember.
 *
 * Every tick is read from the books rather than from a record of what has been
 * clicked, which is what makes it trustworthy — and also means a step can go
 * back to undone. Un-approving a budget really does leave that work undone, and
 * a stored "completed" flag would have quietly hidden it.
 *
 * It can be collapsed, and that choice is remembered in this browser only. A
 * treasurer part way through does not want to scroll past seven steps every
 * morning; a treasurer on a new laptop should see it again.
 */
const COLLAPSED_KEY = 'bedrock.getting-started.collapsed'

export default function GettingStarted() {
  const [started, setStarted] = useState<Started | null>(null)
  const [collapsed, setCollapsed] = useState(() => {
    // Wrapped, because reading storage throws outright in some contexts —
    // a private window with site data blocked, a thumbnail renderer — and a
    // convenience must never be able to take the dashboard down with it.
    try {
      return localStorage.getItem(COLLAPSED_KEY) === '1'
    } catch {
      return false
    }
  })

  useEffect(() => {
    let cancelled = false
    fetchGettingStarted()
      .then((next) => !cancelled && setStarted(next))
      // Silent: this card is help, and help that breaks the page it is helping
      // with is worse than no help. The dashboard below it is the real screen.
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const toggle = () => {
    const next = !collapsed
    setCollapsed(next)
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0')
    } catch {
      // Nothing to do. The card simply reappears expanded next time.
    }
  }

  if (!started || started.complete) return null

  const next = started.steps.find((s) => s.next)

  return (
    <section className="bd-card bd-card--wide bd-noprint">
      <div className="bd-card__head">
        <h2 className="bd-card__title">Getting started</h2>
        <p className="bd-card__hint">
          {started.doneCount} of {started.steps.length} done.
          {next && (
            <>
              {' '}
              Next: <Link to={next.href}>{next.title.toLowerCase()}</Link>.
            </>
          )}
        </p>
      </div>

      <div
        className="bd-progress"
        role="img"
        aria-label={`${started.doneCount} of ${started.steps.length} steps done`}
      >
        <span
          className="bd-progress__fill"
          style={{ width: `${(started.doneCount / started.steps.length) * 100}%` }}
        />
      </div>

      {!collapsed && (
        <ol className="bd-checks">
          {started.steps.map((step) => (
            <li
              key={step.key}
              className={
                step.done
                  ? 'bd-check'
                  : step.next
                    ? 'bd-check bd-check--gap'
                    : 'bd-check bd-tr--muted'
              }
            >
              <span className="bd-check__mark" aria-hidden="true">
                {step.done ? '✓' : step.next ? '→' : '·'}
              </span>
              <span className="bd-check__label">
                {step.done ? step.title : <Link to={step.href}>{step.title}</Link>}
                <span className="bd-check__detail">{step.detail}</span>
              </span>
              <span className="bd-check__verdict">{step.status ?? ''}</span>
            </li>
          ))}
        </ol>
      )}

      <div className="bd-actions">
        <button type="button" className="bd-btn bd-btn--ghost" onClick={toggle}>
          {collapsed ? 'Show the steps' : 'Hide the steps'}
        </button>
      </div>
    </section>
  )
}
