import { sec, type Us } from '@reelforge/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bindPreviewEngine, startFallbackClock } from '@/editor/viewer/bindEngine.ts'
import { setPreviewOverride } from '@/editor/viewer/previewOverride.ts'
import type { PreviewEngine, PreviewEvent } from '@/preview/index.ts'
import { createEditorStore, type EditorStoreApi } from '@/state/editorStore.ts'
import { makeAsset, makeProject } from '../fixtures.ts'

/** Preview engine double implementing the public contract. */
const fakeEngine = () => {
  const listeners = new Map<PreviewEvent, Set<(t: Us) => void>>()
  const engine = {
    playing: false,
    time: 0,
    setProject: vi.fn<PreviewEngine['setProject']>(),
    seek: vi.fn<PreviewEngine['seek']>((t) => void (engine.time = t)),
    play: vi.fn<PreviewEngine['play']>(() => void (engine.playing = true)),
    pause: vi.fn<PreviewEngine['pause']>(() => void (engine.playing = false)),
    on: vi.fn<PreviewEngine['on']>((ev, cb) => {
      const set = listeners.get(ev) ?? new Set()
      set.add(cb)
      listeners.set(ev, set)
      return () => set.delete(cb)
    }),
    setQuality: vi.fn<PreviewEngine['setQuality']>(),
    snapshot: vi.fn<PreviewEngine['snapshot']>(),
    destroy: vi.fn<PreviewEngine['destroy']>(),
    emit(ev: PreviewEvent, t: Us) {
      for (const cb of listeners.get(ev) ?? []) cb(t)
    },
    listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  }
  return engine
}

let store: EditorStoreApi
const s = () => store.getState()

beforeEach(() => {
  store = createEditorStore()
  s().load(makeProject())
})

describe('bindPreviewEngine', () => {
  it('shows a gesture preview override without touching the store, then returns', () => {
    const e = fakeEngine()
    const unbind = bindPreviewEngine(e, store)
    e.setProject.mockClear()
    const preview = { ...s().project!, name: 'preview' }
    setPreviewOverride(preview)
    expect(e.setProject).toHaveBeenLastCalledWith(preview, s().assets)
    // Store changes during the gesture keep showing the override.
    s().upsertAsset(makeAsset())
    expect(e.setProject).toHaveBeenLastCalledWith(preview, s().assets)
    setPreviewOverride(null)
    expect(e.setProject).toHaveBeenLastCalledWith(s().project, s().assets)
    unbind()
    e.setProject.mockClear()
    setPreviewOverride(preview)
    expect(e.setProject).not.toHaveBeenCalled()
    setPreviewOverride(null)
  })

  it('pushes the initial project, playhead and play state', () => {
    s().setPlayhead(sec(1))
    s().setPlaying(true)
    const e = fakeEngine()
    bindPreviewEngine(e, store)
    expect(e.setProject).toHaveBeenCalledWith(s().project, s().assets)
    expect(e.seek).toHaveBeenCalledWith(sec(1))
    expect(e.play).toHaveBeenCalledOnce()
  })

  it('forwards project and asset changes (not unrelated state)', () => {
    const e = fakeEngine()
    bindPreviewEngine(e, store)
    e.setProject.mockClear()
    s().setZoom(300)
    s().select(['x'])
    expect(e.setProject).not.toHaveBeenCalled()
    s().dispatch('Rename', (d) => void (d.name = 'x'))
    s().upsertAsset(makeAsset())
    expect(e.setProject).toHaveBeenCalledTimes(2)
  })

  it('seeks on user playhead moves only — engine time is not echoed back', () => {
    const e = fakeEngine()
    bindPreviewEngine(e, store)
    e.seek.mockClear()
    e.emit('time', sec(2))
    expect(s().playhead).toBe(sec(2))
    expect(s().playheadSource).toBe('engine')
    expect(e.seek).not.toHaveBeenCalled()
    s().setPlayhead(sec(4))
    expect(e.seek).toHaveBeenCalledWith(sec(4))
  })

  it('maps play/pause both ways without loops', () => {
    const e = fakeEngine()
    bindPreviewEngine(e, store)
    s().setPlaying(true)
    expect(e.play).toHaveBeenCalledOnce()
    // The engine reports play itself; nothing is re-issued.
    e.emit('play', 0)
    expect(e.play).toHaveBeenCalledOnce()
    e.playing = false
    e.emit('pause', sec(1))
    expect(s().playing).toBe(false)
    expect(e.pause).not.toHaveBeenCalled()
  })

  it('ended stops playback at the reported time; waiting toggles the spinner', () => {
    const e = fakeEngine()
    const onWaiting = vi.fn<(waiting: boolean) => void>()
    bindPreviewEngine(e, store, { onWaiting })
    s().setPlaying(true)
    e.emit('waiting', 0)
    expect(onWaiting).toHaveBeenLastCalledWith(true)
    e.emit('time', sec(1))
    expect(onWaiting).toHaveBeenLastCalledWith(false)
    e.emit('ended', sec(5))
    expect(s().playhead).toBe(sec(5))
    expect(s().playing).toBe(false)
  })

  it('unbinding removes every listener and subscription', () => {
    const e = fakeEngine()
    const unbind = bindPreviewEngine(e, store)
    expect(e.listenerCount()).toBe(5)
    unbind()
    expect(e.listenerCount()).toBe(0)
    e.setProject.mockClear()
    s().dispatch('Rename', (d) => void (d.name = 'y'))
    expect(e.setProject).not.toHaveBeenCalled()
  })
})

describe('startFallbackClock', () => {
  const manualRaf = () => {
    let cb: FrameRequestCallback | null = null
    return {
      raf: (f: FrameRequestCallback) => {
        cb = f
        return 1
      },
      caf: () => {
        cb = null
      },
      frame: (now: number) => {
        const f = cb
        cb = null
        f?.(now)
      },
      pending: () => cb !== null,
    }
  }

  it('advances the playhead in real time while playing and stops at the end', () => {
    const clock = manualRaf()
    vi.spyOn(performance, 'now').mockReturnValue(0)
    startFallbackClock(store, clock.raf, clock.caf)
    s().setPlaying(true)
    clock.frame(500)
    expect(s().playhead).toBe(sec(0.5))
    expect(s().playheadSource).toBe('engine')
    clock.frame(4000)
    expect(s().playhead).toBe(sec(4))
    clock.frame(9000)
    expect(s().playhead).toBe(sec(5))
    expect(s().playing).toBe(false)
    expect(clock.pending()).toBe(false)
  })

  it('restarts from 0 when play is pressed at the end; pausing stops ticking', () => {
    const clock = manualRaf()
    vi.spyOn(performance, 'now').mockReturnValue(0)
    startFallbackClock(store, clock.raf, clock.caf)
    s().setPlayhead(sec(5))
    s().setPlaying(true)
    expect(s().playhead).toBe(0)
    s().setPlaying(false)
    expect(clock.pending()).toBe(false)
  })

  it('refuses to play an empty timeline', () => {
    s().load(makeProject({ tracks: [{ id: 'main', kind: 'main', clips: [] }] }))
    startFallbackClock(store, manualRaf().raf, () => undefined)
    s().setPlaying(true)
    expect(s().playing).toBe(false)
  })
})
