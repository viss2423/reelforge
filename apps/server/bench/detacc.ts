/** Person-detection agreement vs D-FINE-S@640 (pseudo ground truth): node bench/detacc.ts <video> */
import * as ort from 'onnxruntime-node'
import { streamFrames, type RgbFrame } from '../src/ai/reframe/frames.ts'
import {
  boxIou,
  decodeDetr,
  preprocessDetr,
  PERSON,
  type Detection,
} from '../src/ai/reframe/objects.ts'
import { findFfmpeg } from './ffmpeg.ts'
const M = 'C:/tmp/rf-tb/models/'
const frames: RgbFrame[] = []
for (const file of process.argv.slice(2))
  await streamFrames({
    ffmpeg: findFfmpeg(),
    file,
    fps: 0.5,
    width: 640,
    onFrame: async (f) => {
      frames.push(f)
    },
  })
const run = async (model: string, size: number, thr: number) => {
  const s = await ort.InferenceSession.create(M + model, { intraOpNumThreads: 4 })
  const input = new Float32Array(3 * size * size)
  const out: Detection[][] = []
  const times: number[] = []
  for (const f of frames) {
    const t0 = performance.now()
    preprocessDetr(f.data, f.width, f.height, size, input)
    const r = await s.run({ pixel_values: new ort.Tensor('float32', input, [1, 3, size, size]) })
    out.push(
      decodeDetr(
        r.logits!.data as Float32Array,
        r.pred_boxes!.data as Float32Array,
        80,
        f.width,
        f.height,
        thr,
      ).filter((d) => d.label === PERSON),
    )
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  return { out, ms: times[Math.floor(times.length * 0.25)]! }
}
const gt = (await run('dfine_s.onnx', 640, 0.5)).out
const nGt = gt.reduce((a, g) => a + g.length, 0)
console.log('frames', frames.length, 'gt persons', nGt)
const configs = (
  process.env.CONFIGS ??
  'dfine_n.onnx:640:0.2,dfine_s.onnx:480:0.4,dfine_s.onnx:416:0.4,dfine_s_int8.onnx:640:0.4,dfine_s_int8.onnx:480:0.4'
)
  .split(',')
  .map((c) => {
    const [m, s, t] = c.split(':')
    return [m!, Number(s), Number(t)] as const
  })
for (const [model, size, thr] of configs) {
  const { out, ms } = await run(model, size, thr)
  let tp = 0,
    fp = 0,
    primary = 0,
    primaryN = 0
  out.forEach((dets, i) => {
    const g = gt[i]!
    for (const d of dets) {
      if (g.some((x) => boxIou(x, d) > 0.5)) tp++
      else fp++
    }
    if (g.length) {
      primaryN++
      const big = g.reduce((a, b) => (a.w * a.h > b.w * b.h ? a : b))
      if (dets.some((d) => boxIou(d, big) > 0.5)) primary++
    }
  })
  console.log(
    `${model}@${size} thr${thr}: recall ${(tp / nGt).toFixed(2)} precision ${(tp / Math.max(1, tp + fp)).toFixed(2)} primary-found ${(primary / primaryN).toFixed(2)} p25 ms ${ms.toFixed(0)}`,
  )
}
