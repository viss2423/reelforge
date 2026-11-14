/**
 * YuNet inference with onnxruntime-node. Sessions are created once per (model, provider) and
 * reused across jobs; input buffers are reused across frames of the same size.
 */
import os from 'node:os'
import * as ort from 'onnxruntime-node'
import {
  decodeYunet,
  nms,
  paddedSize,
  preprocessRgb,
  type Face,
  type YunetOutputs,
} from './yunet.ts'

export type ExecutionProvider = 'cpu' | 'dml'

export interface DetectorOptions {
  /** 'auto' (default) uses the measured-fastest provider for this platform. */
  provider?: 'auto' | ExecutionProvider
  /** Minimum face score (default 0.6; OpenCV's demo uses 0.9 for still photos). */
  scoreThreshold?: number
  nmsThreshold?: number
}

/**
 * YuNet is tiny (~75 k parameters). Measured on a Ryzen 7 PRO 8840U / Radeon 780M
 * (onnxruntime-node 1.31): CPU 2.1 ms per 320×180 frame and 4.6 ms per 320×568, DirectML
 * 4.3 ms and 28.8 ms — upload/dispatch costs more than the GPU saves — with a 380 ms vs
 * 140 ms session start. DirectML stays selectable (`provider: 'dml'`) for weak CPUs.
 */
const AUTO_PROVIDER: ExecutionProvider = 'cpu'

const sessions = new Map<string, Promise<ort.InferenceSession>>()

const getSession = (model: string, provider: ExecutionProvider): Promise<ort.InferenceSession> => {
  const key = `${provider}\0${model}`
  let s = sessions.get(key)
  if (!s) {
    s = ort.InferenceSession.create(model, {
      executionProviders: [provider],
      graphOptimizationLevel: 'all',
      // Leave cores for the concurrent FFmpeg decode feeding us frames.
      intraOpNumThreads: Math.max(1, Math.floor(os.availableParallelism() / 4)),
      interOpNumThreads: 1,
    })
    // A failed creation must not poison the cache.
    s.catch(() => sessions.delete(key))
    sessions.set(key, s)
  }
  return s
}

/** Face detector bound to one model/provider. */
export class YunetDetector {
  readonly provider: ExecutionProvider
  readonly #session: ort.InferenceSession
  readonly #score: number
  readonly #nms: number
  #input: Float32Array<ArrayBuffer> = new Float32Array(0)
  #tensor: ort.Tensor | undefined
  #padW = 0
  #padH = 0

  private constructor(
    session: ort.InferenceSession,
    provider: ExecutionProvider,
    o: DetectorOptions,
  ) {
    this.#session = session
    this.provider = provider
    this.#score = o.scoreThreshold ?? 0.6
    this.#nms = o.nmsThreshold ?? 0.3
  }

  /** Load (or reuse) a session; falls back to the CPU provider if DirectML is unavailable. */
  static async create(model: string, o: DetectorOptions = {}): Promise<YunetDetector> {
    const wanted = !o.provider || o.provider === 'auto' ? AUTO_PROVIDER : o.provider
    const provider: ExecutionProvider =
      wanted === 'dml' && process.platform !== 'win32' ? 'cpu' : wanted
    try {
      return new YunetDetector(await getSession(model, provider), provider, o)
    } catch (err) {
      if (provider === 'cpu') throw err
      return new YunetDetector(await getSession(model, 'cpu'), 'cpu', o)
    }
  }

  /**
   * Detect faces in a packed RGB24 frame. Coordinates are in frame pixels.
   */
  async detect(rgb: Uint8Array, width: number, height: number): Promise<Face[]> {
    const pad = paddedSize(width, height)
    if (pad.width !== this.#padW || pad.height !== this.#padH) {
      this.#padW = pad.width
      this.#padH = pad.height
      this.#input = new Float32Array(3 * pad.width * pad.height)
      this.#tensor = new ort.Tensor('float32', this.#input, [1, 3, pad.height, pad.width])
    }
    preprocessRgb(rgb, width, height, this.#padW, this.#padH, this.#input)
    const tensor = this.#tensor
    if (!tensor) throw new Error('detector input not initialised')
    const result = await this.#session.run({ [this.#session.inputNames[0] ?? 'input']: tensor })
    const outputs: Record<string, Float32Array> = {}
    for (const [name, t] of Object.entries(result)) outputs[name] = t.data as Float32Array
    const faces = decodeYunet(
      outputs as YunetOutputs,
      this.#padW,
      this.#padH,
      this.#score,
      width,
      height,
    )
    for (const t of Object.values(result)) t.dispose()
    return nms(faces, this.#nms)
  }
}
