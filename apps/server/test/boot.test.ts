import https from 'node:https'
import http from 'node:http'
import os from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { startServer, type ServerHandle } from '../src/server.ts'
import { log, realToolchain, tempDir } from './helpers.ts'

const tools = await realToolchain()
if (!tools) console.warn('[boot.test] FFmpeg not found on PATH — skipping boot smoke test')

const get = (
  url: string,
  opts: https.RequestOptions = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> =>
  new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http
    const req = mod.get(url, opts, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
  })

describe.skipIf(!tools)('boot smoke test', () => {
  let server: ServerHandle
  let cleanup: () => Promise<void>

  beforeAll(async () => {
    const tmp = await tempDir('rf-boot-')
    cleanup = tmp.cleanup
    const config = loadConfig({
      REELFORGE_DATA: tmp.dir,
      HTTP_PORT: '0',
      HTTPS_PORT: '0',
      SKIP_ENCODER_PROBE: '1',
      PACKS_URL: 'http://127.0.0.1:9/packs',
      FFMPEG_PATH: tools!.ffmpeg,
      LOG_PRETTY: '0',
      PATH: process.env.PATH,
    })
    const t0 = performance.now()
    server = await startServer(config, { log, syncPacks: false })
    console.info(`[boot.test] cold boot in ${Math.round(performance.now() - t0)} ms`)
  })

  afterAll(async () => {
    await server?.close()
    await cleanup?.()
  })

  it('serves /api/health over HTTPS trusted only via the generated CA', async () => {
    const agent = new https.Agent({ ca: server.caPem })
    const res = await get(`https://localhost:${server.httpsPort}/api/health`, { agent })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true, version: server.config.version })
    expect(res.headers['strict-transport-security']).toContain('max-age')
    await expect(
      get(`https://localhost:${server.httpsPort}/api/health`, { agent: new https.Agent() }),
    ).rejects.toThrow(/self[- ]signed|unable to verify|certificate/i)
    agent.destroy()
  })

  // The default host is dual stack: `localhost` may resolve to ::1 first.
  const hasIpv6 = Object.values(os.networkInterfaces()).some((list) =>
    list?.some((a) => a.family === 'IPv6' && a.internal),
  )
  it.each([['127.0.0.1'], ...(hasIpv6 ? [['[::1]']] : [])])(
    'answers on %s (IPv4 and IPv6 loopback)',
    async (host) => {
      const agent = new https.Agent({ rejectUnauthorized: false })
      const res = await get(`https://${host}:${server.httpsPort}/api/health`, { agent })
      expect(res.status).toBe(200)
      agent.destroy()
    },
  )

  it('rejects unauthenticated API calls and lets loopback pair', async () => {
    const agent = new https.Agent({ ca: server.caPem })
    expect(
      (await get(`https://localhost:${server.httpsPort}/api/projects`, { agent })).status,
    ).toBe(401)
    const token = server.auth.issue('boot-test').token
    const ok = await get(`https://localhost:${server.httpsPort}/api/projects`, {
      agent,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(ok.status).toBe(200)
    expect(JSON.parse(ok.body)).toEqual([])
    agent.destroy()
  })

  it('serves the landing page, CA and redirects on plain HTTP', async () => {
    const base = `http://127.0.0.1:${server.httpPort}`
    const page = await get(`${base}/`)
    expect(page.status).toBe(200)
    expect(page.body).toContain('Download certificate')
    const ca = await get(`${base}/ca.crt`)
    expect(ca.status).toBe(200)
    expect(ca.headers['content-type']).toBe('application/x-x509-ca-cert')
    const redirect = await get(`${base}/editor/abc?x=1`)
    expect(redirect.status).toBe(308)
    expect(redirect.headers.location).toBe(`https://127.0.0.1:${server.httpsPort}/editor/abc?x=1`)
  })
})
