/**
 * Test harness for render jobs: temp DataPaths (deliberately containing a space and an
 * apostrophe to exercise filtergraph path escaping), an in-memory Store, a fake JobContext,
 * lavfi-generated fixtures and ffprobe/pixel helpers.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Asset, Project, type Job, type JobKind, type Clip, type Track } from '@reelforge/core'
import type { DataPaths, JobContext, Logger, Store, Toolchain } from '../../src/contracts.ts'
import { assetFile } from '../../src/paths.ts'

export const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg'
export const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe'

/** True when ffmpeg + ffprobe can be executed. */
export const ffmpegAvailable = (): boolean =>
  spawnSync(FFMPEG, ['-version'], { stdio: 'ignore' }).status === 0 &&
  spawnSync(FFPROBE, ['-version'], { stdio: 'ignore' }).status === 0

/** Run a command to completion, resolving stdout (Buffer) or rejecting with stderr. */
export function run(bin: string, args: readonly string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const out: Buffer[] = []
    let err = ''
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d: string) => (err = (err + d).slice(-8000)))
    child.once('error', reject)
    child.once('close', (code) =>
      code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${bin} exit ${code}: ${err}`)),
    )
  })
}

export const ffmpeg = (args: readonly string[]): Promise<Buffer> =>
  run(FFMPEG, ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...args])

/** Hardware H.264 encoder that completes a real test encode, if any. */
export async function detectHwH264(): Promise<string | undefined> {
  for (const enc of ['h264_amf', 'h264_nvenc', 'h264_qsv', 'h264_videotoolbox']) {
    try {
      await ffmpeg([
        '-f',
        'lavfi',
        '-i',
        'testsrc2=s=256x256:r=30:d=0.2',
        '-c:v',
        enc,
        '-pix_fmt',
        'nv12',
        '-f',
        'null',
        '-',
      ])
      return enc
    } catch {
      // Not available on this machine.
    }
  }
  return undefined
}

/* ------------------------------------------------------------------ store */

export class MemoryStore implements Store {
  readonly projects = new Map<string, Project>()
  readonly assets = new Map<string, Asset>()
  readonly jobs = new Map<string, Job>()
  readonly settings = new Map<string, unknown>()

  getProject(id: string): Project | undefined {
    return this.projects.get(id)
  }
  listProjects(): ReturnType<Store['listProjects']> {
    return [...this.projects.values()].map((p) => ({
      id: p.id,
      name: p.name,
      updatedAt: p.updatedAt,
      createdAt: p.createdAt,
      duration: 0,
    }))
  }
  saveProject(project: Project, expectedRevision: number): number {
    const revision = expectedRevision + 1
    this.projects.set(project.id, { ...project, revision })
    return revision
  }
  deleteProject(id: string): void {
    this.projects.delete(id)
  }
  getAsset(id: string): Asset | undefined {
    return this.assets.get(id)
  }
  listAssets(): Asset[] {
    return [...this.assets.values()]
  }
  putAsset(asset: Asset): void {
    this.assets.set(asset.id, asset)
  }
  patchAsset(id: string, patch: Partial<Asset>): Asset {
    const next = { ...this.assets.get(id)!, ...patch }
    this.assets.set(id, next)
    return next
  }
  deleteAsset(id: string): void {
    this.assets.delete(id)
  }
  getJob(id: string): Job | undefined {
    return this.jobs.get(id)
  }
  listJobs(): Job[] {
    return [...this.jobs.values()]
  }
  putJob(job: Job): void {
    this.jobs.set(job.id, job)
  }
  getSetting<T>(key: string): T | undefined {
    return this.settings.get(key) as T | undefined
  }
  setSetting<T>(key: string, value: T): void {
    this.settings.set(key, value)
  }
}

/* ------------------------------------------------------------------ data dir */

export interface Env {
  root: string
  paths: DataPaths
  store: MemoryStore
  tools: Toolchain
  /** Remove everything. */
  dispose(): Promise<void>
}

/** A temp data directory whose path contains a space and an apostrophe. */
export async function createEnv(hw: Toolchain['hwEncoders'] = {}): Promise<Env> {
  const base = await mkdtemp(path.join(tmpdir(), 'rf-render-'))
  const root = path.join(base, "data dir's")
  const paths: DataPaths = {
    root,
    db: path.join(root, 'reelforge.sqlite'),
    media: path.join(root, 'media'),
    exports: path.join(root, 'exports'),
    packs: path.join(root, 'packs'),
    models: path.join(root, 'models'),
    bin: path.join(root, 'bin'),
    certs: path.join(root, 'certs'),
    tmp: path.join(root, 'tmp'),
  }
  await Promise.all(
    [paths.media, paths.exports, paths.packs, paths.models, paths.tmp].map((d) =>
      mkdir(d, { recursive: true }),
    ),
  )
  return {
    root,
    paths,
    store: new MemoryStore(),
    tools: {
      ffmpeg: FFMPEG,
      ffprobe: FFPROBE,
      ffmpegVersion: 'test',
      hwEncoders: hw,
      whisperModels: [],
      cpuThreads: 8,
    },
    dispose: () => rm(base, { recursive: true, force: true, maxRetries: 5 }),
  }
}

/* ------------------------------------------------------------------ job context */

export interface FakeJob<P> {
  ctx: JobContext<P>
  controller: AbortController
  progress: Array<{ p: number; message?: string; eta?: number }>
  warnings: unknown[]
}

let jobSeq = 0

export function fakeJob<P>(env: Env, kind: JobKind, payload: P): FakeJob<P> {
  const controller = new AbortController()
  const progress: FakeJob<P>['progress'] = []
  const warnings: unknown[] = []
  const log: Logger = {
    info: () => undefined,
    debug: () => undefined,
    warn: (o) => warnings.push(o),
    error: (o) => warnings.push(o),
  }
  const job: Job = {
    id: `job${++jobSeq}_${process.pid}`,
    kind,
    status: 'running',
    progress: 0,
    createdAt: new Date().toISOString(),
  }
  const ctx: JobContext<P> = {
    job,
    payload,
    signal: controller.signal,
    progress: (p, message, eta) => progress.push({ p, message, eta }),
    paths: env.paths,
    tools: env.tools,
    store: env.store,
    log,
    enqueue: () => {
      throw new Error('enqueue is not used by render jobs')
    },
    emit: () => undefined,
  }
  return { ctx, controller, progress, warnings }
}

/* ------------------------------------------------------------------ fixtures */

export interface FixtureSpec {
  id: string
  kind: Asset['kind']
  name: string
  /** ffmpeg args producing the file (output path appended). */
  args: string[]
  meta: Partial<Asset> & Record<string, unknown>
}

/** Generate a fixture into the asset's canonical original path and register it. */
export async function addFixture(env: Env, spec: FixtureSpec): Promise<Asset> {
  const asset = Asset.parse({
    id: spec.id,
    kind: spec.kind,
    name: spec.name,
    size: 1,
    mime: 'application/octet-stream',
    createdAt: new Date().toISOString(),
    ...spec.meta,
  })
  const file = assetFile(env.paths, asset, 'original')
  await mkdir(path.dirname(file), { recursive: true })
  await ffmpeg([...spec.args, file])
  env.store.putAsset({ ...asset, ...spec.meta } as Asset)
  return asset
}

const x264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-pix_fmt', 'yuv420p']

/** The standard fixture set used by the e2e tests. */
export const FIXTURES: FixtureSpec[] = [
  {
    id: 'land',
    kind: 'video',
    name: 'land.mp4',
    args: [
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=1920x1080:r=30:d=6',
      '-f',
      'lavfi',
      '-i',
      'sine=f=440:r=48000:d=6',
      ...x264,
      '-c:a',
      'aac',
      '-ac',
      '2',
      '-shortest',
    ],
    meta: {
      width: 1920,
      height: 1080,
      fps: 30,
      duration: 6_000_000,
      hasAudio: true,
      hasVideo: true,
    },
  },
  {
    id: 'port',
    kind: 'video',
    name: 'port.mp4',
    args: [
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=1080x1920:r=30:d=6',
      '-f',
      'lavfi',
      '-i',
      'sine=f=660:r=44100:d=6',
      ...x264,
      '-c:a',
      'aac',
      '-ac',
      '1',
      '-shortest',
    ],
    meta: {
      width: 1080,
      height: 1920,
      fps: 30,
      duration: 6_000_000,
      hasAudio: true,
      hasVideo: true,
    },
  },
  {
    id: 'silent',
    kind: 'video',
    name: 'silent.mp4',
    args: ['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=25:d=4', ...x264],
    meta: {
      width: 1280,
      height: 720,
      fps: 25,
      duration: 4_000_000,
      hasAudio: false,
      hasVideo: true,
    },
  },
  {
    // Luma ramps black → white over 4 s: lets tests tell forward from reverse playback.
    id: 'ramp',
    kind: 'video',
    name: 'ramp.mp4',
    args: ['-f', 'lavfi', '-i', 'color=c=white:s=640x360:r=30:d=4,fade=t=in:st=0:d=4', ...x264],
    meta: {
      width: 640,
      height: 360,
      fps: 30,
      duration: 4_000_000,
      hasAudio: false,
      hasVideo: true,
    },
  },
  {
    id: 'solid',
    kind: 'video',
    name: 'solid.mp4',
    args: ['-f', 'lavfi', '-i', 'color=c=0x3060A0:s=1080x1920:r=30:d=3', ...x264],
    meta: {
      width: 1080,
      height: 1920,
      fps: 30,
      duration: 3_000_000,
      hasAudio: false,
      hasVideo: true,
    },
  },
  {
    id: 'img',
    kind: 'image',
    name: 'img.png',
    args: ['-f', 'lavfi', '-i', 'testsrc2=s=800x600', '-frames:v', '1'],
    meta: { width: 800, height: 600, hasVideo: true },
  },
  {
    id: 'logo',
    kind: 'image',
    name: 'logo.png',
    // White 100×100 square centred on a fully transparent 200×200 canvas.
    args: [
      '-f',
      'lavfi',
      '-i',
      "color=s=200x200,format=rgba,geq=r=255:g=255:b=255:a='255*between(X,50,149)*between(Y,50,149)'",
      '-frames:v',
      '1',
    ],
    meta: { width: 200, height: 200, hasVideo: true },
  },
  {
    id: 'music',
    kind: 'audio',
    name: 'music.m4a',
    args: ['-f', 'lavfi', '-i', 'sine=f=220:r=44100:d=10', '-c:a', 'aac'],
    meta: { duration: 10_000_000, hasAudio: true },
  },
  {
    id: 'voice',
    kind: 'audio',
    name: 'voice.wav',
    args: ['-f', 'lavfi', '-i', 'sine=f=1000:r=48000:d=4,volume=0.5'],
    meta: { duration: 4_000_000, hasAudio: true },
  },
  {
    // 10-bit BT.2020 HLG-tagged clip (as recorded by phones in HDR mode).
    id: 'hdr',
    kind: 'video',
    name: 'hdr.mp4',
    args: [
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=1920x1080:r=30:d=2',
      '-vf',
      'format=yuv420p,zscale=tin=709:min=709:pin=709:rin=tv:t=arib-std-b67:p=2020:m=2020_ncl:r=tv,format=yuv420p10le',
      '-c:v',
      'libx265',
      '-preset',
      'ultrafast',
      '-x265-params',
      'log-level=error',
      '-g',
      '15',
      '-color_primaries',
      'bt2020',
      '-color_trc',
      'arib-std-b67',
      '-colorspace',
      'bt2020nc',
    ],
    meta: {
      width: 1920,
      height: 1080,
      fps: 30,
      duration: 2_000_000,
      videoCodec: 'hevc',
      hasAudio: false,
      hasVideo: true,
    },
  },
]

/* ------------------------------------------------------------------ projects */

let projectSeq = 0

/** Build a valid Project from partial tracks (zod fills every default). */
export function makeProject(
  tracks: Array<Omit<Partial<Track>, 'clips'> & { kind: Track['kind']; clips: unknown[] }>,
  extra: Record<string, unknown> = {},
): Project {
  const now = new Date().toISOString()
  return Project.parse({
    id: `p${++projectSeq}`,
    name: 'test',
    createdAt: now,
    updatedAt: now,
    tracks: tracks.map((t, i) => ({ id: `t${i}`, ...t })),
    ...extra,
  })
}

/** Main-track clips laid end to end from partial specs (`duration` required). */
export function mainClips(specs: Array<Record<string, unknown> & { duration: number }>): Clip[] {
  let start = 0
  return specs.map((s, i) => {
    const clip = { id: `m${i}`, type: 'video', assetId: 'land', start, ...s }
    start += s.duration
    return clip as unknown as Clip
  })
}

/* ------------------------------------------------------------------ inspection */

export interface ProbeResult {
  format: { duration: string; size: string }
  streams: Array<Record<string, string | number | undefined>>
}

export async function probe(file: string): Promise<ProbeResult> {
  const out = await run(FFPROBE, [
    '-v',
    'error',
    '-show_entries',
    'format=duration,size:stream=codec_type,codec_name,codec_tag_string,profile,width,height,pix_fmt,r_frame_rate,avg_frame_rate,sample_rate,channels,duration,nb_frames,color_transfer,color_primaries,color_space',
    '-count_frames',
    '-of',
    'json',
    file,
  ])
  return JSON.parse(out.toString('utf8')) as ProbeResult
}

export const videoStream = (p: ProbeResult) => p.streams.find((s) => s.codec_type === 'video')!
export const audioStream = (p: ProbeResult) => p.streams.find((s) => s.codec_type === 'audio')

/** Decode one frame at `t` seconds to a small RGB image. */
export async function frameAt(
  file: string,
  t: number,
  w = 54,
  h = 96,
): Promise<{ w: number; h: number; data: Buffer }> {
  const data = await ffmpeg([
    '-ss',
    t.toFixed(3),
    '-i',
    file,
    '-frames:v',
    '1',
    '-vf',
    `scale=${w}:${h}:flags=area`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    'pipe:1',
  ])
  return { w, h, data }
}

/** Mean RGB over a normalised rectangle of a frame. */
export function meanRgb(
  f: { w: number; h: number; data: Buffer },
  rect = { x0: 0, y0: 0, x1: 1, y1: 1 },
): [number, number, number] {
  const sum = [0, 0, 0]
  let n = 0
  const xa = Math.floor(rect.x0 * f.w)
  const xb = Math.max(xa + 1, Math.floor(rect.x1 * f.w))
  const ya = Math.floor(rect.y0 * f.h)
  const yb = Math.max(ya + 1, Math.floor(rect.y1 * f.h))
  for (let y = ya; y < yb; y++) {
    for (let x = xa; x < xb; x++) {
      const i = (y * f.w + x) * 3
      sum[0]! += f.data[i]!
      sum[1]! += f.data[i + 1]!
      sum[2]! += f.data[i + 2]!
      n++
    }
  }
  return [sum[0]! / n, sum[1]! / n, sum[2]! / n]
}

/** Integrated loudness (LUFS) via ebur128. */
export async function integratedLoudness(file: string): Promise<number> {
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      FFMPEG,
      ['-hide_banner', '-nostdin', '-i', file, '-map', '0:a', '-af', 'ebur128', '-f', 'null', '-'],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
    )
    let err = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d: string) => (err = (err + d).slice(-4000)))
    child.once('error', reject)
    child.once('close', () => resolve(err))
  })
  const m = /Integrated loudness:\s*I:\s*(-?[\d.]+|-inf)\s*LUFS/.exec(out)
  if (!m) throw new Error(`no ebur128 summary: ${out.slice(-500)}`)
  return m[1] === '-inf' ? -Infinity : Number(m[1])
}

/** Write a test pack (`<packs>/<id>/pack.json` + files). */
export async function writePack(
  env: Env,
  id: string,
  manifest: Record<string, unknown>,
  files: Record<string, string | Buffer> = {},
): Promise<void> {
  const dir = path.join(env.paths.packs, id)
  await mkdir(dir, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    await writeFile(path.join(dir, rel), content)
  }
  await writeFile(
    path.join(dir, 'pack.json'),
    JSON.stringify({ id, version: '1.0.0', name: id, curatedAt: '2026-01-01', ...manifest }),
  )
}

/** A size³ `.cube` computed per normalised RGB. */
export function cube(
  size: number,
  fn: (r: number, g: number, b: number) => [number, number, number],
): string {
  const lines = [`LUT_3D_SIZE ${size}`]
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const v = fn(r / (size - 1), g / (size - 1), b / (size - 1))
        lines.push(v.map((x) => x.toFixed(6)).join(' '))
      }
    }
  }
  return `${lines.join('\n')}\n`
}
