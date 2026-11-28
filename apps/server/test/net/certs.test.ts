import { X509Certificate } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CA_VALIDITY_DAYS,
  CertManager,
  coversSans,
  hostSans,
  LEAF_VALIDITY_DAYS,
  normalizeSans,
  type SanSet,
  type TlsMaterial,
} from '../../src/net/certs.ts'

const DAY = 86_400_000

/** Connects a TLS client that trusts only `ca` and reports whether the chain verified. */
const handshake = (
  material: TlsMaterial,
  servername: string,
): Promise<{ authorized: boolean; error?: string }> =>
  new Promise((resolve, reject) => {
    const server = tls.createServer({ key: material.key, cert: material.cert }, (s) => s.end())
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      const socket = tls.connect({
        port,
        host: '127.0.0.1',
        ca: material.ca,
        servername,
        rejectUnauthorized: false,
      })
      socket.once('secureConnect', () => {
        const out = socket.authorizationError
          ? { authorized: socket.authorized, error: String(socket.authorizationError) }
          : { authorized: socket.authorized }
        socket.destroy()
        server.close()
        resolve(out)
      })
      socket.once('error', (err) => {
        server.close()
        reject(err)
      })
    })
  })

describe('certificates', () => {
  let dir: string
  let sans: SanSet

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'rf-certs-'))
    sans = hostSans({ hostname: 'studio-pc', ips: ['192.168.1.20', '100.101.102.103'] })
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('creates a CA and a leaf with every SAN and correct validity', async () => {
    const manager = new CertManager({ dir, hostname: 'studio-pc', sans: () => sans })
    const t0 = performance.now()
    const material = await manager.init()
    const ms = performance.now() - t0
    expect(ms).toBeLessThan(2_000)

    const ca = new X509Certificate(material.ca)
    const leaf = new X509Certificate(material.cert)
    expect(ca.subject).toContain('CN=ReelForge Local CA (studio-pc)')
    expect(ca.ca).toBe(true)
    expect(leaf.ca).toBe(false)
    expect(leaf.checkIssued(ca)).toBe(true)
    expect(leaf.verify(ca.publicKey)).toBe(true)
    // Only the leaf is served: the root is already trusted by the client.
    expect(material.cert.match(/BEGIN CERTIFICATE/g)).toHaveLength(1)

    const san = leaf.subjectAltName ?? ''
    for (const name of ['localhost', 'studio-pc', 'studio-pc.local'])
      expect(san).toContain(`DNS:${name}`)
    for (const ip of ['127.0.0.1', '192.168.1.20', '100.101.102.103'])
      expect(san).toContain(`IP Address:${ip}`)
    expect(san).toMatch(/IP Address:0:0:0:0:0:0:0:1|IP Address:::1/)
    expect(leaf.keyUsage ?? []).toContain('1.3.6.1.5.5.7.3.1') // EKU serverAuth

    const leafDays = (Date.parse(leaf.validTo) - Date.parse(leaf.validFrom)) / DAY
    expect(leafDays).toBeLessThanOrEqual(LEAF_VALIDITY_DAYS + 1)
    expect(leafDays).toBeGreaterThan(LEAF_VALIDITY_DAYS - 2)
    const caDays = (Date.parse(ca.validTo) - Date.parse(ca.validFrom)) / DAY
    expect(caDays).toBeGreaterThan(CA_VALIDITY_DAYS - 2)
    expect(material.caDer.equals(ca.raw)).toBe(true)
  })

  it('chain verifies with node:tls for host names and rejects unknown names', async () => {
    const material = await new CertManager({ dir, hostname: 'studio-pc', sans: () => sans }).init()
    expect(await handshake(material, 'studio-pc.local')).toEqual({ authorized: true })
    expect(await handshake(material, 'localhost')).toEqual({ authorized: true })
    const bad = await handshake(material, 'evil.example')
    expect(bad.authorized).toBe(false)
    expect(bad.error).toMatch(/ALTNAME|altnames/i)
  })

  it('reuses persisted material across restarts and keeps the CA when the leaf changes', async () => {
    const first = await new CertManager({ dir, hostname: 'studio-pc', sans: () => sans }).init()
    const again = await new CertManager({ dir, hostname: 'studio-pc', sans: () => sans }).init()
    expect(again.cert).toBe(first.cert)
    expect(again.key).toBe(first.key)

    // A new Wi-Fi network → new LAN IP → new leaf, same CA (phones stay trusted).
    const moved = hostSans({ hostname: 'studio-pc', ips: ['10.0.0.7'] })
    const third = await new CertManager({ dir, hostname: 'studio-pc', sans: () => moved }).init()
    expect(third.ca).toBe(first.ca)
    expect(third.cert).not.toBe(first.cert)
    expect(new X509Certificate(third.cert).subjectAltName).toContain('IP Address:10.0.0.7')
    expect(await readFile(path.join(dir, 'ca.crt'), 'utf8')).toBe(first.ca)
  })

  it('refresh() re-issues only when SANs are no longer covered, and watch() hot-swaps', async () => {
    let current = sans
    const manager = new CertManager({ dir, hostname: 'studio-pc', sans: () => current })
    const initial = await manager.init()
    expect(await manager.refresh()).toBe(false)
    current = hostSans({ hostname: 'studio-pc', ips: ['192.168.1.20'] }) // subset: still covered
    expect(await manager.refresh()).toBe(false)
    current = hostSans({ hostname: 'studio-pc', ips: ['192.168.50.9'] })
    expect(await manager.refresh()).toBe(true)
    expect(manager.tls.cert).not.toBe(initial.cert)
    expect(await handshake(manager.tls, 'studio-pc')).toEqual({ authorized: true })

    current = hostSans({ hostname: 'studio-pc', ips: ['192.168.77.1'] })
    const swapped = await new Promise<TlsMaterial>((resolve) => manager.watch(20, resolve))
    manager.stop()
    expect(new X509Certificate(swapped.cert).subjectAltName).toContain('192.168.77.1')
  })

  it('re-issues a leaf that is about to expire', async () => {
    let now = new Date()
    const manager = new CertManager({ dir, hostname: 'h', sans: () => sans, now: () => now })
    const first = await manager.init()
    now = new Date(Date.now() + (LEAF_VALIDITY_DAYS - 10) * DAY)
    expect(await manager.refresh()).toBe(true)
    expect(manager.tls.cert).not.toBe(first.cert)
  })

  it('normalises SAN sets', () => {
    const n = normalizeSans({
      dns: ['Studio-PC', 'studio-pc', 'bad_name', 'host.ts.net.'],
      ips: ['127.0.0.1', '127.0.0.1', 'nope', '::1'],
    })
    expect(n).toEqual({ dns: ['host.ts.net', 'studio-pc'], ips: ['127.0.0.1', '::1'] })
    expect(coversSans(n, { dns: ['studio-pc'], ips: ['::1'] })).toBe(true)
    expect(coversSans(n, { dns: ['other'], ips: [] })).toBe(false)
  })
})
