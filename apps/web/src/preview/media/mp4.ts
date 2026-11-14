/**
 * Minimal, allocation-conscious ISO-BMFF (MP4) demuxer for the preview engine.
 *
 * Scope: progressive (non-fragmented) MP4/MOV files as produced by the server's proxy job
 * (H.264, short GOP, no B-frames, AAC, `+faststart`) and — as a best effort — originals that
 * are played without a proxy (HEVC/AV1/VP9, B-frames via `ctts`, edit lists, rotation).
 * Fragmented MP4 is out of scope (the engine falls back to <video> for those).
 *
 * The demuxer only parses `moov`; sample bytes are read lazily by the caller through a
 * {@link ByteSource}, so opening a 3-minute proxy costs one ~50 KB range request.
 */
import type { ByteSource } from './byteSource.ts'

export type TrackKind = 'video' | 'audio' | 'other'

/**
 * Sample table in struct-of-arrays form (decode order). All times are integer microseconds
 * on the PRESENTATION timeline (edit list applied), so `cts[i]` is directly comparable with
 * a clip's source time.
 */
export interface SampleTable {
  readonly count: number
  /** Byte offset in the file (Float64: files may exceed 4 GiB). */
  readonly offset: Float64Array
  readonly size: Uint32Array
  /** Decode timestamp (us). */
  readonly dts: Float64Array
  /** Presentation timestamp (us). */
  readonly cts: Float64Array
  /** Duration (us). */
  readonly duration: Float64Array
  /** 1 = sync sample (keyframe). */
  readonly key: Uint8Array
  /** Decode-order indices sorted by presentation time. */
  readonly presentation: Uint32Array
  /** Inverse of `presentation`: decode index → presentation rank. */
  readonly rank: Uint32Array
}

export interface Mp4Track {
  readonly id: number
  readonly kind: TrackKind
  /** Four-cc of the sample entry (`avc1`, `hvc1`, `mp4a`, …). */
  readonly format: string
  /** WebCodecs codec string, or '' when the format is unknown. */
  readonly codec: string
  /** Decoder configuration record (avcC/hvcC/av1C payload, or AudioSpecificConfig). */
  readonly description: Uint8Array | undefined
  readonly timescale: number
  /** Presentation duration (us). */
  readonly duration: number
  readonly width: number
  readonly height: number
  /** Clockwise display rotation from the track matrix: 0, 90, 180 or 270. */
  readonly rotation: 0 | 90 | 180 | 270
  readonly sampleRate: number
  readonly channels: number
  readonly samples: SampleTable
}

export interface Mp4Info {
  /** Movie duration (us). */
  readonly duration: number
  readonly tracks: readonly Mp4Track[]
  readonly video: Mp4Track | undefined
  readonly audio: Mp4Track | undefined
}

export class Mp4Error extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Mp4Error'
  }
}

/* ------------------------------------------------------------------ box reading */

const fourcc = (v: DataView, at: number): string =>
  String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3))

interface BoxHeader {
  type: string
  /** Absolute start of the box (relative to the view). */
  start: number
  /** Start of the payload. */
  body: number
  /** End of the box (exclusive). */
  end: number
}

/** Read a box header at `at`; `limit` bounds size==0 ("to end") boxes. */
function readBox(v: DataView, at: number, limit: number): BoxHeader | undefined {
  if (at + 8 > limit) return undefined
  let size = v.getUint32(at)
  const type = fourcc(v, at + 4)
  let body = at + 8
  if (size === 1) {
    if (at + 16 > limit) return undefined
    size = Number(v.getBigUint64(at + 8))
    body = at + 16
  } else if (size === 0) {
    size = limit - at
  }
  if (size < body - at) throw new Mp4Error(`corrupt box '${type}' at ${at}`)
  return { type, start: at, body, end: at + size }
}

function* children(v: DataView, from: number, to: number): Generator<BoxHeader> {
  let at = from
  while (at + 8 <= to) {
    const box = readBox(v, at, to)
    if (!box) return
    yield box
    if (box.end > to) return
    at = box.end
  }
}

function child(v: DataView, parent: BoxHeader, type: string): BoxHeader | undefined {
  for (const b of children(v, parent.body, parent.end)) if (b.type === type) return b
  return undefined
}

const fullBoxVersion = (v: DataView, box: BoxHeader): number => v.getUint8(box.body)

/* ------------------------------------------------------------------ codec strings */

const hex2 = (n: number): string => n.toString(16).padStart(2, '0')

function avcCodec(avcC: Uint8Array, format: string): string {
  if (avcC.length < 4) return format
  return `${format}.${hex2(avcC[1]!)}${hex2(avcC[2]!)}${hex2(avcC[3]!)}`
}

/** ISO/IEC 14496-15 Annex E codec string for HEVC. */
function hevcCodec(hvcC: Uint8Array, format: string): string {
  if (hvcC.length < 13) return format
  const b1 = hvcC[1]!
  const space = ['', 'A', 'B', 'C'][b1 >> 6] ?? ''
  const tier = (b1 >> 5) & 1 ? 'H' : 'L'
  const profile = b1 & 0x1f
  // compatibility flags are written bit-reversed
  let compat = (hvcC[2]! << 24) | (hvcC[3]! << 16) | (hvcC[4]! << 8) | hvcC[5]!
  let reversed = 0
  for (let i = 0; i < 32; i++) {
    reversed = (reversed << 1) | (compat & 1)
    compat >>>= 1
  }
  const level = hvcC[12]!
  const constraints: string[] = []
  for (let i = 6; i < 12; i++) constraints.push(hvc1ConstraintHex(hvcC[i]!))
  while (constraints.length > 0 && constraints[constraints.length - 1] === '0') constraints.pop()
  const tail = constraints.length > 0 ? `.${constraints.join('.')}` : ''
  return `${format}.${space}${profile}.${(reversed >>> 0).toString(16)}.${tier}${level}${tail}`
}
const hvc1ConstraintHex = (b: number): string => b.toString(16).toUpperCase()

function av1Codec(av1C: Uint8Array): string {
  if (av1C.length < 3) return 'av01'
  const profile = av1C[1]! >> 5
  const level = av1C[1]! & 0x1f
  const tier = av1C[2]! >> 7 ? 'H' : 'M'
  const highBitdepth = (av1C[2]! >> 6) & 1
  const twelveBit = (av1C[2]! >> 5) & 1
  const depth = highBitdepth ? (twelveBit ? 12 : 10) : 8
  return `av01.${profile}.${String(level).padStart(2, '0')}${tier}.${String(depth).padStart(2, '0')}`
}

function vp9Codec(vpcC: Uint8Array): string {
  // FullBox: 4 bytes version/flags, then profile, level, bitDepth(4 bits)…
  if (vpcC.length < 7) return 'vp09.00.10.08'
  const profile = vpcC[4]!
  const level = vpcC[5]!
  const depth = vpcC[6]! >> 4
  const p2 = (n: number): string => String(n).padStart(2, '0')
  return `vp09.${p2(profile)}.${p2(level)}.${p2(depth)}`
}

/** Read an MPEG-4 descriptor length (1–4 bytes, 7 bits each). */
function descriptorLength(b: Uint8Array, at: number): { len: number; next: number } {
  let len = 0
  let i = at
  for (let n = 0; n < 4 && i < b.length; n++) {
    const c = b[i++]!
    len = (len << 7) | (c & 0x7f)
    if ((c & 0x80) === 0) break
  }
  return { len, next: i }
}

/** Parse `esds` → { objectType, asc }. */
function parseEsds(esds: Uint8Array): { objectType: number; asc: Uint8Array | undefined } {
  let at = 4 // version + flags
  let objectType = 0
  let asc: Uint8Array | undefined
  while (at < esds.length) {
    const tag = esds[at]!
    const { len, next } = descriptorLength(esds, at + 1)
    if (tag === 0x03) {
      // ES_Descriptor: ES_ID(2) flags(1) [+2 dependsOn] [+len+URL] [+2 OCR]
      let p = next + 2
      const flags = esds[p++]!
      if (flags & 0x80) p += 2
      if (flags & 0x40) p += 1 + esds[p]!
      if (flags & 0x20) p += 2
      at = p
      continue
    }
    if (tag === 0x04) {
      objectType = esds[next]!
      at = next + 13 // objectType(1) streamType(1) bufferSize(3) maxBitrate(4) avgBitrate(4)
      continue
    }
    if (tag === 0x05) {
      asc = esds.slice(next, next + len)
      break
    }
    at = next + len
  }
  return { objectType, asc }
}

function aacCodec(objectType: number, asc: Uint8Array | undefined): string {
  if (objectType === 0x6b || objectType === 0x69) return 'mp3'
  if (objectType !== 0x40 || !asc || asc.length === 0)
    return objectType ? `mp4a.${hex2(objectType)}` : ''
  let aot = asc[0]! >> 3
  if (aot === 31 && asc.length > 1) aot = 32 + (((asc[0]! & 7) << 3) | (asc[1]! >> 5))
  return `mp4a.40.${aot}`
}

/* ------------------------------------------------------------------ track parsing */

interface RawTrack {
  id: number
  kind: TrackKind
  rotation: 0 | 90 | 180 | 270
  timescale: number
  format: string
  codec: string
  description: Uint8Array | undefined
  width: number
  height: number
  sampleRate: number
  channels: number
  /** Edit list: media time (track ticks) where presentation starts; and empty lead-in (us). */
  mediaTime: number
  leadIn: number
  stts: Uint32Array | undefined
  ctts: Int32Array | undefined
  stss: Uint32Array | undefined
  stsz: { fixed: number; sizes: Uint32Array | undefined; count: number } | undefined
  stsc: Uint32Array | undefined
  chunkOffsets: Float64Array | undefined
}

function matrixRotation(v: DataView, at: number): 0 | 90 | 180 | 270 {
  const a = v.getInt32(at) / 65536
  const b = v.getInt32(at + 4) / 65536
  const deg = Math.round((Math.atan2(b, a) * 180) / Math.PI)
  const norm = ((deg % 360) + 360) % 360
  if (norm === 90 || norm === 180 || norm === 270) return norm
  return 0
}

function u32Table(v: DataView, at: number, n: number, stride: number): Uint32Array {
  const out = new Uint32Array(n * stride)
  for (let i = 0; i < out.length; i++) out[i] = v.getUint32(at + i * 4)
  return out
}

function parseTrak(v: DataView, trak: BoxHeader, movieTimescale: number): RawTrack | undefined {
  const t: RawTrack = {
    id: 0,
    kind: 'other',
    rotation: 0,
    timescale: 0,
    format: '',
    codec: '',
    description: undefined,
    width: 0,
    height: 0,
    sampleRate: 0,
    channels: 0,
    mediaTime: 0,
    leadIn: 0,
    stts: undefined,
    ctts: undefined,
    stss: undefined,
    stsz: undefined,
    stsc: undefined,
    chunkOffsets: undefined,
  }
  const tkhd = child(v, trak, 'tkhd')
  if (tkhd) {
    const ver = fullBoxVersion(v, tkhd)
    t.id = v.getUint32(tkhd.body + (ver === 1 ? 20 : 12))
    const matrixAt = tkhd.body + (ver === 1 ? 52 : 40)
    if (matrixAt + 36 <= tkhd.end) t.rotation = matrixRotation(v, matrixAt)
  }
  const edts = child(v, trak, 'edts')
  const elst = edts && child(v, edts, 'elst')
  const mdia = child(v, trak, 'mdia')
  if (!mdia) return undefined
  const mdhd = child(v, mdia, 'mdhd')
  if (mdhd) t.timescale = v.getUint32(mdhd.body + (fullBoxVersion(v, mdhd) === 1 ? 20 : 12))
  const hdlr = child(v, mdia, 'hdlr')
  if (hdlr) {
    const h = fourcc(v, hdlr.body + 8)
    t.kind = h === 'vide' ? 'video' : h === 'soun' ? 'audio' : 'other'
  }
  if (elst) {
    const ver = fullBoxVersion(v, elst)
    const n = v.getUint32(elst.body + 4)
    let p = elst.body + 8
    for (let i = 0; i < n; i++) {
      const segDur = ver === 1 ? Number(v.getBigUint64(p)) : v.getUint32(p)
      const mediaTime = ver === 1 ? Number(v.getBigInt64(p + 8)) : v.getInt32(p + 4)
      p += ver === 1 ? 20 : 12
      if (mediaTime === -1) {
        t.leadIn += movieTimescale > 0 ? Math.round((segDur * 1e6) / movieTimescale) : 0
        continue
      }
      t.mediaTime = mediaTime
      break // only the first non-empty edit is honoured (all our producers write one)
    }
  }
  const minf = child(v, mdia, 'minf')
  const stbl = minf && child(v, minf, 'stbl')
  if (!stbl || t.timescale === 0) return undefined
  for (const b of children(v, stbl.body, stbl.end)) {
    switch (b.type) {
      case 'stsd':
        parseStsd(v, b, t)
        break
      case 'stts':
        t.stts = u32Table(v, b.body + 8, v.getUint32(b.body + 4), 2)
        break
      case 'ctts': {
        const n = v.getUint32(b.body + 4)
        const out = new Int32Array(n * 2)
        for (let i = 0; i < n; i++) {
          out[i * 2] = v.getUint32(b.body + 8 + i * 8)
          // version 0 is unsigned per spec, but every real-world muxer writes it as signed
          out[i * 2 + 1] = v.getInt32(b.body + 12 + i * 8)
        }
        t.ctts = out
        break
      }
      case 'stss':
        t.stss = u32Table(v, b.body + 8, v.getUint32(b.body + 4), 1)
        break
      case 'stsz': {
        const fixed = v.getUint32(b.body + 4)
        const count = v.getUint32(b.body + 8)
        t.stsz = {
          fixed,
          count,
          sizes: fixed === 0 ? u32Table(v, b.body + 12, count, 1) : undefined,
        }
        break
      }
      case 'stsc':
        t.stsc = u32Table(v, b.body + 8, v.getUint32(b.body + 4), 3)
        break
      case 'stco': {
        const n = v.getUint32(b.body + 4)
        const out = new Float64Array(n)
        for (let i = 0; i < n; i++) out[i] = v.getUint32(b.body + 8 + i * 4)
        t.chunkOffsets = out
        break
      }
      case 'co64': {
        const n = v.getUint32(b.body + 4)
        const out = new Float64Array(n)
        for (let i = 0; i < n; i++) out[i] = Number(v.getBigUint64(b.body + 8 + i * 8))
        t.chunkOffsets = out
        break
      }
      default:
        break
    }
  }
  return t
}

function parseStsd(v: DataView, stsd: BoxHeader, t: RawTrack): void {
  const entry = readBox(v, stsd.body + 8, stsd.end)
  if (!entry) return
  t.format = entry.type
  const bytes = (b: BoxHeader): Uint8Array =>
    new Uint8Array(v.buffer, v.byteOffset + b.body, b.end - b.body).slice()
  if (t.kind === 'video') {
    t.width = v.getUint16(entry.body + 24)
    t.height = v.getUint16(entry.body + 26)
    for (const c of children(v, entry.body + 78, entry.end)) {
      if (c.type === 'avcC') {
        t.description = bytes(c)
        t.codec = avcCodec(t.description, entry.type === 'avc3' ? 'avc3' : 'avc1')
      } else if (c.type === 'hvcC') {
        t.description = bytes(c)
        t.codec = hevcCodec(t.description, entry.type === 'hev1' ? 'hev1' : 'hvc1')
      } else if (c.type === 'av1C') {
        t.description = bytes(c)
        t.codec = av1Codec(t.description)
      } else if (c.type === 'vpcC') {
        t.codec = vp9Codec(bytes(c))
      }
    }
  } else if (t.kind === 'audio') {
    const version = v.getUint16(entry.body + 8)
    t.channels = v.getUint16(entry.body + 16)
    t.sampleRate = v.getUint32(entry.body + 24) >>> 16
    // QuickTime sound description v1/v2 carry extra fields before child boxes
    const childStart = entry.body + 28 + (version === 1 ? 16 : version === 2 ? 36 : 0)
    if (version === 2) t.sampleRate = Math.round(v.getFloat64(entry.body + 32))
    for (const c of children(v, childStart, entry.end)) {
      if (c.type === 'esds') {
        const { objectType, asc } = parseEsds(bytes(c))
        t.description = asc
        t.codec = aacCodec(objectType, asc)
      } else if (c.type === 'dOps') {
        t.codec = 'opus'
      } else if (c.type === 'wave') {
        // QuickTime wraps esds inside 'wave'
        const esds = child(v, c, 'esds')
        if (esds) {
          const { objectType, asc } = parseEsds(bytes(esds))
          t.description = asc
          t.codec = aacCodec(objectType, asc)
        }
      }
    }
    if (entry.type === 'Opus') t.codec = 'opus'
  }
}

/** Expand the compact stbl tables into a decode-order {@link SampleTable}. */
function buildSamples(t: RawTrack): SampleTable {
  const count = t.stsz?.count ?? 0
  const offset = new Float64Array(count)
  const size = new Uint32Array(count)
  const dts = new Float64Array(count)
  const cts = new Float64Array(count)
  const duration = new Float64Array(count)
  const key = new Uint8Array(count)

  // sizes
  if (t.stsz) {
    if (t.stsz.sizes) size.set(t.stsz.sizes.subarray(0, count))
    else size.fill(t.stsz.fixed)
  }

  // offsets via stsc + chunk offsets
  const stsc = t.stsc
  const co = t.chunkOffsets
  if (stsc && co && stsc.length >= 3) {
    let s = 0
    const entries = stsc.length / 3
    for (let e = 0; e < entries && s < count; e++) {
      const firstChunk = stsc[e * 3]! - 1
      const perChunk = stsc[e * 3 + 1]!
      const lastChunk = e + 1 < entries ? stsc[(e + 1) * 3]! - 1 : co.length
      for (let c = firstChunk; c < lastChunk && s < count; c++) {
        let at = co[c]!
        for (let k = 0; k < perChunk && s < count; k++) {
          offset[s] = at
          at += size[s]!
          s++
        }
      }
    }
  }

  // timing: stts (decode deltas) + ctts (composition offsets) + edit list
  const ts = t.timescale
  const toUs = (ticks: number): number => Math.round((ticks * 1_000_000) / ts)
  let tick = 0
  let s = 0
  const stts = t.stts
  const tickDts = new Float64Array(count)
  const tickDur = new Float64Array(count)
  if (stts) {
    for (let e = 0; e < stts.length / 2 && s < count; e++) {
      const n = stts[e * 2]!
      const delta = stts[e * 2 + 1]!
      for (let k = 0; k < n && s < count; k++) {
        tickDts[s] = tick
        tickDur[s] = delta
        tick += delta
        s++
      }
    }
  }
  const tickCts = new Float64Array(tickDts)
  if (t.ctts) {
    s = 0
    for (let e = 0; e < t.ctts.length / 2 && s < count; e++) {
      const n = t.ctts[e * 2]!
      const off = t.ctts[e * 2 + 1]!
      for (let k = 0; k < n && s < count; k++) tickCts[s++]! += off
    }
  }
  for (let i = 0; i < count; i++) {
    dts[i] = toUs(tickDts[i]! - t.mediaTime) + t.leadIn
    cts[i] = toUs(tickCts[i]! - t.mediaTime) + t.leadIn
    duration[i] = toUs(tickCts[i]! + tickDur[i]!) - toUs(tickCts[i]!)
  }

  // keyframes
  if (t.stss) {
    for (let i = 0; i < t.stss.length; i++) {
      const n = t.stss[i]! - 1
      if (n >= 0 && n < count) key[n] = 1
    }
  } else {
    key.fill(1)
  }

  const presentation = new Uint32Array(count)
  for (let i = 0; i < count; i++) presentation[i] = i
  if (t.ctts) presentation.sort((a, b) => cts[a]! - cts[b]! || a - b)
  const rank = new Uint32Array(count)
  for (let i = 0; i < count; i++) rank[presentation[i]!] = i
  return { count, offset, size, dts, cts, duration, key, presentation, rank }
}

/* ------------------------------------------------------------------ public API */

/** Parse a complete `moov` box (bytes start at the box header). */
export function parseMoov(moov: Uint8Array): Mp4Info {
  const v = new DataView(moov.buffer, moov.byteOffset, moov.byteLength)
  const root = readBox(v, 0, moov.byteLength)
  if (!root || root.type !== 'moov') throw new Mp4Error('not a moov box')
  let movieTimescale = 0
  let movieDuration = 0
  const mvhd = child(v, root, 'mvhd')
  if (mvhd) {
    const ver = fullBoxVersion(v, mvhd)
    movieTimescale = v.getUint32(mvhd.body + (ver === 1 ? 20 : 12))
    const d = ver === 1 ? Number(v.getBigUint64(mvhd.body + 24)) : v.getUint32(mvhd.body + 16)
    movieDuration = movieTimescale > 0 ? Math.round((d * 1e6) / movieTimescale) : 0
  }
  if (child(v, root, 'mvex')) throw new Mp4Error('fragmented MP4 is not supported')
  const tracks: Mp4Track[] = []
  for (const b of children(v, root.body, root.end)) {
    if (b.type !== 'trak') continue
    const raw = parseTrak(v, b, movieTimescale)
    if (!raw) continue
    const samples = buildSamples(raw)
    let duration = 0
    for (let i = 0; i < samples.count; i++) {
      const end = samples.cts[i]! + samples.duration[i]!
      if (end > duration) duration = end
    }
    tracks.push({
      id: raw.id,
      kind: raw.kind,
      format: raw.format,
      codec: raw.codec,
      description: raw.description,
      timescale: raw.timescale,
      duration,
      width: raw.width,
      height: raw.height,
      rotation: raw.rotation,
      sampleRate: raw.sampleRate,
      channels: raw.channels,
      samples,
    })
  }
  return {
    duration: movieDuration,
    tracks,
    video: tracks.find((t) => t.kind === 'video' && t.samples.count > 0),
    audio: tracks.find((t) => t.kind === 'audio' && t.samples.count > 0),
  }
}

/** How much to read up-front: faststart proxies have their moov in the first few tens of KB. */
const HEAD_PROBE = 256 * 1024

/**
 * Locate and parse the `moov` box using as few range reads as possible:
 * one read for faststart files, a handful of 16-byte header reads otherwise.
 */
export async function readMp4Info(src: ByteSource, signal?: AbortSignal): Promise<Mp4Info> {
  const head = await src.read(0, HEAD_PROBE, signal)
  const headView = new DataView(head.buffer, head.byteOffset, head.byteLength)
  const fileSize = src.size ?? Number.POSITIVE_INFINITY
  let at = 0
  for (let guard = 0; guard < 256 && at < fileSize; guard++) {
    let view = headView
    let p = at
    if (at + 16 > head.byteLength) {
      const h = await src.read(at, 16, signal)
      if (h.byteLength < 8) break
      view = new DataView(h.buffer, h.byteOffset, h.byteLength)
      p = 0
    }
    const size32 = view.getUint32(p)
    const type = fourcc(view, p + 4)
    let size: number
    if (size32 === 1) {
      if (p + 16 > view.byteLength) break
      size = Number(view.getBigUint64(p + 8))
    } else {
      size = size32 === 0 ? fileSize - at : size32
    }
    if (type === 'moov') {
      const bytes =
        at + size <= head.byteLength
          ? head.subarray(at, at + size)
          : await src.read(at, size, signal)
      if (bytes.byteLength < size) throw new Mp4Error('truncated moov box')
      return parseMoov(bytes)
    }
    if (type === 'moof') throw new Mp4Error('fragmented MP4 is not supported')
    if (!Number.isFinite(size) || size < 8) break
    at += size
  }
  throw new Mp4Error('no moov box found')
}

/* ------------------------------------------------------------------ lookups */

/**
 * Presentation rank of the frame visible at time `t` (us): the last frame whose cts <= t.
 * Returns 0 for t before the first frame. O(log n), allocation-free.
 */
export function frameRankAt(s: SampleTable, t: number): number {
  let lo = 0
  let hi = s.count - 1
  if (hi < 0) return -1
  if (t < s.cts[s.presentation[0]!]!) return 0
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1
    if (s.cts[s.presentation[mid]!]! <= t) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Decode index of the sync sample at or before decode index `i`. */
export function keyframeBefore(s: SampleTable, i: number): number {
  for (let k = Math.min(i, s.count - 1); k >= 0; k--) if (s.key[k] === 1) return k
  return 0
}

/** Byte span [start, end) covering decode indices [from, to] (inclusive). */
export function byteSpan(s: SampleTable, from: number, to: number): { start: number; end: number } {
  let start = Number.POSITIVE_INFINITY
  let end = 0
  for (let i = from; i <= to; i++) {
    const o = s.offset[i]!
    if (o < start) start = o
    const e = o + s.size[i]!
    if (e > end) end = e
  }
  return { start, end }
}

/** Debug-friendly label (unused in hot paths). */
export const describeTrack = (t: Mp4Track): string =>
  `${t.kind}#${t.id} ${t.codec || t.format} ${t.kind === 'video' ? `${t.width}x${t.height}` : `${t.sampleRate}Hz/${t.channels}ch`} ${t.samples.count} samples`

/** @internal exported for tests */
export const __test = { hevcCodec, av1Codec, parseEsds, aacCodec }
