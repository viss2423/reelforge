/**
 * One error shape for every API failure:
 *   { "error": { "code": "snake_case", "message": "human readable", "details"?: … } }
 * Domain errors from other modules are mapped here so route handlers can simply throw.
 */
import { OpError } from '@reelforge/core'
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify'
import { ZodError } from 'zod'
import { PairingRateLimitedError } from '../auth/pairing.ts'
import { RevisionConflictError } from '../contracts.ts'
import { UnknownJobKindError } from '../jobs/queue.ts'
import { UploadError } from '../media/uploads.ts'

export class HttpError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

export const notFound = (what: string): HttpError =>
  new HttpError(404, 'not_found', `${what} not found`)

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown }
}

const body = (code: string, message: string, details?: unknown): ErrorBody => ({
  error: details === undefined ? { code, message } : { code, message, details },
})

/** Maps any thrown value to (status, body). Exported for tests. */
export const toHttpError = (err: unknown): { status: number; body: ErrorBody } => {
  if (err instanceof HttpError)
    return { status: err.status, body: body(err.code, err.message, err.details) }
  if (err instanceof ZodError)
    return {
      status: 400,
      body: body(
        'invalid_request',
        'request validation failed',
        err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      ),
    }
  if (err instanceof UploadError)
    return { status: err.status, body: body(err.code, err.message, err.details) }
  if (err instanceof RevisionConflictError)
    return { status: 409, body: body('revision_conflict', err.message, { current: err.current }) }
  if (err instanceof UnknownJobKindError)
    return { status: 400, body: body('unsupported_job', err.message) }
  if (err instanceof PairingRateLimitedError)
    return { status: 429, body: body('rate_limited', err.message) }
  if (err instanceof OpError)
    return err.code === 'not_implemented'
      ? { status: 501, body: body('not_implemented', err.message) }
      : { status: 400, body: body(`op_${err.code}`, err.message) }
  const fe = err as Partial<FastifyError>
  if (typeof fe.statusCode === 'number' && fe.statusCode >= 400 && fe.statusCode < 500)
    return {
      status: fe.statusCode,
      body: body((fe.code ?? 'bad_request').toLowerCase(), fe.message ?? 'bad request'),
    }
  return { status: 500, body: body('internal', 'internal server error') }
}

/** Fastify error handler. 5xx are logged with the stack; 4xx only at debug level. */
export const errorHandler = (err: unknown, req: FastifyRequest, reply: FastifyReply): void => {
  const { status, body: payload } = toHttpError(err)
  if (status >= 500) req.log.error({ err }, 'request failed')
  else req.log.debug({ err: (err as Error).message, status }, 'request rejected')
  if (err instanceof PairingRateLimitedError)
    reply.header('retry-after', String(Math.ceil(err.retryAfterMs / 1000)))
  // Error responses must never be cached as if they were the (immutable) resource.
  void reply.code(status).header('cache-control', 'no-store').send(payload)
}
