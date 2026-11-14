/**
 * Tailscale detection (`tailscale status --json`) for remote access away from home. The
 * result is cached briefly because /api/system may be polled by the settings screen.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { run } from '../media/ffmpeg.ts'
import { whichSync } from '../toolchain.ts'

export interface TailscaleStatus {
  installed: boolean
  running: boolean
  /** MagicDNS name without the trailing dot, e.g. "laptop.tail1234.ts.net". */
  dnsName?: string
  ips: string[]
  tailnet?: string
}

interface StatusJson {
  BackendState?: string
  Self?: { DNSName?: string; TailscaleIPs?: string[]; Online?: boolean }
  CurrentTailnet?: { Name?: string } | null
}

/** Parses `tailscale status --json`. Pure. */
export const parseTailscaleStatus = (text: string): TailscaleStatus => {
  const json = JSON.parse(text) as StatusJson
  const status: TailscaleStatus = {
    installed: true,
    running: json.BackendState === 'Running',
    ips: (json.Self?.TailscaleIPs ?? []).filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip)),
  }
  const dns = json.Self?.DNSName?.replace(/\.$/, '')
  if (dns) status.dnsName = dns.toLowerCase()
  if (json.CurrentTailnet?.Name) status.tailnet = json.CurrentTailnet.Name
  return status
}

const locate = (env: NodeJS.ProcessEnv): string | undefined => {
  const found = whichSync('tailscale', env)
  if (found) return found
  if (process.platform === 'win32') {
    const p = path.join(env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe')
    if (existsSync(p)) return p
  }
  if (process.platform === 'darwin') {
    const p = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
    if (existsSync(p)) return p
  }
  return undefined
}

const CACHE_MS = 30_000
let cached: { at: number; value: Promise<TailscaleStatus> } | undefined

/** Detects Tailscale; never throws (absent / stopped → `installed: false` / `running: false`). */
export const detectTailscale = (env: NodeJS.ProcessEnv = process.env): Promise<TailscaleStatus> => {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value
  const value = (async (): Promise<TailscaleStatus> => {
    const bin = locate(env)
    if (!bin) return { installed: false, running: false, ips: [] }
    try {
      const { stdout } = await run(bin, ['status', '--json'], {
        captureStdout: true,
        timeoutMs: 3_000,
      })
      return parseTailscaleStatus(stdout.toString('utf8'))
    } catch {
      // Installed but logged out / daemon stopped: `status` exits non-zero.
      return { installed: true, running: false, ips: [] }
    }
  })()
  cached = { at: Date.now(), value }
  return value
}
