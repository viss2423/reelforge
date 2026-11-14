/** Pairing codes, rate limiting, tokens/cookies, loopback detection and the AuthService cache. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AuthService,
  clearTokenCookie,
  generateToken,
  hashToken,
  isLoopbackRequest,
  isTokenShaped,
  PairingCodes,
  PairingRateLimitedError,
  RateLimiter,
  readCookie,
  tokenCookie,
  tokenFromRequest,
} from '../../src/auth/index.ts'
import { CODE_TTL_MS } from '../../src/auth/pairing.ts'
import { SqliteStore } from '../../src/db/store.ts'
import { tempData } from '../helpers.ts'

/** Manually advanced clock. */
const clock = (start = 1_800_000_000_000) => {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

describe('PairingCodes', () => {
  it('issues 6-digit codes that rotate after the TTL', () => {
    const c = clock()
    const codes = new PairingCodes({ now: c.now })
    const first = codes.current()
    expect(first.code).toMatch(/^\d{6}$/)
    expect(first.expiresAt).toBe(c.now() + CODE_TTL_MS)
    c.advance(CODE_TTL_MS - 1)
    expect(codes.current().code).toBe(first.code)
    c.advance(1)
    const second = codes.current()
    expect(second.expiresAt).toBe(c.now() + CODE_TTL_MS)
    // Codes are random; across many rotations they must not repeat systematically.
    const seen = new Set<string>()
    for (let i = 0; i < 50; i++) {
      codes.rotate()
      seen.add(codes.current().code)
    }
    expect(seen.size).toBeGreaterThan(45)
  })

  it('is single use and rejects expired codes', () => {
    const c = clock()
    const codes = new PairingCodes({ now: c.now })
    const { code } = codes.current()
    expect(codes.consume(code, 'a')).toBe(true)
    expect(codes.consume(code, 'b')).toBe(false)
    const next = codes.current().code
    c.advance(CODE_TTL_MS)
    expect(codes.consume(next, 'a')).toBe(false)
  })

  it('accepts a fixed test code repeatedly without consuming the rotating one', () => {
    const codes = new PairingCodes({ fixedCode: '246810', maxFailuresPerClient: 2 })
    const { code } = codes.current()
    for (let i = 0; i < 5; i++) expect(codes.consume('246810', `browser-${i}`)).toBe(true)
    expect(codes.current().code).toBe(code)
    expect(codes.consume(code, 'phone')).toBe(true)
    // Wrong guesses are still rate limited.
    const wrong = codes.current().code === '000000' ? '000001' : '000000'
    expect(codes.consume(wrong, 'x')).toBe(false)
    expect(codes.consume(wrong, 'x')).toBe(false)
    expect(() => codes.consume('246810', 'x')).toThrow(PairingRateLimitedError)
  })

  it('handles odd candidates without throwing', () => {
    const codes = new PairingCodes()
    for (const bad of ['', '1', '1234567', 'abcdef', 'x'.repeat(100), '٣٣٣٣٣٣'])
      expect(codes.consume(bad, `c-${bad.length}`)).toBe(false)
  })

  it('locks out a client after too many failures and rotates after global failures', () => {
    const c = clock()
    const codes = new PairingCodes({ now: c.now, maxFailuresPerClient: 3, maxFailuresPerCode: 5 })
    const { code } = codes.current()
    const wrong = code === '000000' ? '000001' : '000000'
    for (let i = 0; i < 3; i++) expect(codes.consume(wrong, 'attacker')).toBe(false)
    let limited: unknown
    try {
      codes.consume(code, 'attacker')
    } catch (err) {
      limited = err
    }
    expect(limited).toBeInstanceOf(PairingRateLimitedError)
    expect(limited).toMatchObject({ retryAfterMs: expect.any(Number) })
    expect((limited as PairingRateLimitedError).retryAfterMs).toBeGreaterThan(0)
    // Distributed guessing: 5 failures in total from different clients rotate the code.
    codes.consume(wrong, 'b1')
    codes.consume(wrong, 'b2')
    expect(codes.current().code).not.toBe(code)
    // The lock-out expires with the window.
    c.advance(CODE_TTL_MS + 1)
    expect(codes.consume(codes.current().code, 'attacker')).toBe(true)
  })
})

describe('RateLimiter', () => {
  it('uses a sliding window and resets on success', () => {
    const c = clock()
    const rl = new RateLimiter({ max: 2, windowMs: 1_000, now: c.now })
    rl.hit('k')
    c.advance(400)
    rl.hit('k')
    expect(rl.retryAfter('k')).toBe(600)
    c.advance(600)
    expect(rl.retryAfter('k')).toBe(0)
    rl.hit('k')
    expect(rl.retryAfter('k')).toBe(400)
    rl.reset('k')
    expect(rl.retryAfter('k')).toBe(0)
    expect(rl.retryAfter('other')).toBe(0)
  })

  it('bounds memory under a flood of distinct keys', () => {
    const c = clock()
    const rl = new RateLimiter({ max: 1, windowMs: 10, now: c.now })
    for (let i = 0; i < 10_050; i++) {
      rl.hit(`ip-${i}`)
      if (i === 5_000) c.advance(20)
    }
    expect(rl.retryAfter('ip-0')).toBe(0)
    expect(rl.retryAfter('ip-10049')).toBeGreaterThan(0)
  })
})

describe('tokens and cookies', () => {
  it('generates 256-bit base64url tokens and hashes them with SHA-256', () => {
    const a = generateToken()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(isTokenShaped(a)).toBe(true)
    expect(isTokenShaped(`${a}=`)).toBe(false)
    expect(generateToken()).not.toBe(a)
    expect(hashToken(a)).toHaveLength(32)
    expect(hashToken(a).equals(hashToken(a))).toBe(true)
  })

  it('builds strict cookies and reads tokens from headers', () => {
    expect(tokenCookie('abc')).toBe(
      'rf_token=abc; Path=/; Max-Age=34560000; HttpOnly; Secure; SameSite=Strict',
    )
    expect(clearTokenCookie()).toContain('Max-Age=0')
    expect(readCookie('a=1; rf_token=xyz; b=2', 'rf_token')).toBe('xyz')
    expect(readCookie('rf_tokenx=1', 'rf_token')).toBeUndefined()
    expect(readCookie(undefined, 'rf_token')).toBeUndefined()
    expect(tokenFromRequest({ authorization: 'Bearer tok', cookie: 'rf_token=c' })).toBe('tok')
    expect(tokenFromRequest({ authorization: 'bearer  tok ' })).toBe('tok')
    expect(tokenFromRequest({ authorization: 'Basic x', cookie: 'rf_token=c' })).toBe('c')
    expect(tokenFromRequest({})).toBeUndefined()
  })
})

describe('isLoopbackRequest', () => {
  it.each([
    ['127.0.0.1', {}, true],
    ['127.8.9.10', {}, true],
    ['::1', {}, true],
    ['::ffff:127.0.0.1', {}, true],
    ['192.168.1.2', {}, false],
    ['::ffff:10.0.0.1', {}, false],
    ['100.101.1.2', {}, false],
    [undefined, {}, false],
    ['127.0.0.1', { 'x-forwarded-for': '1.2.3.4' }, false],
    ['127.0.0.1', { forwarded: 'for=1.2.3.4' }, false],
    ['127.0.0.1', { 'x-real-ip': '1.2.3.4' }, false],
  ] as const)('%s %j → %s', (addr, headers, expected) => {
    expect(isLoopbackRequest(addr, headers)).toBe(expected)
  })
})

describe('AuthService', () => {
  let store: SqliteStore
  let cleanup: () => Promise<void>
  beforeEach(async () => {
    const d = await tempData()
    cleanup = d.cleanup
    store = new SqliteStore(d.paths.db)
  })
  afterEach(async () => {
    store.close()
    await cleanup()
  })

  it('stores only the token hash and authenticates through a cache', () => {
    const auth = new AuthService(store)
    const { token, deviceId } = auth.issue('  ', 'UA')
    const row = store.db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId) as Record<
      string,
      unknown
    >
    expect(JSON.stringify(row)).not.toContain(token)
    expect(Buffer.from(row.token_hash as Uint8Array).equals(hashToken(token))).toBe(true)
    expect(auth.authenticate(token)).toMatchObject({ id: deviceId, name: 'Device' })
    expect(auth.authenticate(undefined)).toBeUndefined()
    expect(auth.authenticate('nope')).toBeUndefined()
    expect(auth.authenticate(generateToken())).toBeUndefined()
  })

  it('throttles last-seen writes to once a minute', () => {
    const c = clock()
    const auth = new AuthService(store, { now: c.now })
    const { token, deviceId } = auth.issue('Phone')
    auth.authenticate(token)
    const first = store.listDevices().find((d) => d.id === deviceId)!.lastSeenAt
    c.advance(30_000)
    auth.authenticate(token)
    expect(store.listDevices().find((d) => d.id === deviceId)!.lastSeenAt).toBe(first)
    c.advance(30_000)
    auth.authenticate(token)
    expect(store.listDevices().find((d) => d.id === deviceId)!.lastSeenAt).not.toBe(first)
  })

  it('a token issued after a cached miss works (negative cache is invalidated)', () => {
    const auth = new AuthService(store)
    const token = generateToken()
    expect(auth.authenticate(token)).toBeUndefined()
    const issued = auth.issue('Phone')
    expect(auth.authenticate(issued.token)?.id).toBe(issued.deviceId)
  })

  it('revocation invalidates cached tokens and notifies listeners', () => {
    const auth = new AuthService(store)
    const { token, deviceId } = auth.issue('Phone')
    expect(auth.authenticate(token)).toBeDefined()
    const revoked: string[] = []
    const off = auth.onRevoke((id) => revoked.push(id))
    expect(auth.revoke(deviceId)).toBe(true)
    expect(auth.authenticate(token)).toBeUndefined()
    expect(auth.revoke(deviceId)).toBe(false)
    expect(revoked).toEqual([deviceId])
    off()
  })

  it('pair() issues a device only for the right code', () => {
    const auth = new AuthService(store)
    expect(
      auth.pair('000000' === auth.pairing.current().code ? '000001' : '000000', 'X', 'ip'),
    ).toBeUndefined()
    const ok = auth.pair(auth.pairing.current().code, 'Phone', 'ip', 'UA')
    expect(ok?.device).toMatchObject({ name: 'Phone', userAgent: 'UA' })
  })
})
