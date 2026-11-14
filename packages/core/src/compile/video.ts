/**
 * Video side of the graph: main track (clips joined by concat / xfade transitions) →
 * overlay tracks → text & captions (libass) → output pixel format and colour tags.
 */
import type { MediaClip, Project, StickerClip } from '../schema.ts'
import { filter } from './escape.ts'
import { num } from './expr.ts'
import { clipWindow, frameSpan, usToFrame, type FrameSpan, type MainLayout } from './layout.ts'
import { planTransition } from './transitions.ts'
import { ffColor, renderMainClip, renderOverlayClip, type VideoEnv } from './visual.ts'

/** Solid background frames (missing media or an empty main track). */
function solid(env: VideoEnv, color: string, frames: number): string {
  return env.g.source([
    filter('color', { c: ffColor(color), s: `${env.W}x${env.H}`, r: env.fps }),
    'format=yuv420p',
    `trim=end_frame=${frames}`,
  ])
}

/**
 * Main track over the output window: hard cuts are concatenated, transitions are `xfade`s
 * whose overlap follows the layout (the incoming clip starts `overlap` frames before the
 * previous clip ends). The result is padded with the background to the window length.
 */
export function buildMainTrack(
  env: VideoEnv,
  project: Project,
  layout: MainLayout,
  window: FrameSpan,
): string {
  const { g, fps } = env
  const total = window.end - window.start
  const bg = project.settings.background
  const items = layout.track?.hidden ? [] : layout.items
  let acc: string | undefined
  let accFrames = 0
  let pending: string[] = []
  let pendingFrames = 0
  const flush = (): void => {
    if (pending.length === 0) return
    const inputs = acc === undefined ? pending : [acc, ...pending]
    // `concat` outputs in the 1/1000000 time base while every clip chain is 1/fps; `xfade`
    // refuses inputs whose time bases differ, so a transition after hard cuts needs settb.
    acc =
      inputs.length === 1
        ? inputs[0]!
        : g.add(inputs, [`concat=n=${inputs.length}:v=1:a=0`, `settb=1/${fps}`])[0]!
    accFrames += pendingFrames
    pending = []
    pendingFrames = 0
  }
  for (const item of items) {
    const span = { start: usToFrame(item.start, fps), end: usToFrame(item.end, fps) }
    const win = clipWindow(span, window)
    if (!win) continue
    const label =
      renderMainClip(env, item.clip, win, {
        background: bg,
        backgroundBlur: project.settings.backgroundBlur,
      }) ?? solid(env, bg, win.frames)
    const overlap = accFrames + pendingFrames - (win.start - window.start)
    const transition = item.clip.transitionIn
    if (overlap > 0 && transition && (acc !== undefined || pending.length > 0)) {
      flush()
      const plan = planTransition(
        transition.type,
        ((accFrames - overlap) * 1e6) / fps,
        (overlap * 1e6) / fps,
        { w: env.W, h: env.H, fps, scale: env.S, uid: g.label('tr') },
      )
      acc = g.add([acc!, label], [plan.xfade, ...plan.post])[0]!
      accFrames += win.frames - overlap
    } else {
      pending.push(label)
      pendingFrames += win.frames
    }
  }
  flush()
  if (acc === undefined) return solid(env, bg, total)
  if (accFrames < total) {
    acc = g.chain(acc, [
      filter('tpad', { stop_mode: 'add', stop: total - accFrames, color: ffColor(bg) }),
    ])
  }
  return acc
}

/** Composite every visible overlay-track clip, bottom track first. */
export function buildOverlays(
  env: VideoEnv,
  project: Project,
  comp: string,
  window: FrameSpan,
): string {
  const total = window.end - window.start
  let cur = comp
  for (const track of project.tracks) {
    if (track.kind !== 'overlay' || track.hidden) continue
    const clips = track.clips
      .filter(
        (c): c is MediaClip | StickerClip =>
          c.type === 'video' || c.type === 'image' || c.type === 'sticker',
      )
      .toSorted((a, b) => a.start - b.start)
    for (const clip of clips) {
      const win = clipWindow(frameSpan(clip.start, clip.duration, env.fps), window)
      if (win) cur = renderOverlayClip(env, cur, clip, win, window.start, total)
    }
  }
  return cur
}

/**
 * Text and captions: the server-written ASS (timeline-absolute times) burned in with libass
 * at the export resolution. For range exports the stream is shifted to timeline time around
 * the `ass` filter so event times need no rewriting.
 */
export function applyText(
  env: VideoEnv,
  comp: string,
  window: FrameSpan,
  ass: { path: string; fontsDir: string } | undefined,
): string {
  if (!ass) return comp
  const shift = window.start / env.fps
  return env.g.chain(comp, [
    shift > 0 ? `setpts=PTS+${num(shift)}/TB` : undefined,
    filter('ass', {
      filename: ass.path.replaceAll('\\', '/'),
      fontsdir: ass.fontsDir.replaceAll('\\', '/'),
    }),
    shift > 0 ? 'setpts=PTS-STARTPTS' : undefined,
  ])
}

/** Final pixel format + BT.709 limited-range tags on every frame (read by the encoders). */
export function finishVideo(env: VideoEnv, comp: string, pixFmt: string): string {
  return env.g.chain(comp, [
    `format=${pixFmt}`,
    'setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709',
  ])
}
