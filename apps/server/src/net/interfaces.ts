/**
 * Network identity of the host: LAN IPv4 addresses, Tailscale addresses and host names.
 * Used for certificate SANs, the startup banner, pairing URLs and the QR code.
 */
import os from 'node:os'

export interface HostAddress {
  address: string
  interface: string
  /** 100.64.0.0/10 (CGNAT range used by Tailscale). */
  tailscale: boolean
}

/** Whether an IPv4 address is in Tailscale's 100.64.0.0/10 range. */
export const isTailscaleIp = (ip: string): boolean => {
  const m = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(ip)
  return m !== null && Number(m[1]) >= 64 && Number(m[1]) <= 127
}

const VIRTUAL_IF = /(vethernet|virtualbox|vmware|hyper-v|docker|wsl|vboxnet|br-|veth)/i
const isLinkLocal = (ip: string): boolean => ip.startsWith('169.254.')

/**
 * Non-internal IPv4 addresses, real LAN interfaces first (virtual adapters such as Hyper-V /
 * WSL / Docker last, since phones cannot reach them).
 */
export const hostAddresses = (
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): HostAddress[] => {
  const out: Array<HostAddress & { rank: number }> = []
  for (const [name, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal || isLinkLocal(info.address)) continue
      const tailscale = isTailscaleIp(info.address) || /tailscale/i.test(name)
      const rank = tailscale ? 1 : VIRTUAL_IF.test(name) ? 2 : 0
      out.push({ address: info.address, interface: name, tailscale, rank })
    }
  }
  out.sort((a, b) => a.rank - b.rank || a.address.localeCompare(b.address))
  return out.map(({ rank: _rank, ...rest }) => rest)
}

/** Primary LAN IPv4 (what the QR code points phones to), if any. */
export const primaryLanAddress = (
  addrs: readonly HostAddress[] = hostAddresses(),
): string | undefined => addrs.find((a) => !a.tailscale)?.address ?? addrs[0]?.address

/** Lower-cased host name, safe for DNS (Windows names may contain uppercase / underscores). */
export const hostName = (): string => os.hostname().toLowerCase()

/** `https://<host>:<port>` URLs for every reachable address (LAN first). */
export const httpsUrls = (
  port: number,
  addrs: readonly HostAddress[] = hostAddresses(),
): string[] => {
  const suffix = port === 443 ? '' : `:${port}`
  return addrs.map((a) => `https://${a.address}${suffix}`)
}
