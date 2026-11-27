/** Detector speed/agreement benchmark on real frames: node bench/detectors.ts <video> [seconds] */
import * as ort from 'onnxruntime-node'
import { streamFrames, type RgbFrame } from '../src/ai/reframe/frames.ts'
import { decodeDetr, preprocessDetr, PERSON } from '../src/ai/reframe/objects.ts'
import { YunetDetector } from '../src/ai/reframe/detector.ts'
import { findFfmpeg } from './ffmpeg.ts'
const M = 'C:/tmp/rf-tb/models/'
const file = process.argv[2]!
const frames: RgbFrame[] = []
await streamFrames({
  ffmpeg: findFfmpeg(),
  file,
  fps: 2,
  width: 640,
  onFrame: async (f) => {
    if (frames.length < Number(process.argv[3] ?? 40)) frames.push(f)
  },
})
console.log('frames', frames.length, frames[0]!.width, frames[0]!.height)
const threads = Number(process.env.THREADS ?? 4)
const report = (name: string, times: number[], persons: number[]) => {
  const s = times.slice(2).sort((a, b) => a - b)
  console.log(
    name.padEnd(22),
    'median ms',
    s[s.length >> 1]!.toFixed(1),
    'min',
    s[0]!.toFixed(1),
    'persons/frame',
    (persons.reduce((a, b) => a + b, 0) / persons.length).toFixed(2),
  )
}
for (const [model, sizes] of [
  ['dfine_n.onnx', [640, 480, 416, 320]],
  ['dfine_s.onnx', [640]],
] as const) {
  const s = await ort.InferenceSession.create(M + model, {
    intraOpNumThreads: threads,
    graphOptimizationLevel: 'all',
  })
  for (const size of sizes) {
    const input = new Float32Array(3 * size * size)
    const times: number[] = []
    const persons: number[] = []
    for (const f of frames) {
      const t0 = performance.now()
      preprocessDetr(f.data, f.width, f.height, size, input)
      const r = await s.run({ pixel_values: new ort.Tensor('float32', input, [1, 3, size, size]) })
      const d = decodeDetr(
        r.logits!.data as Float32Array,
        r.pred_boxes!.data as Float32Array,
        80,
        f.width,
        f.height,
        0.5,
      )
      times.push(performance.now() - t0)
      persons.push(d.filter((x) => x.label === PERSON).length)
    }
    report(`${model}@${size}`, times, persons)
  }
}
{
  const s = await ort.InferenceSession.create(M + 'deimv2_pico.onnx', {
    intraOpNumThreads: threads,
    graphOptimizationLevel: 'all',
  })
  const input = new Float32Array(3 * 640 * 640)
  const times: number[] = []
  const persons: number[] = []
  for (const f of frames) {
    const t0 = performance.now()
    preprocessDetr(f.data, f.width, f.height, 640, input)
    const r = await s.run({
      images: new ort.Tensor('float32', input, [1, 3, 640, 640]),
      orig_target_sizes: new ort.Tensor(
        'int64',
        BigInt64Array.from([BigInt(f.width), BigInt(f.height)]),
        [1, 2],
      ),
    })
    const labels = r.labels!.data as BigInt64Array
    const scores = r.scores!.data as Float32Array
    let n = 0
    for (let i = 0; i < scores.length; i++) if (scores[i]! > 0.5 && labels[i] === 0n) n++
    times.push(performance.now() - t0)
    persons.push(n)
  }
  report('deimv2_pico@640', times, persons)
}
{
  const y = await YunetDetector.create(
    M.replace('rf-tb/models/', 'rf-tb/models/') + '../yunet.onnx',
  ).catch(() => undefined)
  if (y) {
    const times: number[] = []
    const persons: number[] = []
    for (const f of frames) {
      const t0 = performance.now()
      persons.push((await y.detect(f.data, f.width, f.height)).length)
      times.push(performance.now() - t0)
    }
    report('yunet@640 (faces)', times, persons)
  }
}
{
  const s = await ort.InferenceSession.create(M + 'u2netp.onnx', {
    intraOpNumThreads: threads,
    graphOptimizationLevel: 'all',
  })
  const input = new Float32Array(3 * 320 * 320)
  const times: number[] = []
  for (const f of frames) {
    const t0 = performance.now()
    preprocessDetr(f.data, f.width, f.height, 320, input)
    await s.run({ [s.inputNames[0]!]: new ort.Tensor('float32', input, [1, 3, 320, 320]) })
    times.push(performance.now() - t0)
  }
  report('u2netp@320 (saliency)', times, [0])
}
