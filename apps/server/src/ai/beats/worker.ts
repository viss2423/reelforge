/**
 * Beat-analysis worker: receives PCM chunks (transferred, zero-copy) while FFmpeg is still
 * decoding, so the STFT overlaps with decode and the main event loop never does DSP.
 *
 * Protocol (parent → worker): an optional first `{ type: 'mel', filterbank }` switches the
 * worker from the DSP beat tracker to computing the Beat This! log-mel spectrogram; then
 * `{ type: 'samples', data: Float32Array }`… and `{ type: 'end' }`.
 * (worker → parent): `{ type: 'result', result }` (DSP) | `{ type: 'spect', spect, frames }`
 * (mel) | `{ type: 'error', message }`.
 */
import { parentPort } from 'node:worker_threads'
import { LogMelStream } from './mel.ts'
import { BeatAnalyzer, type BeatResult } from './tracker.ts'

export type BeatWorkerIn =
  | { type: 'mel'; filterbank: Float32Array }
  | { type: 'samples'; data: Float32Array }
  | { type: 'end' }
export type BeatWorkerOut =
  | { type: 'result'; result: BeatResult }
  | { type: 'spect'; spect: Float32Array; frames: number }
  | { type: 'error'; message: string }

const port = parentPort
if (!port) throw new Error('beats/worker.ts must run in a worker thread')

let analyzer: BeatAnalyzer | LogMelStream = new BeatAnalyzer()
port.on('message', (msg: BeatWorkerIn) => {
  try {
    if (msg.type === 'mel') {
      analyzer = new LogMelStream(msg.filterbank)
    } else if (msg.type === 'samples') {
      analyzer.push(msg.data)
    } else if (analyzer instanceof LogMelStream) {
      const spect = analyzer.finish()
      const out: BeatWorkerOut = { type: 'spect', spect, frames: analyzer.frames }
      port.postMessage(out, [spect.buffer as ArrayBuffer])
    } else {
      const out: BeatWorkerOut = { type: 'result', result: analyzer.finish() }
      port.postMessage(out)
    }
  } catch (err) {
    const out: BeatWorkerOut = {
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    }
    port.postMessage(out)
  }
})
