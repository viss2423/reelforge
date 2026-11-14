/**
 * Audio side of the graph.
 *
 * Per clip: trim (input-side seek) → 48 kHz stereo float → reverse → denoise → voice
 * enhance → tempo (atempo / rubberband / resample) → exact length → volume → fades →
 * delay to its output position. Clips are bussed (voice / ducked music / other), music
 * marked `duckUnderVoice` is side-chain compressed by the voice bus, everything is summed
 * with `amix normalize=0` (no level surprises), padded to the exact output length and
 * loudness-normalised (single-pass dynamic, or linear 2nd pass with measured values).
 *
 * Voice enhance preset ("podcast" chain): highpass 80 Hz (rumble), −3 dB @ 300 Hz (mud),
 * +3 dB @ 3.5 kHz (presence), gentle 3:1 compressor with 2 dB make-up.
 */
import type { AudioClip, MediaClip, Project } from '../schema.ts'
import { filter, type FilterOptionValue } from './escape.ts'
import { num } from './expr.ts'
import type { Graph, InputSpec } from './graph.ts'
import {
  clipWindow,
  frameSpan,
  usToFrame,
  type ClipWindow,
  type FrameSpan,
  type MainLayout,
} from './layout.ts'
import { audioRampSegments, tempoFilters, type SpeedMap } from './speed.ts'
import { hwaccelFor, type CompileContext } from './types.ts'
import { SOURCE_MARGIN_US, sourceWindow } from './visual.ts'

export const SAMPLE_RATE = 48_000

/** Loudness-normalisation targets besides the integrated level (from ExportSettings). */
export const LOUDNESS = { TRUE_PEAK: -1.5, LRA: 11 } as const

export const VOICE_ENHANCE = [
  'highpass=f=80',
  'equalizer=f=300:t=o:w=1:g=-3',
  'equalizer=f=3500:t=o:w=1.2:g=3',
  'acompressor=threshold=-18dB:ratio=3:attack=10:release=150:makeup=2',
] as const

/** Side-chain ducking: music drops ~10 dB within 15 ms of speech, recovers over 350 ms. */
export const DUCKING = 'sidechaincompress=threshold=0.03:ratio=8:attack=15:release=350'

export interface AudioEnv {
  g: Graph
  ctx: CompileContext
  fps: number
  /** Analysis pass: inputs are opened audio-only and no hwaccel is requested. */
  analysis: boolean
}

type Bus = 'voice' | 'duck' | 'other'

interface AudioItem {
  clip: MediaClip | AudioClip
  path: string
  win: ClipWindow
  /** Clip length in frames (before windowing). */
  frames: number
  /** Equal-power crossfades with neighbouring main-track clips (frames). */
  xIn: number
  xOut: number
  bus: Bus
}

const samples = (frames: number, fps: number): number => Math.round((frames * SAMPLE_RATE) / fps)

/** Collect every audible clip window of the project. */
function collect(
  env: AudioEnv,
  project: Project,
  layout: MainLayout,
  window: FrameSpan,
): AudioItem[] {
  const { ctx, fps } = env
  const out: AudioItem[] = []
  const audible = (c: MediaClip | AudioClip): string | undefined => {
    const a = ctx.assets[c.assetId]
    if (!a || !a.hasAudio || c.audio.muted || c.audio.volume <= 0) return undefined
    if (c.type === 'image') return undefined
    return a.path
  }
  if (layout.track && !layout.track.muted) {
    const items = layout.items
    for (const [i, item] of items.entries()) {
      const path = audible(item.clip)
      if (!path) continue
      const span = { start: usToFrame(item.start, fps), end: usToFrame(item.end, fps) }
      const win = clipWindow(span, window)
      if (!win) continue
      const next = items[i + 1]
      // item.start + overlap is where the previous clip ends; next.start is where this one
      // starts being crossfaded out.
      const xIn = item.overlap > 0 ? usToFrame(item.start + item.overlap, fps) - span.start : 0
      const xOut = next && next.overlap > 0 ? span.end - usToFrame(next.start, fps) : 0
      out.push({
        clip: item.clip,
        path,
        win,
        frames: span.end - span.start,
        xIn,
        xOut,
        bus: 'voice',
      })
    }
  }
  for (const track of project.tracks) {
    if (track.muted || (track.kind !== 'overlay' && track.kind !== 'audio')) continue
    for (const clip of track.clips) {
      if (clip.type !== 'video' && clip.type !== 'audio') continue
      const path = audible(clip)
      if (!path) continue
      const span = frameSpan(clip.start, clip.duration, fps)
      const win = clipWindow(span, window)
      if (!win) continue
      const bus: Bus =
        clip.type === 'audio'
          ? clip.duckUnderVoice
            ? 'duck'
            : clip.role === 'voiceover'
              ? 'voice'
              : 'other'
          : 'voice'
      out.push({ clip, path, win, frames: span.end - span.start, xIn: 0, xOut: 0, bus })
    }
  }
  return out
}

/** Tempo stage for a (possibly ramped) speed map. */
function tempo(env: AudioEnv, label: string, map: SpeedMap, preservePitch: boolean): string {
  const hq = env.ctx.settings.quality === 'high' || env.ctx.settings.quality === 'max'
  if (map.constant !== undefined) {
    return env.g.chain(label, tempoFilters(map.constant, preservePitch, hq))
  }
  const segs = audioRampSegments(map)
  const parts = env.g.split(label, segs.length, true)
  const pieces = segs.map((s, i) =>
    env.g.chain(parts[i]!, [
      filter('atrim', { start: s.s0 / 1e6, end: s.s1 / 1e6 }),
      'asetpts=PTS-STARTPTS',
      ...tempoFilters((s.s1 - s.s0) / Math.max(1, s.t1 - s.t0), preservePitch, hq),
    ]),
  )
  return pieces.length === 1
    ? pieces[0]!
    : env.g.add(pieces, [`concat=n=${pieces.length}:v=0:a=1`])[0]!
}

/** `afade` limited to the visible part of a clip-local window [from, to) (us). */
function fade(
  kind: 'in' | 'out',
  from: number,
  to: number,
  headUs: number,
  curve: string,
): string | undefined {
  const st = Math.max(0, from - headUs)
  const end = to - headUs
  if (end <= st) return undefined
  const opts: Record<string, FilterOptionValue> = { t: kind, st: st / 1e6, d: (end - st) / 1e6 }
  if (curve !== 'tri') opts.curve = curve
  return filter('afade', opts)
}

/** One clip's audio chain, delayed to its output position. */
function clipChain(env: AudioEnv, item: AudioItem, windowStart: number): string {
  const { g, ctx, fps } = env
  const { clip, win } = item
  const headUs = (win.head * 1e6) / fps
  const lenUs = (win.frames * 1e6) / fps
  const media = clip.type === 'video'
  const sw = sourceWindow(
    media
      ? clip
      : { in: clip.in, duration: clip.duration, speed: clip.speed, speedRamp: [], reverse: false },
    headUs,
    lenUs,
  )
  const reverse = media && clip.reverse
  const spec: InputSpec =
    env.analysis || reverse || !media
      ? { path: item.path, seek: sw.start, duration: sw.span + SOURCE_MARGIN_US, audioOnly: true }
      : {
          path: item.path,
          seek: sw.start,
          duration: sw.span + SOURCE_MARGIN_US,
          hwaccel: hwaccelFor(ctx, ctx.assets[item.clip.assetId]),
        }
  const i = g.input(spec)
  const a = clip.audio
  const n = samples(win.frames, fps)
  const D = (item.frames * 1e6) / fps
  let label = g.chain(`${i}:a`, [
    `aresample=${SAMPLE_RATE}`,
    `aformat=sample_fmts=fltp:channel_layouts=stereo`,
    'asetpts=PTS-STARTPTS',
    filter('atrim', { end: sw.span / 1e6 }),
    reverse ? 'areverse' : undefined,
    a.denoise
      ? ctx.rnnoiseModel
        ? filter('arnndn', { m: ctx.rnnoiseModel.replaceAll('\\', '/') })
        : 'afftdn=nf=-25:tn=1'
      : undefined,
    ...(a.enhanceVoice ? VOICE_ENHANCE : []),
  ])
  label = tempo(env, label, sw.map, a.preservePitch)
  const offset = samples(win.start - windowStart, fps)
  return g.chain(label, [
    `apad=whole_len=${n}`,
    `atrim=end_sample=${n}`,
    a.volume !== 1 ? `volume=${num(a.volume, 4)}` : undefined,
    a.fadeIn > 0 ? fade('in', 0, a.fadeIn, headUs, 'tri') : undefined,
    a.fadeOut > 0 ? fade('out', D - a.fadeOut, D, headUs, 'tri') : undefined,
    item.xIn > 0 ? fade('in', 0, (item.xIn * 1e6) / fps, headUs, 'qsin') : undefined,
    item.xOut > 0 ? fade('out', D - (item.xOut * 1e6) / fps, D, headUs, 'qsin') : undefined,
    offset > 0 ? `adelay=delays=${offset}S:all=1` : undefined,
  ])
}

function mix(g: Graph, labels: readonly string[]): string | undefined {
  if (labels.length === 0) return undefined
  if (labels.length === 1) return labels[0]
  return g.add(labels, [
    `amix=inputs=${labels.length}:duration=longest:dropout_transition=0:normalize=0`,
  ])[0]
}

/**
 * Build the audio graph for the output window. Returns the final label (48 kHz stereo,
 * exact length). In analysis mode the chain ends in `loudnorm=print_format=json`.
 */
export function buildAudio(
  env: AudioEnv,
  project: Project,
  layout: MainLayout,
  window: FrameSpan,
): string {
  const { g, ctx, fps } = env
  const total = samples(window.end - window.start, fps)
  const buses: Record<Bus, string[]> = { voice: [], duck: [], other: [] }
  for (const item of collect(env, project, layout, window)) {
    buses[item.bus].push(clipChain(env, item, window.start))
  }
  let voice = mix(g, buses.voice)
  let duck = mix(g, buses.duck)
  if (voice && duck) {
    const [v, key] = g.pair(voice, true)
    voice = v
    duck = g.add([duck, key], [DUCKING])[0]!
  }
  const all = mix(
    g,
    [voice, duck, mix(g, buses.other)].filter((l): l is string => l !== undefined),
  )
  const s = ctx.settings
  if (!all) {
    return g.source([
      `anullsrc=r=${SAMPLE_RATE}:cl=stereo`,
      `atrim=end_sample=${total}`,
      'aformat=sample_fmts=fltp',
    ])
  }
  const target = { I: s.loudnessTarget, TP: LOUDNESS.TRUE_PEAK }
  let norm: string | undefined
  if (env.analysis) {
    norm = filter('loudnorm', { ...target, LRA: LOUDNESS.LRA, print_format: 'json' })
  } else if (s.normalizeLoudness && ctx.loudness) {
    const m = ctx.loudness
    // A target LRA ≥ the measured one lets loudnorm stay in linear mode (a pure gain, no
    // dynamic processing artefacts) whenever the true-peak budget allows.
    norm = filter('loudnorm', {
      ...target,
      LRA: Math.min(50, Math.max(LOUDNESS.LRA, Math.ceil(m.LRA))),
      measured_I: m.I,
      measured_TP: m.TP,
      measured_LRA: m.LRA,
      measured_thresh: m.thresh,
      offset: m.offset,
      linear: true,
    })
  } else if (s.normalizeLoudness) {
    norm = filter('loudnorm', { ...target, LRA: LOUDNESS.LRA })
  }
  return g.chain(all, [
    `apad=whole_len=${total}`,
    `atrim=end_sample=${total}`,
    norm,
    norm ? `aresample=${SAMPLE_RATE}` : undefined,
    `aformat=sample_fmts=fltp:sample_rates=${SAMPLE_RATE}:channel_layouts=stereo`,
  ])
}
