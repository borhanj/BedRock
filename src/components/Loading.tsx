/**
 * A quiet placeholder. No spinner: the data is local and arrives in
 * milliseconds, so an animation would flash rather than reassure.
 */
export default function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="bd-placeholder" role="status" aria-live="polite">
      <p className="bd-placeholder__body">{label}…</p>
    </div>
  )
}
