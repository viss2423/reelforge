import type { ServerEvent } from '@reelforge/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventSocket, type SocketState } from '@/api/ws.ts'

/** Minimal controllable WebSocket double. */
class FakeWS {
  static instances: FakeWS[] = []
  readyState = 0
  sent: string[] = []
  closed: { code?: number; reason?: string } | null = null
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  readonly url: string

  constructor(url: string) {
    this.url = url
    FakeWS.instances.push(this)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason }
    this.readyState = 3
  }
  /* test drivers */
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  message(data: unknown) {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) })
  }
  drop() {
    this.readyState = 3
    this.onclose?.()
  }
}

const latest = () => FakeWS.instances.at(-1)!
const HEARTBEAT = 1000

let win: EventTarget
let doc: EventTarget & { visibilityState: DocumentVisibilityState }
let sock: EventSocket

const create = (validate = true) => {
  sock = new EventSocket({
    url: () => 'wss://host/api/events?token=t',
    WebSocketImpl: FakeWS as unknown as typeof WebSocket,
    heartbeatMs: HEARTBEAT,
    backoffBaseMs: 500,
    backoffMaxMs: 4000,
    validate,
    win: win as unknown as Window,
    doc: doc as unknown as Document,
  })
  return sock
}

const job: ServerEvent = {
  type: 'job',
  job: { id: 'j1', kind: 'export', status: 'running', progress: 0.5, createdAt: '2026-01-01' },
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(1) // deterministic backoff: always the ceiling
  FakeWS.instances = []
  win = new EventTarget()
  doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState })
})

afterEach(() => {
  sock?.stop()
  vi.useRealTimers()
})

describe('EventSocket', () => {
  it('connects and reports state changes', () => {
    const states: SocketState[] = []
    create().onState((s) => states.push(s))
    sock.start()
    sock.start() // idempotent
    expect(FakeWS.instances).toHaveLength(1)
    expect(latest().url).toBe('wss://host/api/events?token=t')
    latest().open()
    expect(sock.state).toBe('open')
    expect(states).toEqual(['connecting', 'open'])
  })

  it('dispatches typed events to type listeners and onAny', () => {
    create().start()
    latest().open()
    const jobs: unknown[] = []
    const any: unknown[] = []
    const projects: unknown[] = []
    sock.on('job', (e) => jobs.push(e.job.id))
    sock.on('project', (e) => projects.push(e))
    const off = sock.onAny((e) => any.push(e.type))
    latest().message(job)
    latest().message({ type: 'packs', version: '3' })
    off()
    latest().message(job)
    expect(jobs).toEqual(['j1', 'j1'])
    expect(any).toEqual(['job', 'packs'])
    expect(projects).toEqual([])
  })

  it('drops pongs, non-JSON, untyped and (when validating) malformed events', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    create().start()
    latest().open()
    const any = vi.fn<(e: ServerEvent) => void>()
    sock.onAny(any)
    latest().message({ type: 'pong' })
    latest().message('not json')
    latest().message({ hello: 1 })
    latest().message({ type: 'job', job: { id: 'x' } })
    expect(any).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledOnce()
  })

  it('passes events through unvalidated when validation is off', () => {
    create(false).start()
    latest().open()
    const any = vi.fn<(e: ServerEvent) => void>()
    sock.onAny(any)
    latest().message({ type: 'job', job: { id: 'x' } })
    expect(any).toHaveBeenCalledOnce()
  })

  it('reconnects with exponential backoff and resets after a healthy connection', async () => {
    create().start()
    latest().drop() // never opened
    await vi.advanceTimersByTimeAsync(499)
    expect(FakeWS.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeWS.instances).toHaveLength(2)
    latest().drop()
    await vi.advanceTimersByTimeAsync(999)
    expect(FakeWS.instances).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeWS.instances).toHaveLength(3)
    latest().drop()
    await vi.advanceTimersByTimeAsync(2000)
    expect(FakeWS.instances).toHaveLength(4)
    latest().drop()
    await vi.advanceTimersByTimeAsync(4000) // capped at backoffMaxMs
    expect(FakeWS.instances).toHaveLength(5)
    latest().open()
    latest().drop()
    await vi.advanceTimersByTimeAsync(500) // reset to base after success
    expect(FakeWS.instances).toHaveLength(6)
  })

  it('fires onReconnect only after a restored connection', async () => {
    const onReconnect = vi.fn<() => void>()
    create().onReconnect(onReconnect)
    sock.start()
    latest().open()
    expect(onReconnect).not.toHaveBeenCalled()
    latest().drop()
    await vi.advanceTimersByTimeAsync(500)
    latest().open()
    expect(onReconnect).toHaveBeenCalledOnce()
  })

  it('sends heartbeats and recycles a silent socket', async () => {
    create().start()
    const first = latest()
    first.open()
    await vi.advanceTimersByTimeAsync(HEARTBEAT)
    expect(first.sent).toEqual(['{"type":"ping"}'])
    first.message({ type: 'pong' }) // liveness
    await vi.advanceTimersByTimeAsync(HEARTBEAT * 2)
    expect(first.sent).toHaveLength(3)
    expect(first.closed).toBeNull()
    // Silence for > 2 heartbeats: considered dead, closed and replaced.
    await vi.advanceTimersByTimeAsync(HEARTBEAT)
    expect(first.closed).toMatchObject({ code: 4000 })
    expect(sock.state).toBe('closed')
    await vi.advanceTimersByTimeAsync(500)
    expect(FakeWS.instances).toHaveLength(2)
  })

  it('reconnects immediately when the browser comes online', async () => {
    create().start()
    latest().drop()
    win.dispatchEvent(new Event('online'))
    expect(FakeWS.instances).toHaveLength(2)
    // The pending backoff timer was cleared.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(FakeWS.instances).toHaveLength(2)
  })

  it('probes an open socket when the tab becomes visible, ignores hidden', () => {
    create().start()
    latest().open()
    doc.visibilityState = 'hidden'
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(latest().sent).toEqual([])
    doc.visibilityState = 'visible'
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(latest().sent).toEqual(['{"type":"ping"}'])
  })

  it('stop closes the socket and prevents reconnects', async () => {
    create().start()
    const ws = latest()
    ws.open()
    sock.stop()
    expect(ws.closed).toMatchObject({ code: 1000 })
    expect(sock.state).toBe('closed')
    ws.drop()
    win.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeWS.instances).toHaveLength(1)
  })

  it('retries when the WebSocket constructor throws', async () => {
    let fail = true
    sock = new EventSocket({
      url: () => 'wss://x',
      WebSocketImpl: function Throwing(this: unknown, url: string) {
        if (fail) {
          fail = false
          throw new Error('bad url')
        }
        return new FakeWS(url)
      } as unknown as typeof WebSocket,
      backoffBaseMs: 100,
      win: undefined,
      doc: undefined,
    })
    sock.start()
    expect(FakeWS.instances).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(100)
    expect(FakeWS.instances).toHaveLength(1)
  })
})
