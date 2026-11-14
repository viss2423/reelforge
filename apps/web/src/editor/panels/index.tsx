/**
 * Tool panels slot (see ../README.md): the context-aware tool bar and, on phones, the
 * non-modal bottom sheets for each panel. On desktop the bar is a compact strip above the
 * timeline and the panels open in the inspector column.
 */
import { ChevronLeft } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Sheet } from '@/components/Sheet.tsx'
import { cn } from '@/lib/cn.ts'
import { editorStore, type EditorStoreApi } from '@/state/editorStore.ts'
import { locateClip, useActivePanel, useEditor, useSelectedClip } from '@/state/selectors.ts'
import { useAnyAiRunning } from './ai/tasks.ts'
import { isClipPanel } from './panelIds.ts'
import { clipPanelApplies, panelDef } from './registry.tsx'
import { activateTool, toolsFor, type ToolDef } from './tools.tsx'

export interface ToolPanelsProps {
  /** 'mobile': bottom tool bar (+ its own sheets). 'desktop': strip above the timeline. */
  variant: 'mobile' | 'desktop'
}

/** Closes the open panel. */
export const closePanel = (store: EditorStoreApi = editorStore): void => {
  store.getState().setActivePanel(null)
  store.getState().setActiveTool(null)
}

/**
 * Keeps the open clip panel consistent with the selection: it closes when the selection is
 * cleared or the newly selected clip can't use it (e.g. Speed on a text clip), and stays
 * open when hopping between compatible clips.
 */
export const watchPanelSelection = (store: EditorStoreApi = editorStore): (() => void) =>
  store.subscribe((s, prev) => {
    if (s.selection === prev.selection && s.project === prev.project) return
    const panel = s.activePanel
    if (!isClipPanel(panel)) return
    const id = s.selection.clipIds.length === 1 ? s.selection.clipIds[0] : undefined
    const loc = id ? locateClip(s.project, id) : undefined
    if (!clipPanelApplies(panel, loc?.clip, loc?.track.kind)) closePanel(store)
  })

/** The tools for the current selection (re-computed only when the selection's clip changes). */
const useTools = (): ToolDef[] => {
  const clip = useSelectedClip()
  const where = useEditor((s) => {
    const loc = clip ? locateClip(s.project, clip.id) : undefined
    return loc ? `${loc.track.kind}:${loc.index}` : ''
  })
  const [kind, index] = where.split(':') as [string, string | undefined]
  return toolsFor(clip, (kind || undefined) as Parameters<typeof toolsFor>[1], Number(index ?? 0))
}

function ToolButton({
  tool,
  compact,
  active,
  busy,
}: {
  tool: ToolDef
  compact: boolean
  active: boolean
  busy: boolean
}) {
  const clip = useSelectedClip()
  const pressed = active || (clip && tool.pressed ? tool.pressed(clip) : false)
  const Icon = tool.icon
  return (
    <button
      type="button"
      onClick={() => activateTool(tool)}
      aria-pressed={tool.panel || tool.pressed ? pressed : undefined}
      data-tool={tool.id}
      className={cn(
        'relative flex shrink-0 items-center justify-center gap-1 rounded-xl transition-colors',
        compact ? 'h-9 px-3 text-sm' : 'h-14 min-w-16 flex-col px-1 text-[11px] font-semibold',
        pressed ? 'bg-accent/15 text-accent' : 'text-muted hover:text-fg',
      )}
    >
      <Icon size={compact ? 16 : 22} />
      {tool.label}
      {busy && (
        <span
          className="absolute top-1.5 right-2 size-2 animate-pulse rounded-full bg-accent"
          aria-label="Working"
        />
      )}
    </button>
  )
}

function ToolBar({ compact }: { compact: boolean }) {
  const tools = useTools()
  const panel = useActivePanel()
  const aiBusy = useAnyAiRunning()
  const hasSelection = useEditor((s) => s.selection.clipIds.length > 0)
  return (
    <div
      className={cn('flex items-center gap-1 overflow-x-auto px-2', compact ? 'h-11' : 'h-16')}
      role="toolbar"
      aria-label="Tools"
    >
      {hasSelection && (
        <button
          type="button"
          aria-label="Done"
          onClick={() => {
            editorStore.getState().clearSelection()
            if (isClipPanel(editorStore.getState().activePanel)) closePanel()
          }}
          className={cn(
            'grid shrink-0 place-items-center rounded-xl bg-surface-2 text-fg',
            compact ? 'size-9' : 'h-12 w-10',
          )}
        >
          <ChevronLeft size={compact ? 16 : 22} />
        </button>
      )}
      {tools.map((t) => (
        <ToolButton
          key={t.id}
          tool={t}
          compact={compact}
          active={!!t.panel && t.panel === panel}
          busy={t.id === 'ai' && aiBusy}
        />
      ))}
    </div>
  )
}

function PanelSheets() {
  const panel = useActivePanel()
  const open = panelDef(panel) !== undefined
  // Keep rendering the last panel while its sheet animates closed.
  const [shown, setShown] = useState(panel)
  if (open && panel !== shown) setShown(panel)
  const def = panelDef(open ? panel : shown)
  if (!def) return null
  return (
    <Sheet
      key={shown ?? ''}
      open={open}
      onClose={() => closePanel()}
      title={def.title}
      modal={false}
      snapPoints={def.snap}
    >
      {def.render()}
    </Sheet>
  )
}

export function ToolPanels({ variant }: ToolPanelsProps) {
  useEffect(() => watchPanelSelection(), [])
  const compact = variant === 'desktop'
  return (
    <>
      <ToolBar compact={compact} />
      {!compact && <PanelSheets />}
    </>
  )
}
