/**
 * Device tokens: 32 random bytes (256 bits) encoded base64url. Only the SHA-256 digest is
 * stored, so a leaked database cannot be replayed as credentials. SHA-256 (not a slow KDF) is
 * correct here: the input is uniformly random with 256 bits of entropy, so there is nothing
 * to brute-force, and verification must be cheap because it runs on every request.
 */
import { createHash, randomBytes } from 'node:crypto'

export const TOKEN_BYTES = 32
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

/** A fresh device token. */
export const generateToken = (): string => randomBytes(TOKEN_BYTES).toString('base64url')

/** Whether `token` has the shape of a device token (cheap pre-check before hashing). */
export const isTokenShaped = (token: string): boolean => TOKEN_RE.test(token)

/** SHA-256 digest of a token, as stored in `devices.token_hash`. */
export const hashToken = (token: string): Buffer => createHash('sha256').update(token).digest()

/** Cookie carrying the token so `<video src>` / `<img src>` requests are authenticated. */
export const TOKEN_COOKIE = 'rf_token'
/** Browsers cap cookie lifetime at 400 days. */
const COOKIE_MAX_AGE_S = 400 * 86_400

/** `Set-Cookie` value for a device token (HttpOnly, Secure, SameSite=Strict). */
export const tokenCookie = (token: string): string =>
  `${TOKEN_COOKIE}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; HttpOnly; Secure; SameSite=Strict`

/** `Set-Cookie` value that removes the token cookie. */
export const clearTokenCookie = (): string =>
  `${TOKEN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`

/** Extracts a cookie value from a `Cookie` header without allocating a full map. */
export const readCookie = (header: string | undefined, name: string): string | undefined => {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

/** Token from `Authorization: Bearer …` or the `rf_token` cookie (header wins). */
export const tokenFromRequest = (headers: {
  authorization?: string | undefined
  cookie?: string | undefined
}): string | undefined => {
  const auth = headers.authorization
  if (auth && auth.length > 7 && auth.slice(0, 7).toLowerCase() === 'bearer ')
    return auth.slice(7).trim()
  return readCookie(headers.cookie, TOKEN_COOKIE)
}
