/**
 * Cloudflare Worker entry point.
 *
 * Serves the API from D1 and everything else from the static asset binding.
 * The request handling lives in src/server/api.ts and is shared with the dev
 * server, so this file is only wiring — plus the one thing that cannot be
 * shared with the dev server, which is deciding who is calling.
 */

import { handleApi } from './src/server/api'
import { openD1, type D1Database } from './src/server/db/d1'
import { AccessError, verifyAccessJwt } from './src/server/access'

export interface Env {
  DB: D1Database
  ASSETS: { fetch(request: Request): Promise<Response> }
  ASSEMBLY_ID?: string
  /** The Access team, e.g. "riverbend" or "riverbend.cloudflareaccess.com". */
  ACCESS_TEAM_DOMAIN?: string
  /** The Access application's AUD tag. */
  ACCESS_AUD?: string
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

/**
 * Who is making this request, according to a token Access actually signed.
 *
 * Deliberately NOT the `Cf-Access-Authenticated-User-Email` header. That
 * header is a claim the origin is asked to believe, and on a public
 * workers.dev URL anyone can make it. The JWT in `Cf-Access-Jwt-Assertion`
 * carries the same identity with Access's signature over it, so forging one
 * means forging the signature.
 *
 * See src/server/access.ts for what is checked. Everything that goes wrong
 * ends here as null, and null ends the request.
 */
async function identify(request: Request, env: Env): Promise<string | null> {
  const token = request.headers.get('Cf-Access-Jwt-Assertion')
  if (!token) return null

  try {
    const identity = await verifyAccessJwt(
      token,
      {
        teamDomain: env.ACCESS_TEAM_DOMAIN ?? '',
        aud: env.ACCESS_AUD ?? '',
      },
      Math.floor(Date.now() / 1000),
    )
    return identity.email
  } catch (error) {
    // Logged, never returned. Telling a caller which check failed helps them
    // find the one that would pass.
    console.warn(
      'Access verification failed:',
      error instanceof AccessError ? error.message : error,
    )
    return null
  }
}

/** Civil date in the Assembly's terms. UTC until this becomes a setting. */
function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname.startsWith('/api/')) {
      // Said before any request is served rather than after one fails, and
      // 503 rather than 401: nothing is wrong with the caller, the deployment
      // is incomplete. Refusing outright is the point — an Assembly's books
      // must not be readable because a variable was never set.
      if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
        return json(
          {
            error:
              'This deployment has no Cloudflare Access configuration, so it cannot ' +
              'establish who is calling and will not serve the books. Set ' +
              'ACCESS_TEAM_DOMAIN and ACCESS_AUD, and put an Access policy in front.',
          },
          503,
        )
      }

      const actor = await identify(request, env)
      if (!actor) {
        return json(
          { error: 'Not signed in through Cloudflare Access.' },
          401,
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
