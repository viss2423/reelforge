/**
 * Realtime event socket (`/api/events`).
 *
 * - Reconnects with exponential backoff + jitter; resets after a healthy connection.
 * - Heartbeat: sends `{"type":"ping"}` every `heartbeatMs`; any inbound message counts as
 *   liveness. A socket that stays silent for 2 heartbeats is considered dead (common after
 *   a phone sleeps or switches network) and is recycled.
 * - Reconnects immediately when the browser comes back online or the tab becomes visible.
 * - Dispatches typed `ServerEvent`s; payloads are zod-validated in development.
 * - `onReconnect` fires after a dropped connection is restored so callers can refetch
 *   whatever they might have missed.
 */
import { ServerEvent } from '@reelforge/core'
import { backoffDelay } from '@/lib/backoff.ts'

export type SocketState = 'idle' | 'connecting' | 'open' | 'closed'
type EventOf<K extends ServerEvent['type']> = Extract<ServerEvent, { type: K }>

export interface EventSocketOptions {
  url: () => string
  WebSocketImpl?: typeof WebSocket
  heartbeatMs?: number
  backoffBaseMs?: number
  backoffMaxMs?: number
  /** Validate inbound events with zod (default: development builds; never in production). */
  validate?: boolean
  /** Environment hooks (overridable for tests). */
  win?: Pick<Window, 'addEventListener' | 'removeEventListener'> | undefined
  doc?: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'> | undefined
}

export class EventSocket {
  private readonly opts: Required<Omit<EventSocketOptions, 'win' | 'doc'>> &
    Pick<EventSocketOptions, 'win' | 'doc'>
  private ws: WebSocket | undefined
  private attempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private lastMessageAt = 0
  private wasOpen = false
  private running = false
  private readonly listeners = new Map<string, Set<(e: ServerEvent) => void>>()
  private readonly anyListeners = new Set<(e: ServerEvent) => void>()
  private readonly stateListeners = new Set<(s: SocketState) => void>()
  private readonly reconnectListeners = new Set<() => void>()
  private _state: SocketState = 'idle'

  constructor(opts: EventSocketOptions) {
    this.opts = {
      WebSocketImpl: globalThis.WebSocket,
      heartbeatMs: 25_000,
      backoffBaseMs: 500,
      backoffMaxMs: 15_000,
      validate: import.meta.env.DEV,
      win: typeof window === 'undefined' ? undefined : window,
      doc: typeof document === 'undefined' ? undefined : document,
      ...opts,
    }
  }

  get state(): SocketState {
    return this._state
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.opts.win?.addEventListener('online', this.wake)
    this.opts.doc?.addEventListener('visibilitychange', this.wake)
    this.connect()
  }

  stop(): void {
    this.running = false
    this.opts.win?.removeEventListener('online', this.wake)
    this.opts.doc?.removeEventListener('visibilitychange', this.wake)
    clearTimeout(this.reconnectTimer)
    this.stopHeartbeat()
    const ws = this.ws
    this.ws = undefined
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
      ws.close(1000, 'client stop')
    }
    this.wasOpen = false
    this.setState('closed')
  }

  /** Subscribe to one event type. Returns an unsubscribe function. */
  on<K extends ServerEvent['type']>(type: K, cb: (e: EventOf<K>) => void): () => void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    const fn = cb as (e: ServerEvent) => void
    set.add(fn)
    return () => set.delete(fn)
  }

  /** Subscribe to every event. */
  onAny(cb: (e: ServerEvent) => void): () => void {
    this.anyListeners.add(cb)
    return () => this.anyListeners.delete(cb)
  }

  onState(cb: (s: SocketState) => void): () => void {
    this.stateListeners.add(cb)
    return () => this.stateListeners.delete(cb)
  }

  onReconnect(cb: () => void): () => void {
    this.reconnectListeners.add(cb)
    return () => this.reconnectListeners.delete(cb)
  }

  private readonly wake = (): void => {
    if (!this.running || this.opts.doc?.visibilityState === 'hidden') return
    if (this._state === 'open') {
      // Coming back from background: the socket may be a zombie; probe it now.
      this.ping()
      return
    }
    if (this._state !== 'connecting') {
      clearTimeout(this.reconnectTimer)
      this.attempt = 0
      this.connect()
    }
  }

  private setState(s: SocketState): void {
    if (s === this._state) return
    this._state = s
    for (const l of this.stateListeners) l(s)
  }

  private connect(): void {
    if (!this.running) return
    this.setState('connecting')
    let ws: WebSocket
    try {
      ws = new this.opts.WebSocketImpl(this.opts.url())
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    ws.onopen = () => {
      const reconnected = this.wasOpen
      this.wasOpen = true
      this.attempt = 0
      this.lastMessageAt = Date.now()
      this.setState('open')
      this.startHeartbeat()
      if (reconnected) for (const l of this.reconnectListeners) l()
    }
    ws.onmessage = (msg: MessageEvent) => {
      this.lastMessageAt = Date.now()
      if (typeof msg.data === 'string') this.handle(msg.data)
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = undefined
      this.stopHeartbeat()
      this.setState('closed')
      this.scheduleReconnect()
    }
    // onerror is always followed by onclose; nothing to do here.
    ws.onerror = null
  }

  private handle(raw: string): void {
    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch {
      return
    }
    if (!data || typeof data !== 'object' || !('type' in data) || typeof data.type !== 'string')
      return
    if (data.type === 'pong') return
    let event: ServerEvent
    // The DEV guard is static, so production bundles drop the schemas (and zod) entirely.
    if (import.meta.env.DEV && this.opts.validate) {
      const parsed = ServerEvent.safeParse(data)
      if (!parsed.success) {
        console.warn('[ws] dropping malformed event', parsed.error)
        return
      }
      event = parsed.data
    } else {
      event = data as ServerEvent
    }
    for (const l of this.anyListeners) l(event)
    const set = this.listeners.get(event.type)
    if (set) for (const l of set) l(event)
  }

  private scheduleReconnect(): void {
    if (!this.running) return
    clearTimeout(this.reconnectTimer)
    const delay = backoffDelay(this.attempt++, {
      base: this.opts.backoffBaseMs,
      max: this.opts.backoffMaxMs,
    })
    this.reconnectTimer = setTimeout(() => this.connect(), delay)
  }

  private ping(): void {
    const ws = this.ws
    if (!ws || ws.readyState !== 1) return
    if (Date.now() - this.lastMessageAt > this.opts.heartbeatMs * 2) {
      this.recycle(ws)
      return
    }
    try {
      ws.send('{"type":"ping"}')
    } catch {
      this.recycle(ws)
    }
  }

  /**
   * Abandons a dead socket and reconnects right away. We don't wait for `onclose`: on a
   * half-open TCP connection the close handshake can hang for minutes.
   */
  private recycle(ws: WebSocket): void {
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
    try {
      ws.close(4000, 'heartbeat timeout')
    } catch {
      // Already closing.
    }
    if (this.ws === ws) this.ws = undefined
    this.stopHeartbeat()
    this.setState('closed')
    this.scheduleReconnect()
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => this.ping(), this.opts.heartbeatMs)
  }

  private stopHeartbeat(): void {
    clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
  }
}
