/**
 * Authentication service: issues device tokens (pairing / loopback), resolves tokens to
 * devices on every request, and revokes devices.
 *
 * Token lookups hit an in-memory cache (hash → device) so the hot path — every API request,
 * media range request and WebSocket — costs one SHA-256 and a Map lookup. `last_seen_at` is
 * written at most once a minute per device.
 */
import { newId } from '@reelforge/core'
import type { DeviceRecord, SqliteStore } from '../db/store.ts'
import { generateToken, hashToken, isTokenShaped } from './tokens.ts'
import { PairingCodes, type PairingOptions } from './pairing.ts'

export { PairingCodes, PairingRateLimitedError, RateLimiter } from './pairing.ts'
export * from './tokens.ts'

const TOUCH_INTERVAL_MS = 60_000
const CACHE_LIMIT = 1_000

export interface IssuedToken {
  token: string
  deviceId: string
  device: DeviceRecord
}

export class AuthService {
  readonly pairing: PairingCodes
  readonly #store: SqliteStore
  readonly #now: () => number
  /** base64 hash → device (or null for a known-bad token, to absorb repeated bad requests). */
  readonly #cache = new Map<string, DeviceRecord | null>()
  readonly #touched = new Map<string, number>()
  readonly #revokeListeners = new Set<(deviceId: string) => void>()

  constructor(store: SqliteStore, opts: PairingOptions = {}) {
    this.#store = store
    this.#now = opts.now ?? Date.now
    this.pairing = new PairingCodes(opts)
  }

  /** Creates a device and returns its (only ever shown once) token. */
  issue(deviceName: string, userAgent?: string): IssuedToken {
    const token = generateToken()
    const name = deviceName.trim().slice(0, 100) || 'Device'
    const device = this.#store.insertDevice({
      id: newId('d'),
      name,
      tokenHash: hashToken(token),
      ...(userAgent ? { userAgent: userAgent.slice(0, 300) } : {}),
      createdAt: new Date(this.#now()).toISOString(),
    })
    this.#cache.clear() // drop cached negative entries
    return { token, deviceId: device.id, device }
  }

  /** Pairs a new device with the rotating code. Returns undefined for a wrong code. */
  pair(
    code: string,
    deviceName: string,
    client: string,
    userAgent?: string,
  ): IssuedToken | undefined {
    if (!this.pairing.consume(code, client)) return undefined
    return this.issue(deviceName, userAgent)
  }

  /** Resolves a token to its device (undefined if unknown or revoked). */
  authenticate(token: string | undefined): DeviceRecord | undefined {
    if (!token || !isTokenShaped(token)) return undefined
    const hash = hashToken(token)
    const key = hash.toString('base64')
    let device = this.#cache.get(key)
    if (device === undefined) {
      device = this.#store.deviceByTokenHash(hash) ?? null
      if (this.#cache.size >= CACHE_LIMIT) this.#cache.clear()
      this.#cache.set(key, device)
    }
    if (!device) return undefined
    const now = this.#now()
    if (now - (this.#touched.get(device.id) ?? 0) >= TOUCH_INTERVAL_MS) {
      this.#touched.set(device.id, now)
      device.lastSeenAt = new Date(now).toISOString()
      this.#store.touchDevice(device.id, device.lastSeenAt)
    }
    return device
  }

  listDevices(): DeviceRecord[] {
    return this.#store.listDevices()
  }

  /** Revokes a device; its token stops working immediately and listeners (WS) are told. */
  revoke(deviceId: string): boolean {
    const removed = this.#store.deleteDevice(deviceId)
    if (!removed) return false
    this.#cache.clear()
    this.#touched.delete(deviceId)
    for (const listener of this.#revokeListeners) listener(deviceId)
    return true
  }

  /** Subscribes to revocations (used to close the device's open WebSockets). */
  onRevoke(listener: (deviceId: string) => void): () => void {
    this.#revokeListeners.add(listener)
    return () => this.#revokeListeners.delete(listener)
  }
}

/**
 * True when the request comes from this machine and was not relayed by a proxy. A local
 * reverse proxy (or Tailscale Serve/Funnel) connects from loopback on behalf of remote
 * clients and adds forwarding headers, so their presence disqualifies the request.
 */
export const isLoopbackRequest = (
  remoteAddress: string | undefined,
  headers: Record<string, string | string[] | undefined>,
): boolean => {
  if (headers['x-forwarded-for'] !== undefined || headers.forwarded !== undefined) return false
  if (headers['x-real-ip'] !== undefined) return false
  if (!remoteAddress) return false
  const addr = remoteAddress.startsWith('::ffff:') ? remoteAddress.slice(7) : remoteAddress
  return addr === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr)
}
