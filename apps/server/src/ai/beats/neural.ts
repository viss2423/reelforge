/**
 * Beat This! (Foscarin, Schlüter & Widmer, ISMIR 2024; MIT, JKU Linz) — neural beat and
 * downbeat tracking with onnxruntime. The network sees a log-mel spectrogram (mel.ts) and
 * emits per-frame beat/downbeat logits at 50 fps; long pieces are split into overlapping
 * 30 s windows exactly like the reference `split_piece` / `aggregate_prediction`
 * (`keep_first`), and peaks are picked with the reference "minimal" post-processing (no DBN):
 * local maxima within ±3 frames with a positive logit, adjacent peaks merged, downbeats
 * snapped to the nearest beat.
 */
import { MEL_BANDS, MEL_FPS } from './mel.ts'
import type { BeatResult } from './tracker.ts'
import { bpmFromBeats } from './tracker.ts'

/** Frames per network window (30 s) and frames discarded at each window edge. */
export const CHUNK = 1500
export const BORDER = 6

/** Window start frames (may be negative: the first window is zero-padded on the left). */
export const splitStarts = (frames: number, chunk = CHUNK, border = BORDER): number[] => {
  const starts: number[] = []
  for (let s = -border; s < frames - border; s += chunk - 2 * border) starts.push(s)
  // Avoid a short last window: align it with the end of the piece.
  if (frames > chunk - 2 * border && starts.length > 0)
    starts[starts.length - 1] = frames - (chunk - border)
  return starts
}

/** Copy one (zero-padded) window of the [frames, 128] spectrogram; returns its length. */
export const windowAt = (
  spect: Float32Array,
  frames: number,
  start: number,
  chunk = CHUNK,
  border = BORDER,
): { data: Float32Array; length: number } => {
  const from = Math.max(start, 0)
  const to = Math.min(start + chunk, frames)
  const left = Math.max(0, -start)
  const right = Math.max(0, Math.min(border, start + chunk - frames))
  const length = left + (to - from) + right
  const data = new Float32Array(length * MEL_BANDS)
  data.set(spect.subarray(from * MEL_BANDS, to * MEL_BANDS), left * MEL_BANDS)
  return { data, length }
}

/**
 * Stitch per-window logits into full-length arrays. Earlier windows win where windows
 * overlap (`keep_first`); each window's `border` frames at both ends are discarded.
 */
export const aggregate = (
  windows: ReadonlyArray<{ start: number; beat: Float32Array; downbeat: Float32Array }>,
  frames: number,
  border = BORDER,
): { beat: Float32Array; downbeat: Float32Array } => {
  const beat = new Float32Array(frames).fill(-1000)
  const downbeat = new Float32Array(frames).fill(-1000)
  for (let w = windows.length - 1; w >= 0; w--) {
    const win = windows[w]
    if (!win) continue
    const len = win.beat.length - 2 * border
    for (let i = 0; i < len; i++) {
      const t = win.start + border + i
      if (t < 0 || t >= frames) continue
      beat[t] = win.beat[border + i] ?? -1000
      downbeat[t] = win.downbeat[border + i] ?? -1000
    }
  }
  return { beat, downbeat }
}

/** Frames that are local maxima within ±`radius` with a logit above `threshold`. */
export const pickPeaks = (logits: Float32Array, radius = 3, threshold = 0): number[] => {
  const peaks: number[] = []
  const n = logits.length
  for (let i = 0; i < n; i++) {
    const v = logits[i] ?? -Infinity
    if (!(v > threshold)) continue
    let isMax = true
    for (let k = Math.max(0, i - radius); k <= Math.min(n - 1, i + radius); k++) {
      if ((logits[k] ?? -Infinity) > v) {
        isMax = false
        break
      }
    }
    if (isMax) peaks.push(i)
  }
  return peaks
}

/** Merge runs of peaks closer than `width` frames into their running mean position. */
export const deduplicatePeaks = (peaks: readonly number[], width = 1): number[] => {
  const out: number[] = []
  let p: number | undefined
  let c = 1
  for (const q of peaks) {
    if (p === undefined) {
      p = q
      c = 1
    } else if (q - p <= width) {
      c++
      p += (q - p) / c
    } else {
      out.push(p)
      p = q
      c = 1
    }
  }
  if (p !== undefined) out.push(p)
  return out
}

/** Logits → beat/downbeat times (us) and tempo. */
export const postprocess = (
  beatLogits: Float32Array,
  downbeatLogits: Float32Array,
  fps = MEL_FPS,
): BeatResult => {
  const beatSec = deduplicatePeaks(pickPeaks(beatLogits)).map((f) => f / fps)
  const downSec = deduplicatePeaks(pickPeaks(downbeatLogits)).map((f) => f / fps)
  const beats = beatSec.map((t) => Math.round(t * 1_000_000))
  // Downbeats snap to the nearest beat (the beat head is the more precise one).
  const down = new Set<number>()
  let j = 0
  for (const t of downSec) {
    if (beatSec.length === 0) break
    while (
      j + 1 < beatSec.length &&
      Math.abs((beatSec[j + 1] ?? 0) - t) <= Math.abs((beatSec[j] ?? 0) - t)
    )
      j++
    down.add(beats[j] ?? 0)
  }
  const bpm = bpmFromBeats(beatSec)
  return {
    bpm: Math.round(bpm * 100) / 100,
    beats,
    downbeats: [...down].toSorted((a, b) => a - b),
  }
}

/** Runs one window through the network: [len, 128] → beat and downbeat logits [len]. */
export type WindowRunner = (
  window: Float32Array,
  length: number,
) => Promise<{ beat: Float32Array; downbeat: Float32Array }>

/**
 * Full inference over a spectrogram. Windows run `concurrency` at a time (onnxruntime
 * sessions accept concurrent runs), so memory stays bounded while the cores stay busy.
 */
export const inferBeats = async (
  spect: Float32Array,
  run: WindowRunner,
  opts: {
    signal?: AbortSignal
    onProgress?: (fraction: number) => void
    concurrency?: number
  } = {},
): Promise<BeatResult> => {
  const frames = spect.length / MEL_BANDS
  if (frames < 2 * BORDER + 1) return { bpm: 0, beats: [], downbeats: [] }
  const starts = splitStarts(frames)
  const windows: Array<{ start: number; beat: Float32Array; downbeat: Float32Array }> = []
  let next = 0
  let done = 0
  const worker = async (): Promise<void> => {
    while (next < starts.length) {
      const k = next++
      const start = starts[k] ?? 0
      if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('aborted')
      const { data, length } = windowAt(spect, frames, start)
      windows[k] = { start, ...(await run(data, length)) }
      opts.onProgress?.(++done / starts.length)
    }
  }
  const lanes = Math.max(1, Math.min(opts.concurrency ?? 1, starts.length))
  await Promise.all(Array.from({ length: lanes }, worker))
  const { beat, downbeat } = aggregate(windows, frames)
  return postprocess(beat, downbeat)
}
