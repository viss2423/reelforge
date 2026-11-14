/** Host network identity, Tailscale parsing, the plain-HTTP landing app and the mDNS responder. */
import { EventEmitter } from 'node:events'
import type { RemoteInfo } from 'node:dgram'
import type os from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  hostAddresses,
  httpsUrls,
  isTailscaleIp,
  primaryLanAddress,
} from '../../src/net/interfaces.ts'
import { buildLandingApp, landingPage } from '../../src/net/landing.ts'
import {
  answerAddresses,
  lanInterfaceAddresses,
  MDNS_NAME,
  sameSubnet,
  startMdns,
} from '../../src/net/mdns.ts'
import { parseTailscaleStatus } from '../../src/net/tailscale.ts'
import { log } from '../helpers.ts'

const iface = (
  address: string,
  extra: Partial<os.NetworkInterfaceInfo> = {},
): os.NetworkInterfaceInfo =>
  ({
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: `${address}/24`,
    ...extra,
  }) as os.NetworkInterfaceInfo

const INTERFACES: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {
  'vEthernet (WSL)': [iface('172.20.0.1', { netmask: '255.255.240.0' })],
  Tailscale: [iface('100.101.1.2', { netmask: '255.255.255.255' })],
  'Wi-Fi': [
    iface('192.168.1.23'),
    iface('fe80::1', { family: 'IPv6', netmask: 'ffff:ffff:ffff:ffff::' }),
  ],
  Loopback: [iface('127.0.0.1', { internal: true, netmask: '255.0.0.0' })],
  Ethernet: [iface('169.254.10.10', { netmask: '255.255.0.0' })],
}

describe('host addresses', () => {
  it('recognises the Tailscale CGNAT range', () => {
    expect(isTailscaleIp('100.64.0.1')).toBe(true)
    expect(isTailscaleIp('100.127.255.254')).toBe(true)
    expect(isTailscaleIp('100.63.0.1')).toBe(false)
    expect(isTailscaleIp('100.128.0.1')).toBe(false)
    expect(isTailscaleIp('10.0.0.1')).toBe(false)
  })

  it('ranks real LAN first, then Tailscale, then virtual adapters; drops loopback/link-local/IPv6', () => {
    const addrs = hostAddresses(INTERFACES)
    expect(addrs).toEqual([
      { address: '192.168.1.23', interface: 'Wi-Fi', tailscale: false },
      { address: '100.101.1.2', interface: 'Tailscale', tailscale: true },
      { address: '172.20.0.1', interface: 'vEthernet (WSL)', tailscale: false },
    ])
    expect(primaryLanAddress(addrs)).toBe('192.168.1.23')
    expect(primaryLanAddress(addrs.filter((a) => a.tailscale))).toBe('100.101.1.2')
    expect(primaryLanAddress([])).toBeUndefined()
    expect(httpsUrls(8443, addrs)[0]).toBe('https://192.168.1.23:8443')
    expect(httpsUrls(443, addrs)[0]).toBe('https://192.168.1.23')
  })
})

describe('tailscale status', () => {
  it('parses a running node with MagicDNS', () => {
    const status = parseTailscaleStatus(
      JSON.stringify({
        BackendState: 'Running',
        Self: { DNSName: 'Laptop.tail1234.ts.net.', TailscaleIPs: ['100.101.1.2', 'fd7a::1'] },
        CurrentTailnet: { Name: 'me@example.com' },
      }),
    )
    expect(status).toEqual({
      installed: true,
      running: true,
      dnsName: 'laptop.tail1234.ts.net',
      ips: ['100.101.1.2'],
      tailnet: 'me@example.com',
    })
  })

  it('parses a stopped node and rejects non-JSON', () => {
    expect(parseTailscaleStatus('{"BackendState":"Stopped","CurrentTailnet":null}')).toEqual({
      installed: true,
      running: false,
      ips: [],
    })
    expect(() => parseTailscaleStatus('not json')).toThrow(SyntaxError)
  })
})

describe('landing app (plain HTTP)', () => {
  const ca = Buffer.from([0x30, 0x82, 0x01, 0x0a])
  const app = buildLandingApp({
    httpsPort: 8443,
    caDer: () => ca,
    fallbackHost: () => '192.168.1.23',
    log,
  })
  afterAll(() => app.close())

  it('renders the pairing page with a QR to the HTTPS app and the pairing code', async () => {
    const res = await app.inject({ url: '/pair?code=123456', headers: { host: 'laptop.local' } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['content-security-policy']).toContain("default-src 'self'")
    expect(res.headers['strict-transport-security']).toBeUndefined()
    expect(res.body).toContain('href="https://laptop.local:8443/pair?code=123456"')
    expect(res.body).toContain('<svg')
    expect(res.body).toContain('/ca.crt')
  })

  it('ignores malformed codes and falls back on hostile Host headers', async () => {
    const res = await app.inject({
      url: '/?code=<script>',
      headers: { host: '"><script>alert(1)</script>' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain('<script>')
    expect(res.body).toContain('href="https://192.168.1.23:8443/"')
  })

  it('serves the CA certificate as a download', async () => {
    const res = await app.inject({ url: '/ca.crt' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/x-x509-ca-cert')
    expect(res.headers['content-disposition']).toContain('reelforge-ca.crt')
    expect(res.rawPayload.equals(ca)).toBe(true)
  })

  it('redirects everything else to HTTPS with 308, keeping path and query (IPv6 too)', async () => {
    const v4 = await app.inject({ url: '/api/projects?x=1', headers: { host: '10.0.0.5:8080' } })
    expect(v4.statusCode).toBe(308)
    expect(v4.headers.location).toBe('https://10.0.0.5:8443/api/projects?x=1')
    const v6 = await app.inject({ url: '/editor', headers: { host: '[fd00::5]:8080' } })
    expect(v6.headers.location).toBe('https://[fd00::5]:8443/editor')
  })

  it('escapes everything it interpolates', () => {
    const html = landingPage({ appUrl: 'https://x/"<b>', qrSvg: '<svg/>' })
    expect(html).toContain('https://x/&#34;&#60;b&#62;')
    expect(html).not.toContain('"<b>')
  })
})

describe('mDNS responder', () => {
  it('computes subnets and prefers addresses on the querier subnet', () => {
    expect(sameSubnet('192.168.1.23', '192.168.1.200', '255.255.255.0')).toBe(true)
    expect(sameSubnet('192.168.1.23', '192.168.2.1', '255.255.255.0')).toBe(false)
    expect(sameSubnet('172.20.0.1', '172.20.15.9', '255.255.240.0')).toBe(true)
    const lan = lanInterfaceAddresses(INTERFACES)
    expect(lan.map((a) => a.address)).toEqual(['172.20.0.1', '192.168.1.23'])
    expect(answerAddresses('192.168.1.77', lan)).toEqual(['192.168.1.23'])
    expect(answerAddresses('10.9.9.9', lan)).toEqual(['172.20.0.1', '192.168.1.23'])
  })

  class FakeMdns extends EventEmitter {
    readonly sent: Array<{ packet: unknown; rinfo?: unknown }> = []
    destroyed = false
    respond(packet: unknown, rinfoOrCb?: unknown, cb?: (err: Error | null) => void): void {
      const rinfo = typeof rinfoOrCb === 'function' ? undefined : rinfoOrCb
      this.sent.push(rinfo ? { packet, rinfo } : { packet })
      const done = typeof rinfoOrCb === 'function' ? rinfoOrCb : cb
      ;(done as ((err: Error | null) => void) | undefined)?.(null)
    }
    destroy(cb?: () => void): void {
      this.destroyed = true
      cb?.()
    }
  }

  const query = (name: string, type = 'A'): unknown => ({
    id: 7,
    type: 'query',
    questions: [{ name, type, class: 'IN' }],
  })
  const from = (address: string, port = 5353): RemoteInfo => ({
    address,
    port,
    family: 'IPv4',
    size: 40,
  })

  let fake: FakeMdns
  let responder: ReturnType<typeof startMdns>
  beforeAll(() => {
    fake = new FakeMdns()
    responder = startMdns({
      log,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- structural test double
      mdns: fake as unknown as NonNullable<Parameters<typeof startMdns>[0]['mdns']>,
      addresses: () => lanInterfaceAddresses(INTERFACES),
    })
  })

  it('answers A/ANY queries for reelforge.local (case-insensitive) by multicast', () => {
    fake.emit('query', query('ReelForge.local'), from('192.168.1.77'))
    fake.emit('query', query(MDNS_NAME, 'ANY'), from('192.168.1.77'))
    expect(fake.sent).toHaveLength(2)
    expect(fake.sent[0]).toEqual({
      packet: {
        answers: [
          { name: MDNS_NAME, type: 'A', class: 'IN', ttl: 120, flush: true, data: '192.168.1.23' },
        ],
      },
    })
  })

  it('ignores other names and record types', () => {
    fake.sent.length = 0
    fake.emit('query', query('other.local'), from('192.168.1.77'))
    fake.emit('query', query(MDNS_NAME, 'AAAA'), from('192.168.1.77'))
    expect(fake.sent).toHaveLength(0)
  })

  it('replies directly to legacy unicast resolvers, echoing id and question', () => {
    fake.sent.length = 0
    fake.emit('query', query(MDNS_NAME), from('192.168.1.77', 50_000))
    expect(fake.sent[0]).toMatchObject({
      packet: { id: 7, questions: [{ name: MDNS_NAME, type: 'A' }] },
      rinfo: { port: 50_000, address: '192.168.1.77' },
    })
  })

  it('stops cleanly', async () => {
    await responder.stop()
    expect(fake.destroyed).toBe(true)
  })
})
