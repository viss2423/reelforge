/**
 * ONNX inference for the matting models (onnxruntime-node). One session per
 * (model, provider) is kept while jobs use it and released after an idle period, so a
 * 200 MB network never sits in the 16 GB shared memory between edits.
 */
import os from 'node:os'
import * as ort from 'onnxruntime-node'
import { clamp01InPlace, resizePlane, rgbToTensor, sigmoidInPlace } from './image.ts'
import { inputSize, type MatteModelSpec } from './models.ts'

export type MatteProvider = 'cpu' | 'dml'

/** How long an unused session stays loaded. */
export const SESSION_IDLE_MS = 60_000

interface Entry {
  session: Promise<ort.InferenceSession>
  users: number
  timer: ReturnType<typeof setTimeout> | undefined
}

const sessions = new Map<string, Entry>()

const createSession = (file: string, provider: MatteProvider): Promise<ort.InferenceSession> =>
  ort.InferenceSession.create(file, {
    executionProviders: [provider],
    graphOptimizationLevel: 'all',
    // Leave cores for the FFmpeg decode/encode around us and for the editor.
    intraOpNumThreads: Math.max(1, Math.floor(os.availableParallelism() / 2)),
    interOpNumThreads: 1,
    logSeverityLevel: 3,
    ...(provider === 'dml'
      ? { enableMemPattern: false, executionMode: 'sequential' as const }
      : {}),
  })

const acquire = (file: string, provider: MatteProvider): Promise<ort.InferenceSession> => {
  const key = `${provider}\0${file}`
  let e = sessions.get(key)
  if (!e) {
    const session = createSession(file, provider)
    e = { session, users: 0, timer: undefined }
    sessions.set(key, e)
    // A failed creation must not poison the cache.
    session.catch(() => sessions.delete(key))
  }
  clearTimeout(e.timer)
  e.timer = undefined
  e.users++
  return e.session
}

const release = (file: string, provider: MatteProvider, idleMs: number): void => {
  const key = `${provider}\0${file}`
  const e = sessions.get(key)
  if (!e) return
  e.users = Math.max(0, e.users - 1)
  if (e.users > 0) return
  const drop = (): void => {
    if (sessions.get(key) !== e || e.users > 0) return
    sessions.delete(key)
    void e.session.then((s) => s.release()).catch(() => undefined)
  }
  if (idleMs <= 0) drop()
  else {
    e.timer = setTimeout(drop, idleMs)
    e.timer.unref()
  }
}

/** Number of sessions currently loaded (tests / diagnostics). */
export const loadedSessions = (): number => sessions.size

export interface SegmenterOptions {
  /** 'auto' (default): DirectML on Windows when it loads, else CPU. */
  provider?: 'auto' | MatteProvider
  /** Release the session this long after `close()` (default SESSION_IDLE_MS; 0 = now). */
  idleMs?: number
}

/** One model bound to one execution provider; reuse it for every frame of a job. */
export class Segmenter {
  readonly spec: MatteModelSpec
  readonly provider: MatteProvider
  readonly #file: string
  readonly #session: ort.InferenceSession
  readonly #idleMs: number
  #closed = false
  #inW = 0
  #inH = 0
  #input: Float32Array<ArrayBuffer> = new Float32Array(0)
  #tensor: ort.Tensor | undefined

  private constructor(
    spec: MatteModelSpec,
    file: string,
    session: ort.InferenceSession,
    provider: MatteProvider,
    idleMs: number,
  ) {
    this.spec = spec
    this.#file = file
    this.#session = session
    this.provider = provider
    this.#idleMs = idleMs
  }

  /** Load (or reuse) a session; falls back to CPU when DirectML is unavailable. */
  static async create(
    spec: MatteModelSpec,
    file: string,
    o: SegmenterOptions = {},
  ): Promise<Segmenter> {
    const wanted = o.provider ?? 'auto'
    const provider: MatteProvider =
      process.platform !== 'win32' ? 'cpu' : wanted === 'auto' ? 'dml' : wanted
    const idle = o.idleMs ?? SESSION_IDLE_MS
    try {
      return new Segmenter(spec, file, await acquire(file, provider), provider, idle)
    } catch (err) {
      release(file, provider, 0)
      if (provider === 'cpu') throw err
      return new Segmenter(spec, file, await acquire(file, 'cpu'), 'cpu', idle)
    }
  }

  /**
   * Alpha (0..1) for a packed RGB24 frame, at `outW`×`outH` (default: the frame size).
   * `out` is reused when given.
   */
  async run(
    rgb: Uint8Array,
    width: number,
    height: number,
    outW = width,
    outH = height,
    out: Float32Array = new Float32Array(outW * outH),
  ): Promise<Float32Array> {
    if (this.#closed) throw new Error('segmenter is closed')
    const size = inputSize(this.spec, width, height)
    if (size.width !== this.#inW || size.height !== this.#inH) {
      this.#inW = size.width
      this.#inH = size.height
      this.#input = new Float32Array(3 * size.width * size.height)
      this.#tensor = new ort.Tensor('float32', this.#input, [1, 3, size.height, size.width])
    }
    rgbToTensor(
      rgb,
      width,
      height,
      this.#inW,
      this.#inH,
      this.spec.mean,
      this.spec.std,
      this.#input,
    )
    const feeds = { [this.#session.inputNames[0] ?? 'input']: this.#tensor as ort.Tensor }
    const result = await this.#session.run(feeds)
    const name = this.#session.outputNames[0] ?? Object.keys(result)[0] ?? ''
    const t = result[name]
    if (!t) throw new Error('matting model returned no output')
    const dims = t.dims
    const oh = Number(dims[dims.length - 2])
    const ow = Number(dims[dims.length - 1])
    const raw = t.data as Float32Array
    if (this.spec.logits) sigmoidInPlace(raw)
    resizePlane(raw, ow, oh, outW, outH, out)
    clamp01InPlace(out)
    for (const v of Object.values(result)) v.dispose()
    return out
  }

  /** Release this handle; the session unloads after the idle period if nobody else uses it. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    release(this.#file, this.provider, this.#idleMs)
  }
}
