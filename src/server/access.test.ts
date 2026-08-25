import { beforeEach, describe, expect, it } from 'vitest'
import {
  AccessError,
  forgetAccessKeys,
  issuerFor,
  verifyAccessJwt,
  type CertFetcher,
} from './access'

const TEAM = 'riverbend'
const AUD = 'a'.repeat(64)
const ISSUER = 'https://riverbend.cloudflareaccess.com'
const NOW = 1_800_000_000

/**
 * A real RSA keypair, and real signatures over real tokens.
 *
 * Nothing here is stubbed except the network. The point of the module is that
 * a forged token does not verify, and only genuine crypto can demonstrate it.
 */
async function makeSigner(kid = 'key-1') {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair

  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const publicJwk = { ...jwk, kid, alg: 'RS256', use: 'sig' }

  const sign = async (
    payload: Record<string, unknown>,
    header: Record<string, unknown> = {},
  ) => {
    const h = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT', ...header }))
    const p = b64url(JSON.stringify(payload))
    const data = new TextEncoder().encode(`${h}.${p}`)
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, data)
    return `${h}.${p}.${b64urlBytes(new Uint8Array(sig))}`
  }

  return { publicJwk, sign }
}

function b64url(text: string): string {
  return b64urlBytes(new TextEncoder().encode(text))
}

function b64urlBytes(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const goodPayload = {
  aud: AUD,
  iss: ISSUER,
  sub: 'subject-abc',
  email: 'treasurer@riverbend.example',
  exp: NOW + 3600,
  nbf: NOW - 60,
}

describe('naming the team', () => {
  it('accepts a bare team name or a full domain', () => {
    expect(issuerFor('riverbend')).toBe(ISSUER)
    expect(issuerFor('riverbend.cloudflareaccess.com')).toBe(ISSUER)
    expect(issuerFor('https://riverbend.cloudflareaccess.com/')).toBe(ISSUER)
  })
})

describe('a token Access really signed', () => {
  beforeEach(() => forgetAccessKeys())

  it('verifies, and yields the identity from the payload', async () => {
    const { publicJwk, sign } = await makeSigner()
    const fetcher: CertFetcher = async () => ({ keys: [publicJwk] })

    const identity = await verifyAccessJwt(
      await sign(goodPayload),
      { teamDomain: TEAM, aud: AUD },
      NOW,
      fetcher,
    )
    expect(identity.email).toBe('treasurer@riverbend.example')
    expect(identity.subject).toBe('subject-abc')
    expect(identity.expiresAt).toBe(NOW + 3600)
  })

  it('fetches the keys once and then uses the cache', async () => {
    const { publicJwk, sign } = await makeSigner()
    let calls = 0
    const fetcher: CertFetcher = async () => {
      calls += 1
      return { keys: [publicJwk] }
    }
    const token = await sign(goodPayload)
    const config = { teamDomain: TEAM, aud: AUD }

    await verifyAccessJwt(token, config, NOW, fetcher)
    await verifyAccessJwt(token, config, NOW, fetcher)
    expect(calls).toBe(1)
  })

  it('re-fetches once when the key id is unknown, so rotation heals itself', async () => {
    const old = await makeSigner('old-key')
    const fresh = await makeSigner('new-key')

    let served = [old.publicJwk]
    let calls = 0
    const fetcher: CertFetcher = async () => {
      calls += 1
      return { keys: served }
    }
    const config = { teamDomain: TEAM, aud: AUD }

    // Warm the cache with the old key.
    await verifyAccessJwt(await old.sign(goodPayload), config, NOW, fetcher)
    expect(calls).toBe(1)

    // Access rotates. A token under the new key is not in the cache, so the
    // second attempt goes back to the endpoint rather than refusing.
    served = [fresh.publicJwk]
    const identity = await verifyAccessJwt(
      await fresh.sign(goodPayload), config, NOW, fetcher,
    )
    expect(identity.email).toBe('treasurer@riverbend.example')
    expect(calls).toBe(2)
  })
})

describe('a token Access did not sign', () => {
  beforeEach(() => forgetAccessKeys())

  const refuse = async (
    token: string,
    keys: JsonWebKey[],
    config = { teamDomain: TEAM, aud: AUD },
    now = NOW,
  ) =>
    expect(
      verifyAccessJwt(token, config, now, async () => ({ keys })),
    ).rejects.toThrow(AccessError)

  it('refuses one signed by the wrong key', async () => {
    // The attacker signs a perfectly well-formed token with their own key and
    // publishes nothing. This is the case the whole module exists for.
    const real = await makeSigner()
    const attacker = await makeSigner()
    await refuse(await attacker.sign(goodPayload), [real.publicJwk])
  })

  it('refuses "alg: none", and refuses a downgrade to HMAC', async () => {
    const { publicJwk, sign } = await makeSigner()
    // The algorithm is pinned rather than read from the token, so a header
    // claiming anything else is refused before a key is even looked up.
    await refuse(await sign(goodPayload, { alg: 'none' }), [publicJwk])
    await refuse(await sign(goodPayload, { alg: 'HS256' }), [publicJwk])
  })

  it('refuses one minted for another application of the same team', async () => {
    // Genuinely signed by Access — which is exactly why aud has to be checked.
    const { publicJwk, sign } = await makeSigner()
    await refuse(
      await sign({ ...goodPayload, aud: 'b'.repeat(64) }),
      [publicJwk],
    )
  })

  it('refuses one issued by a different team', async () => {
    const { publicJwk, sign } = await makeSigner()
    await refuse(
      await sign({ ...goodPayload, iss: 'https://elsewhere.cloudflareaccess.com' }),
      [publicJwk],
    )
  })

  it('refuses an expired token, and one not yet valid', async () => {
    const { publicJwk, sign } = await makeSigner()
    await refuse(await sign({ ...goodPayload, exp: NOW - 1 }), [publicJwk])
    await refuse(await sign({ ...goodPayload, nbf: NOW + 600 }), [publicJwk])
  })

  it('refuses a token with no expiry at all', async () => {
    const { publicJwk, sign } = await makeSigner()
    const { exp: _drop, ...noExpiry } = goodPayload
    await refuse(await sign(noExpiry), [publicJwk])
  })

  it('refuses a token carrying no email', async () => {
    const { publicJwk, sign } = await makeSigner()
    const { email: _drop, ...anonymous } = goodPayload
    await refuse(await sign(anonymous), [publicJwk])
  })

  it('refuses a tampered payload', async () => {
    // Same signature, one character changed in the claims.
    const { publicJwk, sign } = await makeSigner()
    const token = await sign(goodPayload)
    const [h, p, s] = token.split('.')
    const swapped = b64url(
      JSON.stringify({ ...goodPayload, email: 'someone.else@riverbend.example' }),
    )
    await refuse(`${h}.${swapped}.${s}`, [publicJwk])
    expect(p).not.toBe(swapped)
  })

  it('refuses a malformed token', async () => {
    const { publicJwk } = await makeSigner()
    for (const bad of ['', 'not-a-token', 'a.b', 'a.b.c.d']) {
      await refuse(bad, [publicJwk])
    }
  })
})

describe('when it cannot check', () => {
  beforeEach(() => forgetAccessKeys())

  it('refuses when Access is not configured at all', async () => {
    const { publicJwk, sign } = await makeSigner()
    const token = await sign(goodPayload)
    const fetcher: CertFetcher = async () => ({ keys: [publicJwk] })

    // The failure mode that matters most: a deployment where someone forgot
    // to set the variables must not become a deployment with no front door.
    await expect(
      verifyAccessJwt(token, { teamDomain: '', aud: AUD }, NOW, fetcher),
    ).rejects.toThrow(/not configured/)
    await expect(
      verifyAccessJwt(token, { teamDomain: TEAM, aud: '' }, NOW, fetcher),
    ).rejects.toThrow(/not configured/)
  })

  it('refuses when the key endpoint is unreachable', async () => {
    const { sign } = await makeSigner()
    await expect(
      verifyAccessJwt(await sign(goodPayload), { teamDomain: TEAM, aud: AUD }, NOW, async () => {
        throw new Error('network down')
      }),
    ).rejects.toThrow()
  })

  it('refuses when the team publishes no keys', async () => {
    const { sign } = await makeSigner()
    await expect(
      verifyAccessJwt(
        await sign(goodPayload),
        { teamDomain: TEAM, aud: AUD },
        NOW,
        async () => ({ keys: [] }),
      ),
    ).rejects.toThrow(/No signing keys/)
  })
})
