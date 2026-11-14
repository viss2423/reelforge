/** Health, pairing and device management routes. */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import QRCode from 'qrcode'
import { z } from 'zod'
import { clearTokenCookie, isLoopbackRequest, tokenCookie } from '../../auth/index.ts'
import { type AppDeps, deviceOf, parse } from '../deps.ts'
import { HttpError, notFound } from '../errors.ts'

const PairBody = z.object({
  code: z.string().regex(/^\d{6}$/, 'code must be 6 digits'),
  deviceName: z.string().trim().min(1).max(100),
})
const LocalPairBody = z
  .object({ deviceName: z.string().trim().min(1).max(100).optional() })
  .optional()
const IdParams = z.object({ id: z.string().min(1).max(64) })

const requireLoopback = (req: FastifyRequest): void => {
  if (!isLoopbackRequest(req.socket.remoteAddress, req.headers))
    throw new HttpError(403, 'loopback_only', 'only available on the host machine')
}

/** Pairing URL for a base URL + code (opened by the phone camera from the QR code). */
export const pairUrl = (base: string, code: string): string => `${base}/pair?code=${code}`

export const authRoutes = (app: FastifyInstance, deps: AppDeps): void => {
  const pub = { config: { public: true } }

  app.get('/api/health', pub, async () => ({ ok: true, version: deps.version }))

  app.get('/api/pair/info', pub, async (req, reply) => {
    requireLoopback(req)
    const { code, expiresAt } = deps.auth.pairing.current()
    const urls = deps.urls().map((u) => pairUrl(u, code))
    const qrSvg = urls[0]
      ? await QRCode.toString(urls[0], { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
      : ''
    void reply.header('cache-control', 'no-store')
    return { code, expiresAt: new Date(expiresAt).toISOString(), urls, qrSvg }
  })

  app.post('/api/pair', pub, async (req, reply) => {
    const body = parse(PairBody, req.body)
    const issued = deps.auth.pair(body.code, body.deviceName, req.ip, req.headers['user-agent'])
    if (!issued) throw new HttpError(401, 'invalid_code', 'pairing code is wrong or expired')
    req.log.info({ deviceId: issued.deviceId, name: issued.device.name }, 'device paired')
    void reply.header('set-cookie', tokenCookie(issued.token)).header('cache-control', 'no-store')
    return { token: issued.token, deviceId: issued.deviceId }
  })

  app.post('/api/pair/local', pub, async (req, reply) => {
    requireLoopback(req)
    const body = parse(LocalPairBody, req.body)
    const issued = deps.auth.issue(body?.deviceName ?? 'This computer', req.headers['user-agent'])
    void reply.header('set-cookie', tokenCookie(issued.token)).header('cache-control', 'no-store')
    return { token: issued.token, deviceId: issued.deviceId }
  })

  app.get('/api/devices', async (req) => {
    const me = deviceOf(req)
    return deps.auth.listDevices().map((d) => ({ ...d, current: d.id === me.id }))
  })

  app.delete('/api/devices/:id', async (req, reply) => {
    const { id } = parse(IdParams, req.params)
    const me = deviceOf(req)
    if (!deps.auth.revoke(id)) throw notFound('device')
    if (id === me.id) void reply.header('set-cookie', clearTokenCookie())
    return reply.code(204).send()
  })
}
