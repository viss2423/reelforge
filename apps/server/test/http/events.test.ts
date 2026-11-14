/** `/api/events` WebSocket: auth on upgrade, hello, event fan-out, revocation, heartbeat. */
import type { Job, ServerEvent } from '@reelforge/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { WebSocket } from 'ws'
import { WS_CLOSE_REVOKED } from '../../src/http/routes/events.ts'
import { waitFor } from '../helpers.ts'
import { makeApp, type Harness } from './harness.ts'

interface Recorded {
  ws: WebSocket
  messages: Array<Record<string, unknown>>
  state: { code?: number }
}

/**
 * Connects and records parsed messages + the close code. Listeners are attached in `onInit`
 * because the server greets synchronously, before `injectWS` resolves.
 */
const connect = async (
  h: Harness,
  headers: Record<string, string>,
  init?: (ws: WebSocket) => void,
): Promise<Recorded> => {
  const messages: Recorded['messages'] = []
  const state: Recorded['state'] = {}
  const ws = await h.app.injectWS(
    '/api/events',
    { headers },
    {
      onInit: (socket) => {
        socket.on('message', (data: Buffer) =>
          messages.push(JSON.parse(data.toString('utf8')) as Record<string, unknown>),
        )
        socket.on('close', (code) => {
          state.code = code
        })
        init?.(socket)
      },
    },
  )
  return { ws, messages, state }
}

const job = (id: string, status: Job['status'], progress = 0): Job => ({
  id,
  kind: 'export',
  status,
  progress,
  createdAt: new Date().toISOString(),
})

describe('/api/events', () => {
  let h: Harness
  afterEach(() => h.cleanup())

  it('rejects upgrades without a valid device token', async () => {
    h = await makeApp()
    await expect(h.app.injectWS('/api/events')).rejects.toThrow(/401/)
    await expect(
      h.app.injectWS('/api/events', { headers: { authorization: `Bearer ${'a'.repeat(43)}` } }),
    ).rejects.toThrow(/401/)
  })

  it('greets the device and streams every server event in order', async () => {
    h = await makeApp()
    const { ws, messages } = await connect(h, { cookie: `rf_token=${h.token}` })
    await waitFor(() => messages.length >= 1)
    expect(messages[0]).toEqual({ type: 'hello', serverVersion: '0.1.0', deviceId: h.deviceId })

    const events: ServerEvent[] = [
      { type: 'job', job: job('j1', 'running', 0.5) },
      { type: 'project', projectId: 'p1', revision: 3, origin: 'd2' },
      { type: 'packs', version: '2026.11.7' },
      { type: 'job', job: job('j1', 'done', 1) },
    ]
    for (const e of events) h.bus.emit(e)
    await waitFor(() => messages.length === 5)
    expect(messages.slice(1)).toEqual(JSON.parse(JSON.stringify(events)))
    ws.terminate()
  })

  it('accepts ?token= on the socket (browsers cannot set headers) but nowhere else', async () => {
    h = await makeApp()
    const messages: string[] = []
    const ws = await h.app.injectWS(
      `/api/events?token=${h.token}`,
      {},
      { onInit: (s) => s.on('message', (d: Buffer) => messages.push(d.toString('utf8'))) },
    )
    await waitFor(() => messages.length === 1)
    expect(JSON.parse(messages[0]!)).toMatchObject({ type: 'hello', deviceId: h.deviceId })
    await expect(h.app.injectWS('/api/events?token=nope')).rejects.toThrow(/401/)
    const rest = await h.app.inject({ method: 'GET', url: `/api/projects?token=${h.token}` })
    expect(rest.statusCode).toBe(401)

    // Application-level heartbeat: {"type":"ping"} → {"type":"pong"}; other input is ignored.
    ws.send('hello?')
    ws.send('{"type":"ping"}')
    await waitFor(() => messages.length === 2)
    expect(messages[1]).toBe('{"type":"pong"}')
    ws.terminate()
  })

  it('fans out to several devices and closes revoked devices immediately', async () => {
    h = await makeApp()
    const other = h.auth.issue('Tablet')
    const ra = await connect(h, h.headers)
    const rb = await connect(h, { authorization: `Bearer ${other.token}` })
    await waitFor(() => ra.messages.length === 1 && rb.messages.length === 1)
    h.bus.emit({ type: 'packs', version: '1' })
    await waitFor(() => ra.messages.length === 2 && rb.messages.length === 2)

    h.auth.revoke(other.deviceId)
    await waitFor(() => rb.state.code !== undefined)
    expect(rb.state.code).toBe(WS_CLOSE_REVOKED)
    h.bus.emit({ type: 'packs', version: '2' })
    await waitFor(() => ra.messages.length === 3)
    expect(ra.state.code).toBeUndefined()
    ra.ws.terminate()
  })

  it('heartbeat keeps responsive clients and terminates dead ones', async () => {
    h = await makeApp({ heartbeatMs: 40 })
    // injectWS clients are created without ws' autoPong, so the live one answers explicitly
    // (as every browser does); the dead one, like a phone that left Wi-Fi, never answers.
    const rl = await connect(h, h.headers, (ws) => {
      ws.on('ping', (data) => ws.pong(data))
    })
    const rd = await connect(h, h.headers)
    await waitFor(() => rd.state.code !== undefined, 2_000)
    expect(rd.state.code).toBe(1006)
    await new Promise((r) => setTimeout(r, 150))
    expect(rl.state.code).toBeUndefined()
    rl.ws.terminate()
  })

  it('closes connected clients on server shutdown', async () => {
    h = await makeApp()
    const r = await connect(h, h.headers)
    await h.app.close()
    await waitFor(() => r.state.code !== undefined)
    expect(r.state.code).toBe(1001)
    expect(h.bus.size).toBe(0)
  })
})
