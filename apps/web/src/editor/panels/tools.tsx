/**
 * The context-aware tool bar's tools. With nothing selected the bar offers project tools;
 * with one clip selected it offers the tools that apply to that clip type and track.
 * `toolsFor` is pure so the mapping is unit-tested without rendering.
 */
import type { Clip, TrackKind } from '@reelforge/core'
import {
  ArrowDownToLine,
  ArrowUpToLine,
  Captions,
  CopyPlus,
  Crop,
  Diamond,
  Eraser,
  Gauge,
  LayoutTemplate,
  Music,
  Palette,
  Pipette,
  Repeat,
  Replace,
  Scissors,
  SlidersHorizontal,
  Smile,
  Sparkles,
  Trash2,
  Type,
  Volume2,
  Wand2,
  Waves,
  Wand,
  Frame,
  ArrowLeftRight,
  type LucideIcon,
} from 'lucide-react'
import { toast } from '@/components/Toast.tsx'
import { editorStore, type EditorStoreApi } from '@/state/editorStore.ts'
import {
  deleteSelection,
  duplicateSelection,
  splitAtPlayhead,
  type CommandResult,
} from '../actions.ts'
import { MEDIA_PANEL } from '../layout.ts'
import { edit } from './model/commands.ts'
import {
  isMedia,
  isSticker,
  isText,
  isVideo,
  isVisual,
  hasAudio,
  locate,
  mainClipAt,
} from './model/draft.ts'
import { moveLayer, setMediaProps, toggleAllKeyframes } from './model/edits.ts'
import { keyframeTime } from './model/keyframes.ts'
import { CLIP_PANEL, ROOT_PANEL, type PanelId } from './panelIds.ts'

export interface ToolDef {
  id: string
  label: string
  icon: LucideIcon
  /** Opens this panel… */
  panel?: PanelId
  /** …or runs this command. */
  run?: (store: EditorStoreApi) => void
  /** Rendered as pressed (toggles such as Reverse). */
  pressed?: (clip: Clip) => boolean
}

const report = (r: CommandResult) => {
  if (!r.ok) toast(r.reason)
}

/** Root "Edit": select the main clip under the playhead (switching to clip tools). */
const selectClipAtPlayhead = (store: EditorStoreApi) => {
  const { project, playhead } = store.getState()
  const clip = project ? mainClipAt(project, playhead) : undefined
  if (clip) {
    store.getState().select([clip.id])
    return
  }
  store.getState().setActivePanel(MEDIA_PANEL)
  toast('Add a video or photo to start editing')
}

const selected = (store: EditorStoreApi): Clip | undefined => {
  const { project, selection } = store.getState()
  const id = selection.clipIds.length === 1 ? selection.clipIds[0] : undefined
  return project && id ? locate(project, id)?.clip : undefined
}

const toggleKeyframes = (store: EditorStoreApi) => {
  const clip = selected(store)
  const { project, playhead } = store.getState()
  if (!clip || !project || !isVisual(clip)) return
  const fps = project.settings.fps
  if (playhead < clip.start || playhead > clip.start + clip.duration) {
    toast('Move the playhead over the clip to keyframe it')
    return
  }
  const t = keyframeTime(clip, playhead, fps)
  const r = edit('Keyframe', (d) => toggleAllKeyframes(d, clip.id, t, fps), { store })
  if (r) toast(r === 'added' ? 'Keyframe added' : 'Keyframe removed', { duration: 1500 })
}

const layer = (dir: 'forward' | 'backward') => (store: EditorStoreApi) => {
  const clip = selected(store)
  if (!clip) return
  const moved = edit(
    dir === 'forward' ? 'Bring forward' : 'Send backward',
    (d) => moveLayer(d, clip.id, dir),
    {
      store,
    },
  )
  if (moved === false) toast(dir === 'forward' ? 'Already in front' : 'Already at the back')
}

const toggleReverse = (store: EditorStoreApi) => {
  const clip = selected(store)
  if (!isVideo(clip)) return
  edit('Reverse', (d) => setMediaProps(d, clip.id, { reverse: !clip.reverse }), { store })
}

export const ROOT_TOOLS: readonly ToolDef[] = [
  { id: 'edit', label: 'Edit', icon: Scissors, run: selectClipAtPlayhead },
  { id: 'audio', label: 'Audio', icon: Music, panel: ROOT_PANEL.audio },
  { id: 'text', label: 'Text', icon: Type, panel: ROOT_PANEL.text },
  { id: 'captions', label: 'Captions', icon: Captions, panel: ROOT_PANEL.captions },
  { id: 'stickers', label: 'Stickers', icon: Smile, panel: ROOT_PANEL.stickers },
  { id: 'effects', label: 'Effects', icon: Sparkles, panel: ROOT_PANEL.effects },
  { id: 'filters', label: 'Filters', icon: Palette, panel: ROOT_PANEL.filters },
  { id: 'templates', label: 'Templates', icon: LayoutTemplate, panel: ROOT_PANEL.templates },
  { id: 'ai', label: 'Magic', icon: Wand2, panel: ROOT_PANEL.ai },
  { id: 'canvas', label: 'Canvas', icon: Frame, panel: ROOT_PANEL.canvas },
]

const SPLIT: ToolDef = {
  id: 'split',
  label: 'Split',
  icon: Scissors,
  run: (s) => report(splitAtPlayhead(s)),
}
const DELETE: ToolDef = {
  id: 'delete',
  label: 'Delete',
  icon: Trash2,
  run: (s) => report(deleteSelection(s)),
}
const DUPLICATE: ToolDef = {
  id: 'duplicate',
  label: 'Duplicate',
  icon: CopyPlus,
  run: (s) => report(duplicateSelection(s)),
}

/** Tools for the current selection: one clip → its clip tools; else the root tools. */
export const toolsFor = (
  clip: Clip | undefined,
  trackKind: TrackKind | undefined,
  index = 0,
): ToolDef[] => {
  if (!clip) return [...ROOT_TOOLS]
  const tools: ToolDef[] = [SPLIT, DELETE, DUPLICATE]
  if (isText(clip))
    tools.push({ id: 'text', label: 'Edit text', icon: Type, panel: CLIP_PANEL.text })
  if (hasAudio(clip)) {
    tools.push(
      { id: 'speed', label: 'Speed', icon: Gauge, panel: CLIP_PANEL.speed },
      { id: 'volume', label: 'Volume', icon: Volume2, panel: CLIP_PANEL.volume },
      { id: 'fade', label: 'Fade', icon: Waves, panel: CLIP_PANEL.fade },
    )
  }
  if (isText(clip) || isSticker(clip))
    tools.push({ id: 'animations', label: 'Animations', icon: Wand, panel: CLIP_PANEL.animations })
  if (isMedia(clip)) {
    tools.push(
      { id: 'adjust', label: 'Adjust', icon: SlidersHorizontal, panel: CLIP_PANEL.adjust },
      { id: 'filter', label: 'Filter', icon: Palette, panel: CLIP_PANEL.filter },
      { id: 'effects', label: 'Effects', icon: Sparkles, panel: CLIP_PANEL.effects },
    )
  }
  if (isVisual(clip))
    tools.push({ id: 'transform', label: 'Transform', icon: Crop, panel: CLIP_PANEL.transform })
  if (isVideo(clip))
    tools.push({
      id: 'reverse',
      label: 'Reverse',
      icon: Repeat,
      run: toggleReverse,
      pressed: (c) => isVideo(c) && c.reverse,
    })
  if (isMedia(clip))
    tools.push(
      { id: 'background', label: 'Background', icon: Eraser, panel: CLIP_PANEL.background },
      { id: 'chroma', label: 'Chroma key', icon: Pipette, panel: CLIP_PANEL.chroma },
    )
  if (isMedia(clip) || clip.type === 'audio')
    tools.push({ id: 'replace', label: 'Replace', icon: Replace, panel: CLIP_PANEL.replace })
  if (isMedia(clip) && trackKind === 'main' && index > 0)
    tools.push({
      id: 'transition',
      label: 'Transition',
      icon: ArrowLeftRight,
      panel: CLIP_PANEL.transition,
    })
  if (isVisual(clip))
    tools.push({ id: 'keyframe', label: 'Keyframe', icon: Diamond, run: toggleKeyframes })
  if (trackKind === 'overlay' || trackKind === 'text') {
    tools.push(
      { id: 'forward', label: 'Forward', icon: ArrowUpToLine, run: layer('forward') },
      { id: 'backward', label: 'Backward', icon: ArrowDownToLine, run: layer('backward') },
    )
  }
  return tools
}

/* ------------------------------------------------------------------ dock */

/** A titled group of tools in the dock's "More" grid. */
export interface ToolGroup {
  title: string
  tools: ToolDef[]
}

/** What the dock shows: a few primary tools, the rest behind "More". */
export interface Dock {
  primary: ToolDef[]
  more: ToolGroup[]
}

/** Root dock, in order (Magic first). Everything else goes behind "More". */
const ROOT_DOCK: readonly string[] = ['ai', 'audio', 'text', 'captions', 'effects']

/** Clip dock: the first four of these that apply, then Delete. */
const CLIP_DOCK_PRIORITY: readonly string[] = [
  'split',
  'text',
  'speed',
  'volume',
  'animations',
  'adjust',
  'filter',
  'fade',
  'transform',
]
const CLIP_DOCK_SIZE = 4

/** "More" grid groups for clip tools (a tool lands in the first group listing it). */
const CLIP_GROUPS: ReadonlyArray<{ title: string; ids: readonly string[] }> = [
  { title: 'Edit', ids: ['duplicate', 'replace', 'reverse', 'keyframe', 'transition'] },
  {
    title: 'Look',
    ids: ['adjust', 'filter', 'effects', 'animations', 'transform', 'background', 'chroma'],
  },
  { title: 'Sound', ids: ['speed', 'volume', 'fade'] },
  { title: 'Layer', ids: ['forward', 'backward'] },
]

/**
 * Splits a tool list (from `toolsFor`) into the dock's primary tools and the grouped
 * "More" grid. Pure, so the mapping is unit-tested alongside `toolsFor`.
 */
export const dockFor = (tools: readonly ToolDef[], clip: Clip | undefined): Dock => {
  const byId = new Map(tools.map((t) => [t.id, t]))
  if (!clip) {
    const primary = ROOT_DOCK.flatMap((id) => byId.get(id) ?? [])
    const rest = tools.filter((t) => !primary.includes(t))
    return { primary, more: rest.length ? [{ title: 'More tools', tools: rest }] : [] }
  }
  const primary = CLIP_DOCK_PRIORITY.flatMap((id) => byId.get(id) ?? []).slice(0, CLIP_DOCK_SIZE)
  const del = byId.get('delete')
  if (del) primary.push(del)
  const rest = tools.filter((t) => !primary.includes(t))
  const placed = new Set<string>()
  const more: ToolGroup[] = []
  for (const g of CLIP_GROUPS) {
    const groupTools = rest.filter((t) => g.ids.includes(t.id) && !placed.has(t.id))
    for (const t of groupTools) placed.add(t.id)
    if (groupTools.length) more.push({ title: g.title, tools: groupTools })
  }
  const other = rest.filter((t) => !placed.has(t.id))
  if (other.length) more.push({ title: 'More', tools: other })
  return { primary, more }
}

/** Runs a tool: opens its panel (or closes it when already open) or runs its command. */
export const activateTool = (tool: ToolDef, store: EditorStoreApi = editorStore): void => {
  const s = store.getState()
  if (tool.panel) {
    const open = s.activePanel !== tool.panel
    s.setActivePanel(open ? tool.panel : null)
    s.setActiveTool(open ? tool.id : null)
    return
  }
  tool.run?.(store)
}
