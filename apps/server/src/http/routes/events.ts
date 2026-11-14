/**
 * `/api/events` WebSocket: streams every ServerEvent to connected devices.
 *
 * - Each event is serialised ONCE and the same string is sent to every client.
 * - Backpressure: when a client's socket buffer is backed up (slow phone on bad Wi-Fi),
 *   superseded progress updates of running jobs are dropped for that client; state changes
 *   (job finished, asset ready, project saved) are always delivered. A client that falls
 *   hopelessly behind is disconnected and resyncs on reconnect.
 * - One heartbeat timer pings all clients; a client that missed a pong is terminated, so
 *   dead phones (Wi-Fi switched off) don't hold buffers forever.
 * - Revoking a device closes its sockets immediately.
 */
import type { ServerEvent } from '@reelforge/core'
import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import type { AppDeps } from '../deps.ts'

/** Above this many buffered bytes, droppable events are skipped for the client. */
const SOFT_LIMIT = 256 * 1024
/** Above this the client is disconnected (it will reconnect and refetch state). */
const HARD_LIMIT = 8 * 1024 * 1024
/** Close code for revoked devices (4000-4999 are application-defined). */
export const WS_CLOSE_REVOKED = 4401

const PING = Buffer.from('{"type":"ping"}')
const PONG = '{"type":"pong"}'

interface Client {
  socket: WebSocket
  deviceId: string
  alive: boolean
}

const droppable = (event: ServerEvent): boolean =>
  event.type === 'job' && event.job.status === 'running'

export const eventRoutes = (app: FastifyInstance, deps: AppDeps): void => {
  const clients = new Set<Client>()

  const send = (client: Client, data: string, canDrop: boolean): void => {
    const { socket } = client
    if (socket.readyState !== socket.OPEN) return
    const buffered = socket.bufferedAmount
    if (buffered > HARD_LIMIT) {
      socket.terminate()
      return
    }
    if (canDrop && buffered > SOFT_LIMIT) return
    socket.send(data)
  }

  const unsubscribe = deps.bus.subscribe((event) => {
    if (clients.size === 0) return
    const data = JSON.stringify(event)
    const canDrop = droppable(event)
    for (const client of clients) send(client, data, canDrop)
  })

  const offRevoke = deps.auth.onRevoke((deviceId) => {
    for (const client of clients)
      if (client.deviceId === deviceId) client.socket.close(WS_CLOSE_REVOKED, 'device revoked')
  })

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        client.socket.terminate()
        continue
      }
      client.alive = false
      client.socket.ping()
    }
  }, deps.heartbeatMs ?? 30_000)
  heartbeat.unref()

  app.addHook('onClose', async () => {
    clearInterval(heartbeat)
    unsubscribe()
    offRevoke()
    for (const client of clients) client.socket.close(1001, 'server shutting down')
    clients.clear()
  })

  app.get('/api/events', { websocket: true }, (socket, req) => {
    // The auth hook already rejected unauthenticated upgrades.
    const deviceId = req.device?.id ?? ''
    const client: Client = { socket, deviceId, alive: true }
    clients.add(client)
    socket.on('pong', () => {
      client.alive = true
    })
    socket.on('close', () => clients.delete(client))
    socket.on('error', () => clients.delete(client))
    // Clients only listen, apart from an application-level heartbeat (`{"type":"ping"}`):
    // browsers cannot send protocol pings, so they detect dead sockets this way.
    socket.on('message', (data, isBinary) => {
      client.alive = true
      if (!isBinary && Buffer.isBuffer(data) && data.equals(PING)) socket.send(PONG)
    })
    socket.send(JSON.stringify({ type: 'hello', serverVersion: deps.version, deviceId }))
  })
}
