import { Link } from 'react-router-dom'

/**
 * A nav destination that exists in the design but not yet in the build.
 * Naming the phase is more useful to the reader than a blank screen.
 */
export default function Placeholder({ title, body }: { title: string; body: string }) {
  return (
    <div className="bd-placeholder">
      <h1 className="bd-placeholder__title">{title}</h1>
      <p className="bd-placeholder__body">{body}</p>
      <p className="bd-placeholder__body">
        <Link to="/">Back to the year</Link>
      </p>
    </div>
  )
}
