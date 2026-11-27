import path from 'node:path'
import { analyzeBeats, analyzeBeatsNeural } from '../src/ai/beats/index.ts'
import { findFfmpeg } from './ffmpeg.ts'
const m = 'C:/tmp/rf-tb/models'
const ff = findFfmpeg()
const consistency = (b: number[]) => {
  const ibi = b.slice(1).map((x, i) => x - b[i]!)
  const s = [...ibi].sort((a, c) => a - c)
  const med = s[s.length >> 1]!
  return ibi.filter((x) => Math.abs(x - med) < 0.1 * med).length / ibi.length
}
for (const file of process.argv.slice(2)) {
  for (const e of (process.env.ENGINES ?? 'dsp,beat_this_final0_static.onnx').split(',')) {
    const t0 = performance.now()
    const r =
      e === 'dsp'
        ? await analyzeBeats({ ffmpeg: ff, file })
        : await analyzeBeatsNeural({
            ffmpeg: ff,
            file,
            channels: 2,
            model: {
              model: path.join(m, e),
              filterbank: path.join(m, 'beat_this_mel_filterbank.bin'),
            },
          })
    console.log(
      path.basename(file).padEnd(36),
      e.padEnd(22),
      'bpm',
      r.bpm.toFixed(1).padStart(6),
      'beats',
      String(r.beats.length).padStart(4),
      'down',
      String(r.downbeats.length).padStart(4),
      'consist',
      consistency(r.beats).toFixed(2),
      ((performance.now() - t0) / 1000).toFixed(2) + 's',
    )
  }
}
