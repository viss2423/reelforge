/**
 * `createLlm(deps)`: the LlmPort backed by a lazily started llama-server. Requests are
 * serialised (one slot: running two generations at once on the iGPU only makes both slower)
 * and JSON-schema constrained when a schema is given, so the result always parses.
 */
import os from 'node:os'
import path from 'node:path'
import type { DataPaths, Logger } from '../../contracts.ts'
import { LlamaServer, type LlamaServerOptions } from './llama.ts'
import { findLlmInstall, generationThreads, type LlmInstall } from './runtime.ts'
import {
  LlmUnavailableError,
  type LlmInfo,
  type LlmPort,
  type LlmRequest,
  type LlmResult,
} from './types.ts'

export interface LlmDeps {
  paths: Pick<DataPaths, 'bin' | 'models' | 'tmp'>
  log?: Logger
  idleMs?: number
  ctx?: number
  /** Overrides discovery (tests). */
  install?: LlmInstall | (() => LlmInstall | undefined)
  /** Test seams. */
  spawnServer?: LlamaServerOptions['spawnServer']
  killServer?: LlamaServerOptions['killServer']
  fetchImpl?: typeof fetch
}

/** Shape of llama-server's OpenAI-compatible chat completion response (fields we use). */
interface ChatResponse {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  timings?: {
    prompt_n?: number
    prompt_per_second?: number
    predicted_n?: number
    predicted_per_second?: number
  }
}

/** Builds the chat-completions body (exported for tests). */
export const chatBody = (req: LlmRequest): Record<string, unknown> => ({
  messages: [
    ...(req.system ? [{ role: 'system', content: req.system }] : []),
    { role: 'user', content: req.prompt },
  ],
  max_tokens: req.maxTokens ?? 512,
  temperature: req.temperature ?? 0.2,
  top_p: 0.9,
  stream: false,
  ...(req.schema
    ? {
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'output', strict: true, schema: req.schema },
        },
      }
    : {}),
})

/** Parses model output as JSON, tolerating stray code fences (constrained output has none). */
export const parseJsonOutput = (text: string): unknown => {
  const t = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim()
  return JSON.parse(t)
}

/** A promise-chain mutex: `run` executes callbacks strictly one after another. */
export const createMutex = () => {
  let tail: Promise<unknown> = Promise.resolve()
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const next = tail.then(fn, fn)
      tail = next.catch(() => undefined)
      return next
    },
  }
}

export interface ManagedLlm extends LlmPort {
  info(): Promise<LlmInfo | undefined>
  unload(): Promise<void>
}

export const createLlm = (deps: LlmDeps): ManagedLlm => {
  const resolve = (): LlmInstall | undefined =>
    typeof deps.install === 'function'
      ? deps.install()
      : (deps.install ?? findLlmInstall(deps.paths))
  const fetchImpl = deps.fetchImpl ?? fetch
  const mutex = createMutex()
  let server: LlamaServer | undefined
  let serverFor: string | undefined

  const getServer = (install: LlmInstall): LlamaServer => {
    const key = `${install.server}|${install.model}|${install.device}`
    if (!server || serverFor !== key) {
      void server?.stop()
      server = new LlamaServer({
        install,
        runDir: path.join(deps.paths.tmp, 'llm'),
        threads: generationThreads(os.availableParallelism()),
        ...(deps.ctx ? { ctx: deps.ctx } : {}),
        ...(deps.idleMs !== undefined ? { idleMs: deps.idleMs } : {}),
        ...(deps.log ? { log: deps.log } : {}),
        ...(deps.spawnServer ? { spawnServer: deps.spawnServer } : {}),
        ...(deps.killServer ? { killServer: deps.killServer } : {}),
        fetchImpl,
      })
      serverFor = key
    }
    return server
  }

  const complete = async (req: LlmRequest): Promise<LlmResult> => {
    const install = resolve()
    if (!install) throw new LlmUnavailableError()
    return mutex.run(async () => {
      req.signal?.throwIfAborted()
      const started = performance.now()
      const srv = getServer(install)
      const ep = await srv.acquire(req.signal)
      try {
        const res = await fetchImpl(`${ep.url}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.apiKey}` },
          body: JSON.stringify(chatBody(req)),
          ...(req.signal ? { signal: req.signal } : {}),
        })
        if (!res.ok) {
          const detail = (await res.text().catch(() => '')).slice(0, 300)
          throw new Error(`LLM request failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`)
        }
        const body = (await res.json()) as ChatResponse
        const text = body.choices?.[0]?.message?.content ?? ''
        const t = body.timings ?? {}
        const result: LlmResult = {
          text,
          tokensPerSecond: Math.round((t.predicted_per_second ?? 0) * 10) / 10,
          promptTokensPerSecond: Math.round((t.prompt_per_second ?? 0) * 10) / 10,
          promptTokens: t.prompt_n ?? body.usage?.prompt_tokens ?? 0,
          completionTokens: t.predicted_n ?? body.usage?.completion_tokens ?? 0,
          ms: Math.round(performance.now() - started),
        }
        if (req.schema) {
          try {
            result.json = parseJsonOutput(text)
          } catch (err) {
            const cut = body.choices?.[0]?.finish_reason === 'length'
            throw new Error(
              cut
                ? 'The AI answer was cut off (too long) — try a shorter video'
                : 'The AI returned malformed output',
              { cause: err },
            )
          }
        }
        return result
      } finally {
        srv.release()
      }
    })
  }

  return {
    available: () => Promise.resolve(resolve() !== undefined),
    complete,
    info: () => {
      const install = resolve()
      if (!install) return Promise.resolve(undefined)
      return Promise.resolve({
        model: path.basename(install.model),
        backend: server?.backend ?? (install.device === 'cpu' ? 'cpu' : 'vulkan'),
        loaded: server?.loaded ?? false,
      })
    },
    unload: async () => {
      await server?.stop()
    },
  }
}
