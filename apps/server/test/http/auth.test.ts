/** Health, auth hook, pairing (code, loopback, rate limit, cookie) and device management. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONTENT_SECURITY_POLICY } from '../../src/http/security.ts'
import { makeApp, REMOTE, type Harness } from './harness.ts'

describe('auth routes', () => {
  let h: Harness
  beforeEach(async () => {
    h = await makeApp()
  })
  afterEach(() => h.cleanup())

  it('GET /api/health is public and carries the security headers', async () => {
    const res = await h.app.inject({ url: '/api/health', remoteAddress: REMOTE })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, version: '0.1.0' })
    const csp = res.headers['content-security-policy'] as string
    expect(csp).toBe(CONTENT_SECURITY_POLICY)
    expect(csp).toContain("'wasm-unsafe-eval'")
    expect(csp).toContain('worker-src')
    expect(csp).toMatch(/worker-src[^;]*blob:/)
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['x-frame-options']).toBe('DENY')
    // No HSTS on the plain-HTTP test app (only sent over HTTPS).
    expect(res.headers['strict-transport-security']).toBeUndefined()
  })

  it('rejects protected routes without a valid token (header, cookie or encoded path)', async () => {
    for (const url of ['/api/projects', '/%61pi/projects', '/api/assets', '/api/devices']) {
      const res = await h.app.inject({ url, remoteAddress: REMOTE })
      expect({ url, status: res.statusCode }).toEqual({ url, status: 401 })
      expect(res.json()).toMatchObject({ error: { code: 'unauthorized' } })
      expect(res.headers['cache-control']).toBe('no-store')
    }
    const bad = await h.app.inject({
      url: '/api/projects',
      headers: { authorization: `Bearer ${'x'.repeat(43)}` },
    })
    expect(bad.statusCode).toBe(401)
    const malformed = await h.app.inject({
      url: '/api/projects',
      headers: { authorization: 'Bearer short' },
    })
    expect(malformed.statusCode).toBe(401)

    const bearer = await h.app.inject({ url: '/api/projects', headers: h.headers })
    expect(bearer.statusCode).toBe(200)
    const cookie = await h.app.inject({
      url: '/api/projects',
      headers: { cookie: `theme=dark; rf_token=${h.token}` },
    })
    expect(cookie.statusCode).toBe(200)
  })

  it('GET /api/pair/info is loopback-only and returns code, URLs and QR', async () => {
    const res = await h.app.inject({ url: '/api/pair/info' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.code).toMatch(/^\d{6}$/)
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now())
    expect(body.urls).toEqual([
      `https://192.168.1.10:8443/pair?code=${body.code}`,
      `https://localhost:8443/pair?code=${body.code}`,
    ])
    expect(body.qrSvg).toContain('<svg')
    expect(res.headers['cache-control']).toBe('no-store')

    const remote = await h.app.inject({ url: '/api/pair/info', remoteAddress: REMOTE })
    expect(remote.statusCode).toBe(403)
    expect(remote.json()).toMatchObject({ error: { code: 'loopback_only' } })
    const proxied = await h.app.inject({
      url: '/api/pair/info',
      headers: { 'x-forwarded-for': '203.0.113.9' },
    })
    expect(proxied.statusCode).toBe(403)
  })

  it('POST /api/pair pairs with the current code once and sets a strict cookie', async () => {
    const { code } = h.auth.pairing.current()
    const wrong = code === '000000' ? '111111' : '000000'
    const bad = await h.app.inject({
      method: 'POST',
      url: '/api/pair',
      remoteAddress: REMOTE,
      payload: { code: wrong, deviceName: 'Pixel' },
    })
    expect(bad.statusCode).toBe(401)
    expect(bad.json()).toMatchObject({ error: { code: 'invalid_code' } })

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/pair',
      remoteAddress: REMOTE,
      headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 16)' },
      payload: { code, deviceName: '  Pixel 10  ' },
    })
    expect(res.statusCode).toBe(200)
    const { token, deviceId } = res.json()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const cookie = res.headers['set-cookie'] as string
    expect(cookie).toContain(`rf_token=${token}`)
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/'])
      expect(cookie).toContain(attr)
    expect(h.auth.listDevices().find((d) => d.id === deviceId)).toMatchObject({
      name: 'Pixel 10',
      userAgent: 'Mozilla/5.0 (Linux; Android 16)',
    })
    // The token works, and the code was single-use.
    const ok = await h.app.inject({
      url: '/api/assets',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(ok.statusCode).toBe(200)
    expect(h.auth.pairing.current().code).not.toBe(code)
    const reuse = await h.app.inject({
      method: 'POST',
      url: '/api/pair',
      remoteAddress: '192.168.1.51',
      payload: { code, deviceName: 'Attacker' },
    })
    expect(reuse.statusCode).toBe(401)
  })

  it('validates the pairing body', async () => {
    for (const payload of [
      {},
      { code: '12345', deviceName: 'x' },
      { code: '123456', deviceName: '' },
    ]) {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/pair',
        remoteAddress: REMOTE,
        payload,
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({
        error: { code: 'invalid_request', details: expect.any(Array) },
      })
    }
    const notJson = await h.app.inject({
      method: 'POST',
      url: '/api/pair',
      remoteAddress: REMOTE,
      headers: { 'content-type': 'application/json' },
      payload: '{nope',
    })
    expect(notJson.statusCode).toBe(400)
    expect(notJson.json().error.code).toBeTypeOf('string')
  })

  it('rate-limits wrong codes per client address', async () => {
    const { code } = h.auth.pairing.current()
    const wrong = code === '999999' ? '999998' : '999999'
    const attempt = (remoteAddress: string, c = wrong) =>
      h.app.inject({
        method: 'POST',
        url: '/api/pair',
        remoteAddress,
        payload: { code: c, deviceName: 'x' },
      })
    for (let i = 0; i < 5; i++) expect((await attempt(REMOTE)).statusCode).toBe(401)
    const limited = await attempt(REMOTE, code)
    expect(limited.statusCode).toBe(429)
    expect(limited.json()).toMatchObject({ error: { code: 'rate_limited' } })
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
    // Another device on the LAN is unaffected and can pair with the right code.
    expect((await attempt('192.168.1.77', code)).statusCode).toBe(200)
  })

  it('POST /api/pair/local trusts loopback only (and never proxied requests)', async () => {
    const res = await h.app.inject({ method: 'POST', url: '/api/pair/local' })
    expect(res.statusCode).toBe(200)
    expect(res.json().token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(res.headers['set-cookie']).toContain('HttpOnly')
    expect(h.auth.listDevices().some((d) => d.name === 'This computer')).toBe(true)

    const named = await h.app.inject({
      method: 'POST',
      url: '/api/pair/local',
      remoteAddress: '::1',
      payload: { deviceName: 'Studio PC' },
    })
    expect(named.statusCode).toBe(200)
    expect(h.auth.listDevices().some((d) => d.name === 'Studio PC')).toBe(true)

    const remote = await h.app.inject({
      method: 'POST',
      url: '/api/pair/local',
      remoteAddress: REMOTE,
    })
    expect(remote.statusCode).toBe(403)
    for (const header of ['x-forwarded-for', 'forwarded', 'x-real-ip']) {
      const proxied = await h.app.inject({
        method: 'POST',
        url: '/api/pair/local',
        headers: { [header]: '203.0.113.9' },
      })
      expect({ header, status: proxied.statusCode }).toEqual({ header, status: 403 })
    }
  })

  it('lists and revokes devices; a revoked token stops working immediately', async () => {
    const other = h.auth.issue('Tablet')
    const list = await h.app.inject({ url: '/api/devices', headers: h.headers })
    expect(list.statusCode).toBe(200)
    const devices = list.json() as Array<Record<string, unknown>>
    expect(devices).toHaveLength(2)
    expect(devices.find((d) => d.id === h.deviceId)).toMatchObject({
      current: true,
      name: 'Test phone',
    })
    expect(devices.find((d) => d.id === other.deviceId)).toMatchObject({ current: false })
    expect(JSON.stringify(devices)).not.toMatch(/hash/i)

    const del = await h.app.inject({
      method: 'DELETE',
      url: `/api/devices/${other.deviceId}`,
      headers: h.headers,
    })
    expect(del.statusCode).toBe(204)
    expect(del.headers['set-cookie']).toBeUndefined()
    const revoked = await h.app.inject({
      url: '/api/devices',
      headers: { authorization: `Bearer ${other.token}` },
    })
    expect(revoked.statusCode).toBe(401)
    const missing = await h.app.inject({
      method: 'DELETE',
      url: '/api/devices/d_nope',
      headers: h.headers,
    })
    expect(missing.statusCode).toBe(404)

    // Revoking yourself also clears the cookie.
    const self = await h.app.inject({
      method: 'DELETE',
      url: `/api/devices/${h.deviceId}`,
      headers: h.headers,
    })
    expect(self.statusCode).toBe(204)
    expect(self.headers['set-cookie']).toContain('Max-Age=0')
    expect((await h.app.inject({ url: '/api/devices', headers: h.headers })).statusCode).toBe(401)
  })
})
