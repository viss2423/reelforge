/**
 * Beat-tracking worker: receives PCM chunks (transferred, zero-copy) while FFmpeg is still
 * decoding, so the STFT overlaps with decode and the main event loop never does DSP.
 *
 * Protocol (parent → worker): { type: 'samples', data: Float32Array } | { type: 'end' }
 * (worker → parent): { type: 'result', result: BeatResult } | { type: 'error', message }
 */
import { parentPort } from 'node:worker_threads'
import { BeatAnalyzer, type BeatResult } from './tracker.ts'

export type BeatWorkerIn = { type: 'samples'; data: Float32Array } | { type: 'end' }
export type BeatWorkerOut =
  { type: 'result'; result: BeatResult } | { type: 'error'; message: string }

const port = parentPort
if (!port) throw new Error('beats/worker.ts must run in a worker thread')

const analyzer = new BeatAnalyzer()
port.on('message', (msg: BeatWorkerIn) => {
  try {
    if (msg.type === 'samples') {
      analyzer.push(msg.data)
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
