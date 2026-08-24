/**
 * Cloudflare Worker entry point.
 *
 * Serves the API from D1 and everything else from the static asset binding.
 * The request handling lives in src/server/api.ts and is shared with the dev
 * server, so this file is only wiring.
 */

import { handleApi } from './src/server/api'
import { openD1, type D1Database } from './src/server/db/d1'

export interface Env {
  DB: D1Database
  ASSETS: { fetch(request: Request): Promise<Response> }
  ASSEMBLY_ID?: string
}

/**
 * Who is making this request, according to Cloudflare Access.
 *
 * Access terminates authentication at the edge and forwards the verified
 * identity in these headers. `Cf-Access-Authenticated-User-Email` is
 * convenient but is only trustworthy when the origin cannot be reached
 * directly — anyone who can hit the Worker without passing through Access can
 * simply set the header themselves.
 *
 * BEFORE THIS IS EXPOSED: verify `Cf-Access-Jwt-Assertion` against the team's
 * public keys at https://<team>.cloudflareaccess.com/cdn-cgi/access/certs and
 * take the identity from the verified token, not from the plain header. The
 * Worker must also be locked to Access-only ingress. Until then this is
 * attribution for the audit log, not authentication.
 */
function identify(request: Request): string | null {
  const email = request.headers.get('Cf-Access-Authenticated-User-Email')
  return email && email.length > 0 ? email : null
}

/** Civil date in the Assembly's terms. UTC until Phase 6 makes it a setting. */
function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname.startsWith('/api/')) {
      const actor = identify(request)
      if (!actor) {
        return new Response(
          JSON.stringify({ error: 'Not signed in through Cloudflare Access.' }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        )
      }

      const response = await handleApi(request, {
        db: openD1(env.DB),
        assemblyId: env.ASSEMBLY_ID ?? 'riverbend',
        actor,
        today: todayISO(),
        now: new Date().toISOString(),
      })
      if (response) return response
    }

    return env.ASSETS.fetch(request)
  },
}
