/**
 * Client-side session. The server sets an HttpOnly `rf_token` cookie on pairing (used by
 * `<video src>` and same-origin fetches); we also keep the token in localStorage so it can
 * be sent as `Authorization: Bearer` and as `?token=` on the WebSocket URL, which cannot
 * carry headers. `deviceId` identifies this device as the `origin` of project saves so it
 * can ignore its own live-sync echoes.
 */
const TOKEN_KEY = 'rf.token'
const DEVICE_KEY = 'rf.deviceId'

type Listener = () => void
const listeners = new Set<Listener>()

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const write = (key: string, value: string | null): void => {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // Storage disabled (private mode): the cookie still authenticates HTTP requests.
  }
}

let token = read(TOKEN_KEY)
let deviceId = read(DEVICE_KEY)

export const auth = {
  get token(): string | null {
    return token
  },
  /** Stable id of this device. Falls back to a random client id before pairing. */
  get deviceId(): string {
    if (!deviceId) {
      deviceId = `c_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
      write(DEVICE_KEY, deviceId)
    }
    return deviceId
  },
  setSession(session: { token: string; deviceId: string }): void {
    token = session.token
    deviceId = session.deviceId
    write(TOKEN_KEY, token)
    write(DEVICE_KEY, deviceId)
    for (const l of listeners) l()
  },
  /** Drops the token (e.g. after a 401 or revocation). Keeps the device id. */
  clear(): void {
    if (token === null) return
    token = null
    write(TOKEN_KEY, null)
    for (const l of listeners) l()
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  /** Re-read storage (tests, or another tab paired). */
  reload(): void {
    token = read(TOKEN_KEY)
    deviceId = read(DEVICE_KEY)
  },
}

/** Human device name sent when pairing, e.g. "Android · Chrome". */
export const describeDevice = (ua = navigator.userAgent): string => {
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X/.test(ua)
            ? 'Mac'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'Device'
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /CriOS|Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser'
  return `${os} · ${browser}`
}
