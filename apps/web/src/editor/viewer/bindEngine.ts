/**
 * Two-way binding between the editor store and a preview engine (or, when the engine is
 * unavailable, a plain clock so transport and timeline playback still work).
 *
 * Store → engine: project/assets changes → `setProject` (the engine diffs internally);
 * `playing` → play/pause; playhead moves made by the USER → `seek`.
 * Engine → store: `time` → playhead with source 'engine' (so it isn't echoed back as a
 * seek); play/pause/ended → `playing`.
 */
import type { PreviewEngine } from '@/preview/index.ts'
import type { EditorStoreApi } from '@/state/editorStore.ts'
import { timelineEnd } from '@/state/selectors.ts'

export interface BindOptions {
  /** Buffering state changes (spinner overlay). */
  onWaiting?: (waiting: boolean) => void
}

export const bindPreviewEngine = (
  engine: PreviewEngine,
  store: EditorStoreApi,
  opts: BindOptions = {},
): (() => void) => {
  const s0 = store.getState()
  if (s0.project) engine.setProject(s0.project, s0.assets)
  engine.seek(s0.playhead)
  if (s0.playing) engine.play()

  const unsubStore = store.subscribe((s, prev) => {
    if (s.project && (s.project !== prev.project || s.assets !== prev.assets)) {
      engine.setProject(s.project, s.assets)
    }
    if (s.playhead !== prev.playhead && s.playheadSource === 'user') engine.seek(s.playhead)
    if (s.playing !== prev.playing && s.playing !== engine.playing) {
      if (s.playing) engine.play()
      else engine.pause()
    }
  })

  const offs = [
    engine.on('time', (t) => {
      opts.onWaiting?.(false)
      store.getState().setPlayhead(t, 'engine')
    }),
    engine.on('play', () => store.getState().setPlaying(true)),
    engine.on('pause', () => store.getState().setPlaying(false)),
    engine.on('ended', (t) => {
      store.getState().setPlayhead(t, 'engine')
      store.getState().setPlaying(false)
    }),
    engine.on('waiting', () => opts.onWaiting?.(true)),
  ]

  return () => {
    unsubStore()
    for (const off of offs) off()
  }
}

/**
 * Fallback playback clock used when no preview engine is available: advances the playhead
 * in real time while `playing`, stopping at the end of the timeline. Pressing play at the
 * end restarts from 0, like a video player.
 */
export const startFallbackClock = (
  store: EditorStoreApi,
  raf: (cb: FrameRequestCallback) => number = requestAnimationFrame,
  caf: (id: number) => void = cancelAnimationFrame,
): (() => void) => {
  let frame = 0
  let last = 0
  const tick = (now: number) => {
    const s = store.getState()
    if (!s.playing) return
    const end = timelineEnd(s.project)
    const next = s.playhead + Math.round((now - last) * 1000)
    last = now
    if (next >= end) {
      s.setPlayhead(end, 'engine')
      s.setPlaying(false)
      return
    }
    s.setPlayhead(next, 'engine')
    frame = raf(tick)
  }
  const start = () => {
    const s = store.getState()
    const end = timelineEnd(s.project)
    if (end === 0) {
      s.setPlaying(false)
      return
    }
    if (s.playhead >= end) s.setPlayhead(0)
    last = performance.now()
    frame = raf(tick)
  }
  if (store.getState().playing) start()
  const unsub = store.subscribe((s, prev) => {
    if (s.playing === prev.playing) return
    caf(frame)
    if (s.playing) start()
  })
  return () => {
    unsub()
    caf(frame)
  }
}
