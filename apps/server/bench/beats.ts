/**
 * Beat-tracker benchmark: DSP vs Beat This! (small0 / final0, CPU / DirectML) on synthetic
 * music with exact ground truth. Usage:
 *   node bench/beats.ts <modelsDir> [outDir]
 * modelsDir holds beat_this_small0.onnx, beat_this_final0.onnx, beat_this_mel_filterbank.bin.
 */
import { mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { analyzeBeats, analyzeBeatsNeural } from '../src/ai/beats/index.ts'
import { releaseIdleSessions } from '../src/ai/onnx.ts'
import { fMeasure, STYLES, synthesize, writeWav } from '../test/ai/music-synth.ts'
import { findFfmpeg } from './ffmpeg.ts'

const models = process.argv[2] ?? 'C:/tmp/rf-tb/models'
const out = process.argv[3] ?? 'C:/tmp/rf-tb/beats'
const extra = process.argv.slice(4)
await mkdir(out, { recursive: true })
const ffmpeg = findFfmpeg()
const filterbank = path.join(models, 'beat_this_mel_filterbank.bin')
const engines: Array<{ name: string; model?: string; provider?: 'cpu' | 'dml' }> = [
  { name: 'dsp' },
  { name: 'small0-cpu', model: 'beat_this_small0.onnx', provider: 'cpu' },
  { name: 'small0-dml', model: 'beat_this_small0.onnx', provider: 'dml' },
  { name: 'final0-cpu', model: 'beat_this_final0.onnx', provider: 'cpu' },
]
  .filter((e) => (process.env.ENGINES ?? 'dsp,small0-cpu,final0-cpu').split(',').includes(e.name))
  .filter((e) => !e.model || existsSync(path.join(models, e.model)))

const tracks = process.env.LONG_ONLY ? [] : STYLES.map((s, i) => synthesize(s, 60, i + 1))
const rows: string[] = []
const sums = new Map<string, { f: number; d: number; bpm: number; t: number }>()
for (const tr of tracks) {
  const file = path.join(out, `${tr.name}.wav`)
  if (!existsSync(file)) await writeWav(file, tr.samples)
  for (const e of engines) {
    const t0 = performance.now()
    const r = e.model
      ? await analyzeBeatsNeural({
          ffmpeg,
          file,
          channels: 2,
          model: { model: path.join(models, e.model), filterbank },
          ...(e.provider ? { provider: e.provider } : {}),
        })
      : await analyzeBeats({ ffmpeg, file })
    const ms = performance.now() - t0
    const est = r.beats.map((b) => b / 1e6)
    const f = fMeasure(tr.beats, est)
    const d = fMeasure(
      tr.downbeats,
      r.downbeats.map((b) => b / 1e6),
    )
    const bpmOk = Math.abs(r.bpm - tr.bpm) / tr.bpm < 0.04 ? 1 : 0
    const s = sums.get(e.name) ?? { f: 0, d: 0, bpm: 0, t: 0 }
    sums.set(e.name, { f: s.f + f, d: s.d + d, bpm: s.bpm + bpmOk, t: s.t + ms })
    rows.push(
      `| ${tr.name} | ${e.name} | ${f.toFixed(3)} | ${d.toFixed(3)} | ${r.bpm.toFixed(1)} (${tr.bpm}) | ${ms.toFixed(0)} ms |`,
    )
  }
}
console.log(
  '| track | engine | beat F | downbeat F | BPM (truth) | time |\n|---|---|---|---|---|---|',
)
console.log(rows.join('\n'))
console.log(
  '\n| engine | mean beat F | mean downbeat F | BPM ±4 % | mean time (60 s) |\n|---|---|---|---|---|',
)
for (const [name, s] of tracks.length ? sums : []) {
  const n = tracks.length
  console.log(
    `| ${name} | ${(s.f / n).toFixed(3)} | ${(s.d / n).toFixed(3)} | ${s.bpm}/${n} | ${(s.t / n).toFixed(0)} ms |`,
  )
}
// Speed on a 3-minute track (warm sessions).
const long = synthesize(STYLES[0]!, 180, 99)
const longFile = path.join(out, 'long-180s.wav')
if (!existsSync(longFile)) await writeWav(longFile, long.samples)
console.log('\n| engine | 3-min track wall time | beat F |\n|---|---|---|')
for (const e of engines) {
  const times: number[] = []
  let f = 0
  for (let k = 0; k < Number(process.env.REPS ?? 3); k++) {
    const t0 = performance.now()
    const r = e.model
      ? await analyzeBeatsNeural({
          ffmpeg,
          file: longFile,
          channels: 2,
          model: { model: path.join(models, e.model), filterbank },
          ...(e.provider ? { provider: e.provider } : {}),
        })
      : await analyzeBeats({ ffmpeg, file: longFile })
    times.push(performance.now() - t0)
    f = fMeasure(
      long.beats,
      r.beats.map((b) => b / 1e6),
    )
  }
  console.log(
    `| ${e.name} | ${times.map((t) => (t / 1000).toFixed(2)).join(' / ')} s | ${f.toFixed(3)} |`,
  )
}
for (const file of extra) {
  for (const e of engines) {
    const t0 = performance.now()
    const r = e.model
      ? await analyzeBeatsNeural({
          ffmpeg,
          file,
          channels: 2,
          model: { model: path.join(models, e.model), filterbank },
          ...(e.provider ? { provider: e.provider } : {}),
        })
      : await analyzeBeats({ ffmpeg, file })
    console.log(
      `${path.basename(file)} ${e.name} bpm=${r.bpm} beats=${r.beats.length} down=${r.downbeats.length} ${(performance.now() - t0).toFixed(0)}ms`,
    )
  }
}
releaseIdleSessions()
