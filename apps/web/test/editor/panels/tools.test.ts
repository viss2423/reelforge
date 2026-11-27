/** Context-aware tool bar: which tools a selection gets and what each command does. */
import { sec, type Clip, type MediaClip, type TextClip } from '@reelforge/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { closePanel, watchPanelSelection } from '@/editor/panels/index.tsx'
import { CLIP_PANEL, isClipPanel, isRootPanel, ROOT_PANEL } from '@/editor/panels/panelIds.ts'
import { clipPanelApplies, panelDef, PANELS } from '@/editor/panels/registry.tsx'
import {
  activateTool,
  dockFor,
  ROOT_TOOLS,
  toolsFor,
  type ToolDef,
} from '@/editor/panels/tools.tsx'
import { MEDIA_PANEL } from '@/editor/layout.ts'
import type { EditorStoreApi } from '@/state/editorStore.ts'
import { clipIn, richStore } from './helpers.ts'

vi.mock('@reelforge/core', async (importOriginal) => {
  const real = await importOriginal<typeof import('@reelforge/core')>()
  const { fakeCore } = await import('./fakeCore.ts')
  return { ...real, ...fakeCore(real) }
})

const toasts = vi.hoisted(() => ({
  plain: vi.fn<typeof import('@/components/Toast.tsx').toast>(),
  error: vi.fn<(title: string, description?: string) => number>(),
}))
vi.mock('@/components/Toast.tsx', () => ({
  toast: Object.assign(toasts.plain, { error: toasts.error }),
}))

let store: EditorStoreApi
const s = () => store.getState()
const ids = (tools: ToolDef[]) => tools.map((t) => t.id)
const tool = (clipId: string, id: string): ToolDef => {
  const loc = s()
    .project!.tracks.flatMap((t) => t.clips.map((c, index) => ({ c, t, index })))
    .find((x) => x.c.id === clipId)!
  const found = toolsFor(loc.c, loc.t.kind, loc.index).find((t) => t.id === id)
  if (!found) throw new Error(`no tool ${id} for ${clipId}`)
  return found
}

beforeEach(() => {
  store = richStore()
})

describe('toolsFor', () => {
  it('offers the project tools with nothing selected', () => {
    expect(ids(toolsFor(undefined, undefined))).toEqual([
      'edit',
      'audio',
      'text',
      'captions',
      'stickers',
      'effects',
      'filters',
      'templates',
      'ai',
      'canvas',
    ])
    expect(ROOT_TOOLS.every((t) => t.run || isRootPanel(t.panel ?? null))).toBe(true)
  })

  it('maps each clip type to its tools', () => {
    const v2 = clipIn(store, 'v2')
    expect(ids(toolsFor(v2, 'main', 1))).toEqual([
      'split',
      'delete',
      'duplicate',
      'speed',
      'volume',
      'fade',
      'adjust',
      'filter',
      'effects',
      'transform',
      'reverse',
      'background',
      'chroma',
      'replace',
      'transition',
      'keyframe',
    ])
    // First main clip: no boundary before it.
    expect(ids(toolsFor(clipIn(store, 'v1'), 'main', 0))).not.toContain('transition')
    expect(ids(toolsFor(clipIn(store, 'ov1'), 'overlay', 0))).toEqual(
      expect.arrayContaining(['forward', 'backward', 'chroma']),
    )
    expect(ids(toolsFor(clipIn(store, 'txt'), 'text', 0))).toEqual([
      'split',
      'delete',
      'duplicate',
      'text',
      'animations',
      'transform',
      'keyframe',
      'forward',
      'backward',
    ])
    expect(ids(toolsFor(clipIn(store, 'stk'), 'overlay', 1))).toEqual([
      'split',
      'delete',
      'duplicate',
      'animations',
      'transform',
      'keyframe',
      'forward',
      'backward',
    ])
    expect(ids(toolsFor(clipIn(store, 'mus'), 'audio', 0))).toEqual([
      'split',
      'delete',
      'duplicate',
      'speed',
      'volume',
      'fade',
      'replace',
    ])
    const photo = { ...clipIn<MediaClip>(store, 'v1'), type: 'image' } as Clip
    expect(ids(toolsFor(photo, 'main', 0))).not.toContain('speed')
    expect(ids(toolsFor(photo, 'main', 0))).not.toContain('reverse')
  })

  it('every clip tool panel applies to the clips that get the tool', () => {
    for (const [id, kind, index] of [
      ['v2', 'main', 1],
      ['ov1', 'overlay', 0],
      ['txt', 'text', 0],
      ['stk', 'overlay', 1],
      ['mus', 'audio', 0],
    ] as const) {
      const clip = clipIn(store, id)
      const panels = toolsFor(clip, kind, index).flatMap((t) =>
        t.panel && isClipPanel(t.panel) ? [t.panel] : [],
      )
      for (const panel of panels) expect(clipPanelApplies(panel, clip, kind)).toBe(true)
    }
    expect(clipPanelApplies(CLIP_PANEL.speed, clipIn(store, 'txt'))).toBe(false)
    expect(clipPanelApplies(CLIP_PANEL.transition, clipIn(store, 'ov1'), 'overlay')).toBe(false)
  })

  it('has a panel definition for every id', () => {
    for (const id of [...Object.values(ROOT_PANEL), ...Object.values(CLIP_PANEL)])
      expect(PANELS[id].title.length).toBeGreaterThan(0)
    expect(panelDef('nope')).toBeUndefined()
    expect(panelDef(null)).toBeUndefined()
    expect(panelDef(MEDIA_PANEL)).toBeUndefined()
  })
})

/** The dock with nothing selected, or with clip `clipId` selected. */
const dockOf = (clipId?: string) => {
  if (!clipId) return dockFor(toolsFor(undefined, undefined), undefined)
  const loc = s()
    .project!.tracks.flatMap((t) => t.clips.map((c, index) => ({ c, t, index })))
    .find((x) => x.c.id === clipId)!
  return dockFor(toolsFor(loc.c, loc.t.kind, loc.index), loc.c)
}

describe('dockFor', () => {
  it('root: Magic first, then Audio, Text, Captions, Effects; the rest behind More', () => {
    const d = dockOf()
    expect(ids(d.primary)).toEqual(['ai', 'audio', 'text', 'captions', 'effects'])
    expect(d.primary[0]!.label).toBe('Magic')
    expect(d.more.flatMap((g) => ids(g.tools))).toEqual([
      'edit',
      'stickers',
      'filters',
      'templates',
      'canvas',
    ])
  })

  it('clip: the five most used, Delete last; every other tool grouped under More', () => {
    const v2 = dockOf('v2')
    expect(ids(v2.primary)).toEqual(['split', 'speed', 'volume', 'adjust', 'delete'])
    expect(v2.more.map((g) => g.title)).toEqual(['Edit', 'Look', 'Sound'])
    const txt = dockOf('txt')
    expect(ids(txt.primary)).toEqual(['split', 'text', 'animations', 'transform', 'delete'])
    expect(txt.more.map((g) => g.title)).toEqual(['Edit', 'Layer'])
    // Nothing is lost or duplicated.
    for (const id of ['v2', 'txt', 'stk', 'mus', 'ov1']) {
      const loc = s()
        .project!.tracks.flatMap((t) => t.clips.map((c, index) => ({ c, t, index })))
        .find((x) => x.c.id === id)!
      const all = ids(toolsFor(loc.c, loc.t.kind, loc.index))
      const d = dockOf(id)
      const shown = [...ids(d.primary), ...d.more.flatMap((g) => ids(g.tools))]
      expect(shown.toSorted()).toEqual(all.toSorted())
    }
  })
})

describe('activateTool', () => {
  it('toggles panels and the active tool', () => {
    const audio = ROOT_TOOLS.find((t) => t.id === 'audio')!
    activateTool(audio, store)
    expect(s()).toMatchObject({ activePanel: ROOT_PANEL.audio, activeTool: 'audio' })
    activateTool(audio, store)
    expect(s()).toMatchObject({ activePanel: null, activeTool: null })
  })

  it('Edit selects the main clip under the playhead, or opens the media library', () => {
    const edit = ROOT_TOOLS[0]!
    s().setPlayhead(sec(3))
    activateTool(edit, store)
    expect(s().selection.clipIds).toEqual(['v2'])
    s().clearSelection()
    s().setPlayhead(sec(5)) // the very end still edits the last clip
    activateTool(edit, store)
    expect(s().selection.clipIds).toEqual(['v2'])
    s().clearSelection()
    s().dispatch('clear', (d) => {
      d.tracks[0]!.clips = []
    })
    activateTool(edit, store)
    expect(s().activePanel).toBe(MEDIA_PANEL)
    expect(toasts.plain).toHaveBeenCalledWith('Add a video or photo to start editing')
  })

  it('Split splits the selection at the playhead', () => {
    s().select(['v2'])
    s().setPlayhead(sec(3))
    activateTool(tool('v2', 'split'), store)
    expect(s().project!.tracks[0]!.clips).toHaveLength(3)
  })

  it('Reverse toggles and shows as pressed', () => {
    s().select(['v1'])
    const reverse = tool('v1', 'reverse')
    expect(reverse.pressed?.(clipIn(store, 'v1'))).toBe(false)
    activateTool(reverse, store)
    expect(clipIn<MediaClip>(store, 'v1').reverse).toBe(true)
    expect(reverse.pressed?.(clipIn(store, 'v1'))).toBe(true)
    activateTool(reverse, store)
    expect(clipIn<MediaClip>(store, 'v1').reverse).toBe(false)
  })

  it('Keyframe adds/removes at the playhead and refuses off-clip', () => {
    s().select(['txt'])
    s().setPlayhead(sec(0.5))
    activateTool(tool('txt', 'keyframe'), store)
    expect(clipIn<TextClip>(store, 'txt').transform.scale.keyframes).toHaveLength(1)
    expect(toasts.plain).toHaveBeenLastCalledWith('Keyframe added', { duration: 1500 })
    activateTool(tool('txt', 'keyframe'), store)
    expect(clipIn<TextClip>(store, 'txt').transform.scale.keyframes).toHaveLength(0)
    s().setPlayhead(sec(4))
    activateTool(tool('txt', 'keyframe'), store)
    expect(toasts.plain).toHaveBeenLastCalledWith('Move the playhead over the clip to keyframe it')
    expect(clipIn<TextClip>(store, 'txt').transform.scale.keyframes).toHaveLength(0)
  })

  it('Forward/Backward restack layers and say when they cannot', () => {
    s().select(['ov1'])
    activateTool(tool('ov1', 'backward'), store)
    expect(toasts.plain).toHaveBeenLastCalledWith('Already at the back')
    activateTool(tool('ov1', 'forward'), store)
    expect(s().project!.tracks.findIndex((t) => t.clips.some((c) => c.id === 'ov1'))).toBe(3)
  })
})

describe('panel/selection coupling', () => {
  it('closes a clip panel that no longer fits the selection, keeps compatible ones', () => {
    const stop = watchPanelSelection(store)
    s().select(['v1'])
    s().setActivePanel(CLIP_PANEL.speed)
    s().select(['v2'])
    expect(s().activePanel).toBe(CLIP_PANEL.speed)
    s().select(['txt'])
    expect(s().activePanel).toBeNull()
    s().setActivePanel(ROOT_PANEL.audio)
    s().clearSelection()
    expect(s().activePanel).toBe(ROOT_PANEL.audio)
    stop()
  })

  it('closePanel clears panel and tool', () => {
    s().setActivePanel(ROOT_PANEL.ai)
    s().setActiveTool('ai')
    closePanel(store)
    expect(s()).toMatchObject({ activePanel: null, activeTool: null })
  })
})
