/**
 * Raw AAC (MP4 samples) → ADTS stream, so a slice of a proxy's audio track can be decoded
 * with `AudioContext.decodeAudioData` on every browser (Safari included) without fetching
 * the interleaved video bytes or needing WebCodecs' AudioDecoder.
 */

/** Sampling frequency table of ISO/IEC 14496-3 (index → Hz). */
const FREQS = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
]

export interface AacConfig {
  /** Audio object type (2 = AAC-LC). */
  objectType: number
  frequencyIndex: number
  sampleRate: number
  channelConfig: number
}

/** Parse an AudioSpecificConfig (the `esds` DecoderSpecificInfo). */
export function parseAsc(asc: Uint8Array): AacConfig {
  let bit = 0
  const read = (n: number): number => {
    let v = 0
    for (let i = 0; i < n; i++, bit++) {
      const byte = asc[bit >> 3] ?? 0
      v = (v << 1) | ((byte >> (7 - (bit & 7))) & 1)
    }
    return v
  }
  let objectType = read(5)
  if (objectType === 31) objectType = 32 + read(6)
  const frequencyIndex = read(4)
  const sampleRate = frequencyIndex === 15 ? read(24) : (FREQS[frequencyIndex] ?? 0)
  const channelConfig = read(4)
  return { objectType, frequencyIndex, sampleRate, channelConfig }
}

/**
 * Wrap raw AAC access units in 7-byte ADTS headers. `frames` are views of the raw sample
 * bytes in decode order. HE-AAC (SBR/PS) is signalled as AAC-LC, which decoders upgrade
 * implicitly — ADTS cannot carry object types above 4.
 */
export function toAdts(cfg: AacConfig, frames: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const f of frames) total += f.byteLength + 7
  const out = new Uint8Array(total)
  const profile = (cfg.objectType >= 1 && cfg.objectType <= 4 ? cfg.objectType : 2) - 1
  // ADTS needs a table index: map explicit rates to the nearest table entry
  let fi = cfg.frequencyIndex
  if (fi > 12) {
    let best = 0
    for (let i = 1; i < FREQS.length; i++) {
      if (Math.abs(FREQS[i]! - cfg.sampleRate) < Math.abs(FREQS[best]! - cfg.sampleRate)) best = i
    }
    fi = best
  }
  const ch = cfg.channelConfig & 7
  let at = 0
  for (const f of frames) {
    const len = f.byteLength + 7
    out[at] = 0xff
    out[at + 1] = 0xf1 // MPEG-4, layer 0, no CRC
    out[at + 2] = (profile << 6) | (fi << 2) | (ch >> 2)
    out[at + 3] = ((ch & 3) << 6) | (len >> 11)
    out[at + 4] = (len >> 3) & 0xff
    out[at + 5] = ((len & 7) << 5) | 0x1f // buffer fullness 0x7FF (VBR)
    out[at + 6] = 0xfc
    out.set(f, at + 7)
    at += len
  }
  return out
}
