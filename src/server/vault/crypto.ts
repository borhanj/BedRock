/**
 * Encryption for donor identity.
 *
 * WHAT THIS PROTECTS AGAINST, AND WHAT IT DOES NOT
 * ------------------------------------------------
 * §4 of the requirements asks that donor-level detail be protected "if the app
 * is ever used on a shared or Assembly-owned device". That is the threat model
 * here: someone who sits down at the treasurer's laptop, or an Assembly member
 * who has legitimate access to the app but not to who gave what.
 *
 * It is NOT protection against someone who obtains the database file. A PIN
 * has little entropy — six digits is a million guesses — and an attacker
 * holding the ciphertext can try them all offline no matter how many KDF
 * rounds we do. The iteration count below raises that cost; it does not remove
 * it. A treasurer who wants real resistance should use a passphrase, which is
 * why `MIN_SECRET_LENGTH` allows one and the UI does not restrict input to
 * digits.
 *
 * What the encryption does buy, unconditionally: donor names never sit in
 * plaintext in the database, in a backup, in an export, or in the audit log.
 * Every aggregate report is computed without them. Turning a donor_id back
 * into a person is a deliberate act that must be authorised and is recorded.
 *
 * AES-GCM is used so a wrong key fails loudly on the authentication tag rather
 * than returning plausible garbage.
 */

const KDF = 'PBKDF2'
const HASH = 'SHA-256'
const CIPHER = 'AES-GCM'
const KEY_BITS = 256
const IV_BYTES = 12

/**
 * PBKDF2 rounds. A compromise: high enough to make a PIN meaningfully more
 * expensive to attack, low enough that a Worker request stays well inside its
 * CPU budget. Stored per-vault so it can be raised later without stranding
 * existing records.
 */
export const DEFAULT_ITERATIONS = 150_000

/** Short enough for a PIN, long enough to discourage a 4-digit one. */
export const MIN_SECRET_LENGTH = 6

/** Proves a key is the right one without storing anything derived from it. */
const SENTINEL = 'bedrock-vault-v1'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Byte helpers are typed as Uint8Array<ArrayBuffer> rather than the default
 * Uint8Array<ArrayBufferLike>: WebCrypto's BufferSource excludes
 * SharedArrayBuffer, so the looser type will not satisfy it.
 */
function toBase64(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function randomSalt(bytes = 16): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(new ArrayBuffer(bytes))))
}

export class VaultError extends Error {}

/** Derive the field-encryption key from the treasurer's secret. */
export async function deriveKey(
  secret: string,
  saltBase64: string,
  iterations: number,
): Promise<CryptoKey> {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new VaultError(
      `The PIN must be at least ${MIN_SECRET_LENGTH} characters. A phrase you can ` +
        `remember is stronger than a short number.`,
    )
  }

  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    KDF,
    false,
    ['deriveKey'],
  )

  return crypto.subtle.deriveKey(
    { name: KDF, salt: fromBase64(saltBase64), iterations, hash: HASH },
    material,
    { name: CIPHER, length: KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * Encrypt one field. A fresh IV every time, so the same name encrypted twice
 * produces different ciphertext and the database reveals nothing by comparing
 * rows.
 */
export async function encryptField(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(IV_BYTES)))
  const sealed = await crypto.subtle.encrypt(
    { name: CIPHER, iv },
    key,
    encoder.encode(plaintext),
  )
  return `${toBase64(iv)}.${toBase64(new Uint8Array(sealed) as Uint8Array<ArrayBuffer>)}`
}

export async function decryptField(key: CryptoKey, stored: string): Promise<string> {
  const [ivPart, dataPart] = stored.split('.')
  if (!ivPart || !dataPart) {
    throw new VaultError('This record is not in the expected encrypted form.')
  }
  try {
    const opened = await crypto.subtle.decrypt(
      { name: CIPHER, iv: fromBase64(ivPart) },
      key,
      fromBase64(dataPart),
    )
    return decoder.decode(opened)
  } catch {
    // AES-GCM fails its authentication tag rather than returning plausible
    // nonsense, so a wrong PIN is indistinguishable from a corrupt record and
    // both are reported the same honest way.
    throw new VaultError('That PIN does not open the donor records.')
  }
}

/** The value stored so a later unlock can prove it has the right key. */
export async function makeVerifier(key: CryptoKey): Promise<string> {
  return encryptField(key, SENTINEL)
}

export async function checkVerifier(key: CryptoKey, verifier: string): Promise<boolean> {
  try {
    return (await decryptField(key, verifier)) === SENTINEL
  } catch {
    return false
  }
}
