/**
 * Cloudflare Access, verified.
 *
 * Access authenticates at the edge and forwards the result two ways: a plain
 * `Cf-Access-Authenticated-User-Email` header, and a signed JWT in
 * `Cf-Access-Jwt-Assertion`. Only the second is worth anything on its own. The
 * header is a string the origin is asked to believe, and anyone who can reach
 * the Worker without passing through Access can simply set it — which, on a
 * workers.dev URL, is everyone.
 *
 * So this module reads the token, checks the signature against the team's
 * published keys, and takes the identity from the verified payload. What that
 * buys is that reaching the Worker directly is no longer enough: without a
 * token Access itself signed, there is no identity and no request.
 *
 * It fails closed, everywhere. An unset configuration, an unreachable key
 * endpoint, an unknown key id, a bad signature, an expired token and a token
 * minted for a different application all end the same way — no identity. For
 * an application holding an Assembly's books that is the only safe direction
 * to fail in, and it is why there is no "allow if we cannot check" branch
 * anywhere below.
 *
 * Runtime-agnostic: Web Crypto and fetch, both of which Node 24 and the
 * Workers runtime have, so the tests exercise the same code the Worker runs.
 */

/** Access could not establish who is calling. The message is for the log. */
export class AccessError extends Error {}

export interface AccessConfig {
  /**
   * The team domain, with or without the suffix — "riverbend" and
   * "riverbend.cloudflareaccess.com" both work.
   */
  readonly teamDomain: string
  /** The Access application's AUD tag. A token for another app is refused. */
  readonly aud: string
}

export interface VerifiedIdentity {
  readonly email: string
  /** Access's own subject id. Stable per user, and not an email. */
  readonly subject: string
  /** Unix seconds. */
  readonly expiresAt: number
}

interface JwkSet {
  keys: JsonWebKey[]
}

/** How long a fetched key set is trusted before being fetched again. */
const CACHE_TTL_MS = 60 * 60 * 1000

/**
 * Fetched key sets, per team.
 *
 * A Workers isolate lives across many requests, so this saves a round trip on
 * nearly all of them. An unknown `kid` bypasses the cache once — that is how a
 * key rotation is picked up without waiting out the TTL.
 */
const cache = new Map<string, { keys: JsonWebKey[]; fetchedAt: number }>()

export type CertFetcher = (url: string) => Promise<JwkSet>

const fetchJson: CertFetcher = async (url) => {
  const response = await fetch(url)
  if (!response.ok) {
    throw new AccessError(`Access key endpoint answered ${response.status}`)
  }
  return (await response.json()) as JwkSet
}

/** "riverbend" and "riverbend.cloudflareaccess.com" both mean the same team. */
export function issuerFor(teamDomain: string): string {
  const bare = teamDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '')
  return bare.includes('.') ? `https://${bare}` : `https://${bare}.cloudflareaccess.com`
}

async function keysFor(
  teamDomain: string,
  fetcher: CertFetcher,
  now: number,
  force: boolean,
): Promise<JsonWebKey[]> {
  const issuer = issuerFor(teamDomain)
  const cached = cache.get(issuer)
  if (!force && cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.keys
  }

  const set = await fetcher(`${issuer}/cdn-cgi/access/certs`)
  const keys = set?.keys ?? []
  if (keys.length === 0) {
    throw new AccessError(`No signing keys published at ${issuer}`)
  }
  cache.set(issuer, { keys, fetchedAt: now })
  return keys
}

/** Exposed for tests; a Worker isolate is discarded rather than reset. */
export function forgetAccessKeys(): void {
  cache.clear()
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function decodeJson(segment: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)))
}

interface AccessPayload {
  aud?: string | string[]
  iss?: string
  sub?: string
  email?: string
  exp?: number
  nbf?: number
}

/**
 * Verify an Access token and return who it says is calling.
 *
 * Throws AccessError for every failure, including the ones that look like
 * configuration problems rather than attacks. The caller's only correct
 * response to any of them is to refuse the request.
 */
export async function verifyAccessJwt(
  token: string,
  config: AccessConfig,
  nowSeconds: number,
  fetcher: CertFetcher = fetchJson,
): Promise<VerifiedIdentity> {
  if (!config.teamDomain || !config.aud) {
    throw new AccessError(
      'Access is not configured: set ACCESS_TEAM_DOMAIN and ACCESS_AUD before serving.',
    )
  }

  const parts = token.split('.')
  if (parts.length !== 3) throw new AccessError('Malformed token')
  const [headerSegment, payloadSegment, signatureSegment] = parts

  const header = decodeJson(headerSegment) as { alg?: string; kid?: string }
  // Pinned, not read from the token. Accepting whatever `alg` says is how
  // "alg: none" and HMAC-with-the-public-key forgeries get in.
  if (header.alg !== 'RS256') {
    throw new AccessError(`Unexpected signing algorithm ${header.alg ?? 'none'}`)
  }
  if (!header.kid) throw new AccessError('Token names no signing key')

  const signed = new TextEncoder().encode(`${headerSegment}.${payloadSegment}`)
  const signature = base64UrlToBytes(signatureSegment)

  // Once against the cached keys; if the id is unknown, once more against a
  // fresh fetch, which is what makes a key rotation self-healing.
  let verified = await tryVerify(
    await keysFor(config.teamDomain, fetcher, nowSeconds * 1000, false),
    header.kid, signed, signature,
  )
  if (!verified) {
    verified = await tryVerify(
      await keysFor(config.teamDomain, fetcher, nowSeconds * 1000, true),
      header.kid, signed, signature,
    )
  }
  if (!verified) throw new AccessError('Signature does not verify')

  const payload = decodeJson(payloadSegment) as AccessPayload

  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  if (!audiences.includes(config.aud)) {
    // A token Access signed for a different application of the same team. The
    // signature is genuine, which is exactly why this has to be checked.
    throw new AccessError('Token was issued for a different application')
  }

  if (payload.iss !== issuerFor(config.teamDomain)) {
    throw new AccessError('Token was issued by a different team')
  }

  if (typeof payload.exp !== 'number' || payload.exp <= nowSeconds) {
    throw new AccessError('Token has expired')
  }
  if (typeof payload.nbf === 'number' && payload.nbf > nowSeconds) {
    throw new AccessError('Token is not valid yet')
  }

  if (!payload.email) throw new AccessError('Token carries no email')

  return {
    email: payload.email,
    subject: payload.sub ?? payload.email,
    expiresAt: payload.exp,
  }
}

async function tryVerify(
  keys: readonly JsonWebKey[],
  kid: string,
  signed: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  const jwk = keys.find((k) => (k as { kid?: string }).kid === kid)
  if (!jwk) return false

  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  return crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    signature as unknown as ArrayBuffer,
    signed as unknown as ArrayBuffer,
  )
}
