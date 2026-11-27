/**
 * Cheap active-speaker cues for auto-reframe (no extra model):
 *
 * - **Mouth activity**: a 6×4 luma grid over the mouth region (from YuNet's nose and mouth
 *   corner landmarks) and the same over the eyes. The planner compares consecutive samples
 *   of a face track: lips moving change the mouth grid, head motion changes both, so the
 *   eye-region change is subtracted as a baseline.
 * - **Speech energy**: 100 ms RMS of the audio (decoded in parallel with the frames),
 *   normalised to the clip's own loud level, so a sample's mouth activity only counts
 *   while someone is actually talking.
 */
import type { Face } from './yunet.ts'

const GRID_W = 6
const GRID_H = 4

/** Mean luma (0..1) of a GRID_W×GRID_H grid over a box; undefined if it leaves the frame. */
export const lumaGrid = (
  rgb: Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
): Float32Array | undefined => {
  if (w < GRID_W || h < GRID_H || x0 < 0 || y0 < 0 || x0 + w > width || y0 + h > height) {
    return undefined
  }
  const out = new Float32Array(GRID_W * GRID_H)
  for (let gy = 0; gy < GRID_H; gy++) {
    const ya = Math.floor(y0 + (gy * h) / GRID_H)
    const yb = Math.max(ya + 1, Math.floor(y0 + ((gy + 1) * h) / GRID_H))
    for (let gx = 0; gx < GRID_W; gx++) {
      const xa = Math.floor(x0 + (gx * w) / GRID_W)
      const xb = Math.max(xa + 1, Math.floor(x0 + ((gx + 1) * w) / GRID_W))
      let s = 0
      let n = 0
      for (let y = ya; y < yb; y++) {
        for (let x = xa; x < xb; x++) {
          const i = (y * width + x) * 3
          s += 0.299 * (rgb[i] ?? 0) + 0.587 * (rgb[i + 1] ?? 0) + 0.114 * (rgb[i + 2] ?? 0)
          n++
        }
      }
      out[gy * GRID_W + gx] = n ? s / n / 255 : 0
    }
  }
  return out
}

/** Mouth and eye grids of a face (landmarks: r-eye, l-eye, nose, r-mouth, l-mouth). */
export const facePatches = (
  rgb: Uint8Array,
  width: number,
  height: number,
  face: Face,
): { mouth?: Float32Array; eyes?: Float32Array } => {
  const l = face.landmarks
  const [rex, rey, lex, ley, nx, ny, rmx, rmy, lmx, lmy] = Array.from(l)
  if (lmx === undefined || lmy === undefined || rmx === undefined || rmy === undefined) return {}
  if (nx === undefined || ny === undefined) return {}
  const mouthY = (rmy + lmy) / 2
  const drop = Math.max(2, mouthY - ny)
  const mw = Math.abs(lmx - rmx) * 1.4
  const mcx = (rmx + lmx) / 2
  const mouth = lumaGrid(
    rgb,
    width,
    height,
    Math.round(mcx - mw / 2),
    Math.round(ny + 0.3 * drop),
    Math.round(mw),
    Math.round(1.4 * drop),
  )
  let eyes: Float32Array | undefined
  if (rex !== undefined && rey !== undefined && lex !== undefined && ley !== undefined) {
    const ew = Math.abs(lex - rex) * 1.5
    const ecy = (rey + ley) / 2
    eyes = lumaGrid(
      rgb,
      width,
      height,
      Math.round((rex + lex) / 2 - ew / 2),
      Math.round(ecy - 0.5 * drop),
      Math.round(ew),
      Math.round(drop),
    )
  }
  return { ...(mouth ? { mouth } : {}), ...(eyes ? { eyes } : {}) }
}

/** Streaming RMS envelope (one value per `block` samples). */
export class RmsEnvelope {
  readonly block: number
  readonly values: number[] = []
  #acc = 0
  #n = 0
  constructor(block: number) {
    this.block = block
  }
  push(samples: Float32Array): void {
    for (const s of samples) {
      this.#acc += s * s
      if (++this.#n === this.block) {
        this.values.push(Math.sqrt(this.#acc / this.block))
        this.#acc = 0
        this.#n = 0
      }
    }
  }
}

/**
 * Speech energy 0..1 per envelope block: dB relative to the 90th-percentile level, mapped
 * from −30 dB (0) to −6 dB (1). Silent clips are all zero.
 */
export const speechLevels = (rms: readonly number[]): Float32Array => {
  const db = rms.map((v) => 20 * Math.log10(v + 1e-9))
  const sorted = db.toSorted((a, b) => a - b)
  const loud = sorted[Math.floor(sorted.length * 0.9)] ?? -120
  const out = new Float32Array(rms.length)
  if (loud < -60) return out
  for (let i = 0; i < db.length; i++) {
    out[i] = Math.min(1, Math.max(0, ((db[i] ?? -120) - (loud - 30)) / 24))
  }
  return out
}
