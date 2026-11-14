import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { LruCache } from '../lru.ts'
import { MemoryByteSource } from '../media/byteSource.ts'
import { readMp4Info } from '../media/mp4.ts'
import { HAS_FFMPEG, ffmpegRaw, makeProxy, readBytes, tempDir } from '../test/ffmpeg.ts'
import { asset, audio, mainTrack, project, track, video } from '../test/model.ts'
import { mainTrackLayout } from '../timeline/layout.ts'
import { parseAsc, toAdts } from './adts.ts'
import {
  DUCK_GAIN,
  DUCK_RELEASE_US,
  collectVoices,
  duckFactorAt,
  duckIntervals,
  planPieces,
  voiceGainAt,
  type Piece,
  type Voice,
} from './voices.ts'

const S = 1_000_000

describe('ADTS', () => {
  it('parses AudioSpecificConfig (LC 48 kHz stereo, explicit rate, escape AOT)', () => {
    expect(parseAsc(Uint8Array.of(0x11, 0x90))).toEqual({
      objectType: 2,
      frequencyIndex: 3,
      sampleRate: 48000,
      channelConfig: 2,
    })
    // AOT 2, index 15, explicit 50000 Hz, 1 channel
    const explicit = parseAsc(Uint8Array.of(0x17, 0x80, 0x61, 0xa8, 0x08))
    expect(explicit.sampleRate).toBe(50000)
    expect(explicit.channelConfig).toBe(1)
    expect(parseAsc(Uint8Array.of(0xf8, 0x20, 0x00)).objectType).toBe(33)
  })

  it('writes valid headers', () => {
    const out = toAdts({ objectType: 2, frequencyIndex: 4, sampleRate: 44100, channelConfig: 2 }, [
      new Uint8Array(10),
      new Uint8Array(300),
    ])
    expect(out.byteLength).toBe(10 + 300 + 14)
    expect(out[0]).toBe(0xff)
    expect(out[1]! & 0xf6).toBe(0xf0)
    const len = ((out[3]! & 3) << 11) | (out[4]! << 3) | (out[5]! >> 5)
    expect(len).toBe(17)
    expect(out[17]).toBe(0xff) // second header right after the first frame
    expect((out[2]! >> 2) & 0xf).toBe(4)
  })
})

describe.skipIf(!HAS_FFMPEG)('ADTS from demuxed proxy audio decodes like the MP4', () => {
  const tmp = tempDir()
  afterAll(tmp.cleanup)

  it('produces bit-identical PCM to decoding the MP4 (after the priming edit)', async () => {
    const file = makeProxy(path.join(tmp.dir, 'p.mp4'), { seconds: 2 })
    const bytes = readBytes(file)
    const info = await readMp4Info(new MemoryByteSource(bytes))
    const a = info.audio!
    expect(a.codec).toBe('mp4a.40.2')
    const cfg = parseAsc(a.description!)
    expect(cfg.sampleRate).toBe(48000)
    const s = a.samples
    const frames: Uint8Array[] = []
    for (let i = 0; i < s.count; i++) {
      frames.push(bytes.subarray(s.offset[i]!, s.offset[i]! + s.size[i]!))
    }
    const aac = path.join(tmp.dir, 'p.aac')
    writeFileSync(aac, toAdts(cfg, frames))
    const pcm = (f: string) => {
      const b = ffmpegRaw(['-i', f, '-map', '0:a', '-f', 'f32le', '-ac', '1', 'pipe:1'])
      return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4)
    }
    const fromAdts = pcm(aac)
    const fromMp4 = pcm(file)
    // the first frame's cts is negative: the edit list skips the encoder priming
    const priming = Math.round((-s.cts[0]! * cfg.sampleRate) / 1e6)
    expect(priming).toBe(1024)
    let maxErr = 0
    for (let i = 0; i < fromMp4.length - 2048; i++) {
      maxErr = Math.max(maxErr, Math.abs(fromAdts[i + priming]! - fromMp4[i]!))
    }
    expect(maxErr).toBeLessThan(1e-6)
  })
})

describe('LruCache', () => {
  it('evicts least recently used by size and calls onEvict', () => {
    const evicted: string[] = []
    const c = new LruCache<string, number>(10, (k) => evicted.push(k))
    c.set('a', 1, 4)
    c.set('b', 2, 4)
    expect(c.get('a')).toBe(1) // a is now most recent
    c.set('c', 3, 4)
    expect(evicted).toEqual(['b'])
    expect(c.has('a')).toBe(true)
    expect(c.size).toBe(8)
    c.set('huge', 9, 50) // larger than the budget: kept alone
    expect(c.count).toBe(1)
    expect(c.peek('huge')).toBe(9)
    expect(c.delete('huge')).toBe(true)
    expect(c.delete('nope')).toBe(false)
    c.set('x', 1, 1)
    c.clear()
    expect(c.size).toBe(0)
    expect(evicted).toContain('x')
  })
})

describe('voices', () => {
  const assets = {
    a1: asset(),
    m1: asset({ id: 'm1', kind: 'audio', hasVideo: false }),
    silent: asset({ id: 'silent', hasAudio: false }),
  }

  it('collects main (with transition crossfades), overlay video and audio clips', () => {
    const v1 = video({ duration: 2 * S, audio: { fadeIn: 100_000 } })
    const v2 = video({ duration: 2 * S, transitionIn: { type: 'fade', duration: 500_000 } })
    const v3 = video({ duration: 2 * S, assetId: 'silent' })
    const main = mainTrack([v1, v2, v3])
    const music = audio({ start: 0, duration: 5 * S, duckUnderVoice: true })
    const vo = audio({ start: S, duration: S, role: 'voiceover' })
    const p = project([main, track('audio', [music, vo])])
    const voices = collectVoices(p, mainTrackLayout(main), assets)
    expect(voices.map((v) => v.clipId)).toEqual([v1.id, music.id, vo.id, v2.id])
    const [a, m, , b] = voices as [Voice, Voice, Voice, Voice]
    expect(a.fadeOut).toBe(500_000)
    expect(a.fadeIn).toBe(100_000)
    expect(b.start).toBe(1_500_000)
    expect(b.fadeIn).toBe(500_000)
    expect(m.duck).toBe(true)
    expect(m.dialogue).toBe(false)
    // crossfade gains sum to the volume across the overlap
    for (const t of [1_500_000, 1_700_000, 1_999_999]) {
      expect(voiceGainAt(a, t) + voiceGainAt(b, t)).toBeCloseTo(1, 4)
    }
  })

  it('honours muted tracks/clips, zero volume and solo', () => {
    const v1 = video({ duration: S })
    const main = mainTrack([v1])
    const muted = track('audio', [audio({ duration: S })], { muted: true })
    const quiet = track('audio', [audio({ duration: S, audio: { volume: 0 } })])
    const loud = track('audio', [audio({ duration: S })])
    const p = project([main, muted, quiet, loud])
    const L = mainTrackLayout(main)
    expect(collectVoices(p, L, assets)).toHaveLength(2)
    expect(collectVoices(p, L, assets, { solo: new Set([loud.id]) })).toHaveLength(1)
    expect(collectVoices(p, L, {})).toHaveLength(0)
  })

  it('fades are linear and gain is zero outside the voice', () => {
    const v = { start: 0, end: 10, volume: 2, fadeIn: 4, fadeOut: 2 } as Voice
    expect(voiceGainAt(v, -1)).toBe(0)
    expect(voiceGainAt(v, 2)).toBe(1)
    expect(voiceGainAt(v, 5)).toBe(2)
    expect(voiceGainAt(v, 9)).toBe(1)
    expect(voiceGainAt(v, 10)).toBe(0)
  })

  it('ducking merges close dialogue and ramps', () => {
    const d = (start: number, end: number) => ({ start, end, dialogue: true }) as Voice
    const iv = duckIntervals([d(0, S), d(S + DUCK_RELEASE_US / 2, 2 * S), d(5 * S, 6 * S)])
    expect(iv).toEqual([
      { start: 0, end: 2 * S },
      { start: 5 * S, end: 6 * S },
    ])
    expect(duckFactorAt(iv, 0)).toBe(1)
    expect(duckFactorAt(iv, S)).toBeCloseTo(DUCK_GAIN)
    expect(duckFactorAt(iv, 2 * S + DUCK_RELEASE_US / 2)).toBeCloseTo((1 + DUCK_GAIN) / 2)
    expect(duckFactorAt(iv, 3 * S)).toBe(1)
  })

  it('plans forward pieces across segment boundaries with speed', () => {
    const v = { start: 1 * S, end: 3 * S, in: 4 * S, speed: 2, reverse: false } as Voice
    const out: Piece[] = []
    const n = planPieces(v, 0, 10 * S, 3 * S, out)
    // source [4s, 8s) on a 3 s grid → [4,6) [6,8)
    expect(out.slice(0, n)).toEqual([
      { seg: 1, when: 1 * S, srcStart: 4 * S, srcEnd: 6 * S },
      { seg: 2, when: 2 * S, srcStart: 6 * S, srcEnd: 8 * S },
    ])
    // window starting mid-voice
    const m = planPieces(v, 2.5 * S, 2.75 * S, 3 * S, out)
    expect(out.slice(0, m)).toEqual([{ seg: 2, when: 2.5 * S, srcStart: 7 * S, srcEnd: 7.5 * S }])
    expect(planPieces(v, 4 * S, 5 * S, 3 * S, out)).toBe(0)
  })

  it('plans reversed pieces in timeline order with descending source', () => {
    const v = { start: 0, end: 2 * S, in: 0, speed: 1, reverse: true } as Voice
    const out: Piece[] = []
    const n = planPieces(v, 0, 2 * S, 1.5 * S, out)
    expect(out.slice(0, n)).toEqual([
      { seg: 1, when: 0, srcStart: 1.5 * S, srcEnd: 2 * S },
      { seg: 0, when: 0.5 * S, srcStart: 0, srcEnd: 1.5 * S },
    ])
  })
})
