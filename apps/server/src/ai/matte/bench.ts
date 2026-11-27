/**
 * Matting benchmark (developer tool, not used by the server):
 *
 *   node apps/server/src/ai/matte/bench.ts <dataset dir> <model dir> [candidate…] [--provider=cpu|dml]
 *     [--fps=10] [--seconds=3] [--refine]
 *
 * The dataset dir holds pairs `<name>.mp4` (a composite) + `<name>.alpha.mkv` (its ground-truth
 * alpha as gray video), e.g. green-screen footage keyed and composited over real scenes.
 * Metrics are computed at 640 px wide:
 * - IoU of the binarised (0.5) mattes, SAD (Σ|α−α̂| / 1000), MSE (×10³)
 * - dtSSD (×10²): RMS of the temporal-derivative error, the usual video-matting flicker metric
 * - inference ms/frame (excluding decode) and peak RSS.
 */
import path from 'node:path'
import { streamFrames } from '../reframe/frames.ts'
import { readdirSync } from 'node:fs'
import { resizePlane } from './image.ts'
import { MATTE_MODELS, type MatteModelSpec } from './models.ts'
import { refineMatte, type RefineState } from './refine.ts'
import { Segmenter, type MatteProvider } from './segmenter.ts'

const IMAGENET = { mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] } as const

/** Candidates (file names inside the model dir). */
const CANDIDATES: Record<
  string,
  Omit<MatteModelSpec, 'id' | 'label' | 'license'> & { license: string }
> = {
  modnet: { ...MATTE_MODELS.modnet },
  'modnet-384': { ...MATTE_MODELS.modnet, input: { kind: 'short', short: 384, align: 32 } },
  'modnet-fp16': { ...MATTE_MODELS.modnet, file: 'modnet_fp16.onnx' },
  'modnet-uint8': { ...MATTE_MODELS.modnet, file: 'modnet_uint8.onnx' },
  'ben2-fp16': {
    file: 'ben2_fp16.onnx',
    license: 'MIT',
    input: { kind: 'fixed', width: 1024, height: 1024 },
    ...IMAGENET,
    logits: false,
  },
  selfie: {
    file: 'mpselfie.onnx',
    license: 'Apache-2.0',
    input: { kind: 'fixed', width: 256, height: 256 },
    mean: [0, 0, 0],
    std: [1, 1, 1],
    logits: false,
  },
}

const EVAL_W = 640

const ffmpeg = process.env.FFMPEG ?? 'ffmpeg'

const grayFrames = async (file: string, fps: number, seconds: number): Promise<Float32Array[]> => {
  const out: Float32Array[] = []
  await streamFrames({
    ffmpeg,
    file,
    fps,
    width: EVAL_W,
    onFrame: (f) => {
      if (out.length >= fps * seconds) return
      const a = new Float32Array(f.width * f.height)
      for (let i = 0; i < a.length; i++) a[i] = f.data[i * 3]! / 255
      out.push(a)
    },
  })
  return out
}

interface Score {
  iou: number
  sad: number
  mse: number
  dtssd: number
  ms: number
  frames: number
}

const main = async (): Promise<void> => {
  const args = process.argv.slice(2)
  const flag = (n: string): string | undefined =>
    args.find((a) => a.startsWith(`--${n}=`))?.split('=')[1]
  const pos = args.filter((a) => !a.startsWith('--'))
  const [dataDir, modelDir, ...names] = pos
  if (!dataDir || !modelDir)
    throw new Error('usage: bench.ts <dataset dir> <model dir> [candidate…]')
  const provider = (flag('provider') ?? 'cpu') as MatteProvider
  const fps = Number(flag('fps') ?? 10)
  const seconds = Number(flag('seconds') ?? 3)
  // --refine=temporal | guided | full (both); --temporal=<weight>
  const refine = flag('refine')
  const temporal = Number(flag('temporal') ?? 0.6)
  const subsample = Number(flag('subsample') ?? 2)
  const refineOpts =
    refine === 'temporal'
      ? { radius: 0, temporal }
      : refine === 'guided'
        ? { temporal: 0, subsample, radius: 4 }
        : { temporal, subsample, radius: 4 }
  const clips = readdirSync(dataDir)
    .filter((f) => f.endsWith('.mp4'))
    .map((f) => f.slice(0, -4))
  const gts = new Map<string, Float32Array[]>()
  for (const c of clips)
    gts.set(c, await grayFrames(path.join(dataDir, `${c}.alpha.mkv`), fps, seconds))

  for (const name of names.length ? names : Object.keys(CANDIDATES)) {
    const cand = CANDIDATES[name]
    if (!cand) throw new Error(`unknown candidate ${name}`)
    const spec = { ...cand, id: 'modnet', label: name } as MatteModelSpec
    const t0 = performance.now()
    const seg = await Segmenter.create(spec, path.join(modelDir, cand.file), {
      provider,
      idleMs: 0,
    })
    const loadMs = performance.now() - t0
    let peakRss = process.memoryUsage().rss
    const total: Score = { iou: 0, sad: 0, mse: 0, dtssd: 0, ms: 0, frames: 0 }
    let dtCount = 0
    for (const c of clips) {
      const gt = gts.get(c) ?? []
      let prev: Float32Array | undefined
      let state: RefineState | undefined
      let idx = 0
      await streamFrames({
        ffmpeg,
        file: path.join(dataDir, `${c}.mp4`),
        fps,
        width: 1280,
        onFrame: async (f) => {
          const g = gt[idx++]
          if (!g) return
          const ew = EVAL_W
          const eh = g.length / ew
          const s = performance.now()
          let a = await seg.run(f.data, f.width, f.height)
          if (refine) {
            state ??= { prev: undefined }
            a = refineMatte(a, f.data, f.width, f.height, state, refineOpts)
          }
          total.ms += performance.now() - s
          const p = new Float32Array(ew * eh)
          resizePlane(a, f.width, f.height, ew, eh, p)
          peakRss = Math.max(peakRss, process.memoryUsage().rss)
          let inter = 0
          let union = 0
          let sad = 0
          let se = 0
          for (let i = 0; i < p.length; i++) {
            const pv = p[i]!
            const gv = g[i]!
            const pb = pv >= 0.5
            const gb = gv >= 0.5
            if (pb && gb) inter++
            if (pb || gb) union++
            sad += Math.abs(pv - gv)
            se += (pv - gv) ** 2
          }
          total.iou += union ? inter / union : 1
          total.sad += sad / 1000
          total.mse += (se / p.length) * 1000
          total.frames++
          const pg = gt[idx - 2]
          if (prev && pg) {
            let d = 0
            for (let i = 0; i < p.length; i++) {
              const e = p[i]! - prev[i]! - (g[i]! - pg[i]!)
              d += e * e
            }
            total.dtssd += Math.sqrt(d / p.length) * 100
            dtCount++
          }
          prev = p
        },
      })
    }
    seg.close()
    const n = Math.max(1, total.frames)
    process.stdout.write(
      `${JSON.stringify({
        model: name,
        provider: seg.provider,
        refine: refine ? `${refine} t=${temporal} s=${subsample}` : 'none',
        frames: total.frames,
        loadMs: Math.round(loadMs),
        msPerFrame: Math.round((total.ms / n) * 10) / 10,
        iou: +(total.iou / n).toFixed(4),
        sad: +(total.sad / n).toFixed(2),
        mse: +(total.mse / n).toFixed(2),
        dtssd: +(total.dtssd / Math.max(1, dtCount)).toFixed(2),
        peakRssMb: Math.round(peakRss / 2 ** 20),
      })}\n`,
    )
  }
}

await main()
