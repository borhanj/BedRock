import { Link } from 'react-router-dom'

/**
 * Shows the server's own message rather than a generic apology.
 *
 * The messages worth surfacing here are specific and actionable — a year
 * outside the Naw-Rúz table names the file to extend, a missing report says
 * when it will exist. Replacing those with "something went wrong" would throw
 * away the only useful part.
 */
export default function ErrorPanel({
  title = 'That did not load',
  message,
}: {
  title?: string
  message: string
}) {
  return (
    <div className="bd-placeholder" role="alert">
      <h1 className="bd-placeholder__title">{title}</h1>
      <p className="bd-placeholder__body">{message}</p>
      <p className="bd-placeholder__body">
        <Link to="/">Back to the year</Link>
      </p>
    </div>
  )
}
