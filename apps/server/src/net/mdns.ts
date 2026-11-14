/**
 * Optional mDNS responder (MDNS=1) so phones on the LAN can open `https://reelforge.local:8443`
 * instead of typing an IP address. Only answers A queries for that one name; the host's own
 * `<hostname>.local` is already advertised by the OS (Windows 10+, macOS, Avahi on Linux).
 *
 * Answers prefer the addresses on the querier's subnet, so a phone on Wi-Fi never gets the
 * Hyper-V/WSL or Tailscale address it cannot reach.
 */
import os from 'node:os'
import type { RemoteInfo } from 'node:dgram'
import makeMdns from 'multicast-dns'
import type { Logger } from '../contracts.ts'
import { isTailscaleIp } from './interfaces.ts'

export const MDNS_NAME = 'reelforge.local'
const MDNS_PORT = 5353
/** Seconds; RFC 6762 recommends 120 s for records tied to a host address. */
const TTL = 120

export interface InterfaceAddress {
  address: string
  netmask: string
}

/** Non-internal IPv4 addresses with netmasks (link-local and Tailscale excluded). */
export const lanInterfaceAddresses = (
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): InterfaceAddress[] =>
  Object.values(interfaces)
    .flatMap((infos) => infos ?? [])
    .filter(
      (i) =>
        i.family === 'IPv4' &&
        !i.internal &&
        !i.address.startsWith('169.254.') &&
        !isTailscaleIp(i.address),
    )
    .map((i) => ({ address: i.address, netmask: i.netmask }))

const ipv4ToInt = (ip: string): number =>
  ip.split('.').reduce((acc, octet) => ((acc << 8) | (Number(octet) & 255)) >>> 0, 0)

/** Whether `a` and `b` are in the same IPv4 subnet under `netmask`. */
export const sameSubnet = (a: string, b: string, netmask: string): boolean => {
  const mask = ipv4ToInt(netmask)
  return (ipv4ToInt(a) & mask) >>> 0 === (ipv4ToInt(b) & mask) >>> 0
}

/**
 * Addresses to answer with for a query from `from`: those on the querier's subnet, or every
 * LAN address when none matches (e.g. the query was relayed).
 */
export const answerAddresses = (from: string, addrs: readonly InterfaceAddress[]): string[] => {
  const local = addrs.filter((a) => sameSubnet(a.address, from, a.netmask))
  return (local.length > 0 ? local : addrs).map((a) => a.address)
}

/** Whether a question asks for an A record of `name` (case-insensitive, ANY included). */
const asksFor = (q: { name: string; type: string }, name: string): boolean =>
  q.name.toLowerCase() === name && (q.type === 'A' || q.type === 'ANY')

export interface MdnsResponder {
  stop(): Promise<void>
}

export interface MdnsOptions {
  log: Logger
  name?: string
  addresses?: () => InterfaceAddress[]
  /** Test seam: a multicast-dns compatible instance. */
  mdns?: makeMdns.MulticastDNS
}

/** Starts answering `reelforge.local` queries. Failures (port 5353 busy) are logged, not thrown. */
export const startMdns = (opts: MdnsOptions): MdnsResponder => {
  const name = (opts.name ?? MDNS_NAME).toLowerCase()
  const addresses = opts.addresses ?? (() => lanInterfaceAddresses())
  const mdns = opts.mdns ?? makeMdns()
  const done = (err: Error | null): void => {
    if (err) opts.log.debug({ err }, 'mDNS response failed')
  }

  mdns.on('error', (err: Error) => opts.log.warn({ err }, 'mDNS responder error'))
  mdns.on('query', (query: makeMdns.QueryPacket, rinfo: RemoteInfo) => {
    const questions = query.questions.filter((q) => asksFor(q, name))
    if (questions.length === 0) return
    const answers = answerAddresses(rinfo.address, addresses()).map((data) => ({
      name,
      type: 'A' as const,
      class: 'IN' as const,
      ttl: TTL,
      // Cache-flush bit: we are the only owner of this name.
      flush: true,
      data,
    }))
    if (answers.length === 0) return
    // Legacy unicast resolvers (source port ≠ 5353) expect a direct reply echoing the question.
    if (rinfo.port !== MDNS_PORT)
      mdns.respond(
        { id: query.id, questions, answers },
        { port: rinfo.port, address: rinfo.address },
        done,
      )
    else mdns.respond({ answers }, done)
  })
  opts.log.info({ name }, 'mDNS responder started')

  return {
    stop: () => new Promise<void>((resolve) => mdns.destroy(resolve)),
  }
}
