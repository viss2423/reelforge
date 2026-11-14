import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HAS_FFMPEG, makeProxy, probePackets, readBytes, tempDir } from '../test/ffmpeg.ts'
import { MemoryByteSource, type ByteSource } from './byteSource.ts'
import {
  __test,
  byteSpan,
  frameRankAt,
  keyframeBefore,
  Mp4Error,
  parseMoov,
  readMp4Info,
  type Mp4Track,
} from './mp4.ts'

/** Counts reads so we can assert the faststart path costs a single request. */
class CountingSource implements ByteSource {
  reads: Array<[number, number]> = []
  readonly #inner: MemoryByteSource
  constructor(bytes: Uint8Array) {
    this.#inner = new MemoryByteSource(bytes)
  }
  get size(): number {
    return this.#inner.size
  }
  read(offset: number, length: number): Promise<Uint8Array> {
    this.reads.push([offset, length])
    return this.#inner.read(offset, length)
  }
}

function expectMatchesProbe(file: string, track: Mp4Track, streamIndex: number): void {
  const packets = probePackets(file).filter((p) => p.stream === streamIndex)
  const s = track.samples
  expect(s.count).toBe(packets.length)
  // ffprobe lists packets in file (decode) order per stream
  for (let i = 0; i < s.count; i++) {
    const p = packets[i]!
    expect(s.offset[i]).toBe(p.pos)
    expect(s.size[i]).toBe(p.size)
    expect(Math.abs(s.cts[i]! - p.pts)).toBeLessThanOrEqual(1)
    expect(Math.abs(s.dts[i]! - p.dts)).toBeLessThanOrEqual(1)
    expect(s.key[i] === 1).toBe(p.key)
  }
}

describe.skipIf(!HAS_FFMPEG)('mp4 demuxer on ffmpeg-generated files', () => {
  const tmp = tempDir()
  let proxy: string
  let slow: string
  let bframes: string
  let rotated: string
  let hevc: string

  beforeAll(() => {
    proxy = makeProxy(path.join(tmp.dir, 'proxy.mp4'), { seconds: 3 })
    slow = makeProxy(path.join(tmp.dir, 'slow.mp4'), { seconds: 2, faststart: false })
    bframes = makeProxy(path.join(tmp.dir, 'bf.mp4'), { seconds: 2, bframes: 2, gop: 30 })
    rotated = makeProxy(path.join(tmp.dir, 'rot.mp4'), { seconds: 1, rotation: 90, audio: false })
    hevc = makeProxy(path.join(tmp.dir, 'hevc.mp4'), {
      seconds: 1,
      codec: 'libx265',
      audio: false,
      width: 320,
      height: 240,
    })
  })
  afterAll(() => tmp.cleanup())

  it('parses the proxy format with one read and exact sample tables', async () => {
    const bytes = readBytes(proxy)
    const src = new CountingSource(bytes)
    const info = await readMp4Info(src)
    expect(src.reads).toHaveLength(1)
    const v = info.video!
    const a = info.audio!
    expect(v.codec).toMatch(/^avc1\.64/) // High profile
    expect(v.width).toBe(540)
    expect(v.height).toBe(960)
    expect(v.rotation).toBe(0)
    expect(v.description?.[0]).toBe(1) // avcC configurationVersion
    expect(v.samples.count).toBe(90)
    // GOP 15 → keyframes every 15 frames, no B-frames → decode order == presentation order
    for (let i = 0; i < v.samples.count; i++) {
      expect(v.samples.key[i]).toBe(i % 15 === 0 ? 1 : 0)
      expect(v.samples.presentation[i]).toBe(i)
    }
    expect(v.duration).toBe(3_000_000)
    expect(a.codec).toBe('mp4a.40.2')
    expect(a.sampleRate).toBe(48_000)
    expect(a.channels).toBe(1)
    expect(a.description).toBeDefined()
    // AAC priming is removed by the edit list → first packet starts before 0
    expect(a.samples.cts[0]).toBe(-21_333)
    const order = probePackets(proxy)
    const vIndex = order.find((p) => p.pos === v.samples.offset[0])!.stream
    expectMatchesProbe(proxy, v, vIndex)
    expectMatchesProbe(proxy, a, 1 - vIndex)
  })

  it('finds moov at the end of non-faststart files', async () => {
    const src = new CountingSource(readBytes(slow))
    const info = await readMp4Info(src)
    expect(info.video?.samples.count).toBe(60)
    expect(src.reads.length).toBeGreaterThan(1)
    expect(src.reads.length).toBeLessThanOrEqual(4)
  })

  it('handles B-frames: ctts, presentation order and edit lists', async () => {
    const info = await readMp4Info(new MemoryByteSource(readBytes(bframes)))
    const v = info.video!
    const s = v.samples
    let reordered = false
    for (let i = 0; i < s.count; i++) if (s.presentation[i] !== i) reordered = true
    expect(reordered).toBe(true)
    // presentation order is strictly increasing in cts and starts at 0
    expect(s.cts[s.presentation[0]!]).toBe(0)
    for (let r = 1; r < s.count; r++) {
      expect(s.cts[s.presentation[r]!]!).toBeGreaterThan(s.cts[s.presentation[r - 1]!]!)
      expect(s.rank[s.presentation[r]!]).toBe(r)
    }
    expectMatchesProbe(bframes, v, 0)
  })

  it('reads the display rotation from the track matrix', async () => {
    const info = await readMp4Info(new MemoryByteSource(readBytes(rotated)))
    // ffmpeg -display_rotation is counter-clockwise; the matrix stores the clockwise turn
    expect(info.video?.rotation).toBe(270)
    expect(info.audio).toBeUndefined()
  })

  it('builds an HEVC codec string', async () => {
    const info = await readMp4Info(new MemoryByteSource(readBytes(hevc)))
    expect(info.video?.codec).toMatch(/^hvc1\.1\.6\.L\d+/)
  })

  it('frameRankAt / keyframeBefore / byteSpan', async () => {
    const info = await readMp4Info(new MemoryByteSource(readBytes(proxy)))
    const s = info.video!.samples
    expect(frameRankAt(s, -5)).toBe(0)
    expect(frameRankAt(s, 0)).toBe(0)
    expect(frameRankAt(s, 33_332)).toBe(0)
    expect(frameRankAt(s, 33_334)).toBe(1)
    expect(frameRankAt(s, 1_000_000)).toBe(30)
    expect(frameRankAt(s, 99_000_000)).toBe(89)
    expect(keyframeBefore(s, 29)).toBe(15)
    expect(keyframeBefore(s, 30)).toBe(30)
    const span = byteSpan(s, 15, 29)
    expect(span.start).toBe(s.offset[15])
    expect(span.end).toBe(s.offset[29]! + s.size[29]!)
  })
})

describe('mp4 demuxer edge cases', () => {
  it('rejects non-moov input and files without moov', async () => {
    expect(() => parseMoov(new Uint8Array([0, 0, 0, 8, 0x66, 0x72, 0x65, 0x65]))).toThrow(Mp4Error)
    const ftypOnly = new Uint8Array(24)
    new DataView(ftypOnly.buffer).setUint32(0, 24)
    ftypOnly.set([0x66, 0x74, 0x79, 0x70], 4)
    await expect(readMp4Info(new MemoryByteSource(ftypOnly))).rejects.toThrow(/no moov/)
  })

  it('codec strings for AV1, HEVC and AAC descriptors', () => {
    // av1C: marker/version, seq_profile=0 level=8, tier 0, 8-bit
    expect(__test.av1Codec(new Uint8Array([0x81, 0x08, 0x0c, 0x00]))).toBe('av01.0.08M.08')
    // esds with AAC-LC ASC (0x11 0x90 → aot 2)
    const esds = new Uint8Array([
      0, 0, 0, 0, 0x03, 0x19, 0x00, 0x01, 0x00, 0x04, 0x11, 0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0x05, 0x02, 0x11, 0x90,
    ])
    const parsed = __test.parseEsds(esds)
    expect(parsed.objectType).toBe(0x40)
    expect([...parsed.asc!]).toEqual([0x11, 0x90])
    expect(__test.aacCodec(0x40, parsed.asc)).toBe('mp4a.40.2')
    expect(__test.aacCodec(0x6b, undefined)).toBe('mp3')
  })
})
