/**
 * Tool panels slot (see ../README.md): the context-aware tool dock and, on phones, the
 * non-modal bottom sheets for each panel. On desktop the dock is a compact strip above the
 * timeline and the panels open in the inspector column.
 *
 * Phones show a short dock (Magic, Audio, Text, Captions, Effects — or the clip's five most
 * used tools) and a "More" button that opens a grouped grid of the rest. A tool opened from
 * that grid is shown pressed in the dock while its panel is open, so the dock always says
 * what is open. Desktop has room for every tool: primary ones first, the rest after a
 * hairline, quieter.
 */
import { ChevronLeft, LayoutGrid } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Sheet } from '@/components/Sheet.tsx'
import { cn } from '@/lib/cn.ts'
import { editorStore, type EditorStoreApi } from '@/state/editorStore.ts'
import {
  locateClip,
  useActivePanel,
  useActiveTool,
  useEditor,
  useSelectedClip,
} from '@/state/selectors.ts'
import { useAnyAiRunning } from './ai/tasks.ts'
import { isClipPanel } from './panelIds.ts'
import { clipPanelApplies, panelDef } from './registry.tsx'
import { activateTool, dockFor, toolsFor, type Dock, type ToolDef } from './tools.tsx'

export interface ToolPanelsProps {
  /** 'mobile': bottom tool dock (+ its own sheets). 'desktop': strip above the timeline. */
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

/** The dock for the current selection (re-computed only when the selection's clip changes). */
const useDock = (): Dock => {
  const clip = useSelectedClip()
  const where = useEditor((s) => {
    const loc = clip ? locateClip(s.project, clip.id) : undefined
    return loc ? `${loc.track.kind}:${loc.index}` : ''
  })
  const [kind, index] = where.split(':') as [string, string | undefined]
  const tools = toolsFor(
    clip,
    (kind || undefined) as Parameters<typeof toolsFor>[1],
    Number(index ?? 0),
  )
  return dockFor(tools, clip)
}

/** Magic's icon: a small gradient orb with a slow shimmer (static with reduced motion). */
function MagicIcon({ tool, size }: { tool: ToolDef; size: number }) {
  const Icon = tool.icon
  return (
    <span
      aria-hidden
      className="shell-magic grid shrink-0 place-items-center rounded-full text-white"
      style={{ width: size + 10, height: size + 10 }}
    >
      <Icon size={size - 4} strokeWidth={2.25} />
    </span>
  )
}

function ToolButton({
  tool,
  compact,
  active,
  busy,
  quiet,
}: {
  tool: ToolDef
  compact: boolean
  active: boolean
  busy: boolean
  /** Desktop secondary tools: muted until hovered. */
  quiet?: boolean
}) {
  const clip = useSelectedClip()
  const pressed = active || (clip && tool.pressed ? tool.pressed(clip) : false)
  const Icon = tool.icon
  const magic = tool.id === 'ai'
  return (
    <button
      type="button"
      onClick={() => activateTool(tool)}
      aria-pressed={tool.panel || tool.pressed ? pressed : undefined}
      data-tool={tool.id}
      className={cn(
        'relative flex shrink-0 items-center justify-center gap-1.5 rounded-xl transition-[color,background-color] duration-200',
        compact
          ? 'h-9 px-2.5 text-[13px] font-medium'
          : 'h-14 min-w-0 flex-1 flex-col gap-1 px-0.5 text-[11px] font-semibold',
        pressed
          ? 'bg-accent/12 text-accent'
          : quiet
            ? 'text-subtle hover:text-fg'
            : 'text-muted hover:text-fg',
        magic && !pressed && 'text-fg',
      )}
    >
      {magic ? (
        <MagicIcon tool={tool} size={compact ? 14 : 18} />
      ) : (
        <Icon size={compact ? 16 : 22} strokeWidth={pressed ? 2.25 : 2} />
      )}
      <span className={cn(!compact && 'max-w-full truncate')}>{tool.label}</span>
      {busy && (
        <span
          className="absolute top-1.5 right-2 size-2 animate-pulse rounded-full bg-accent"
          aria-label="Working"
        />
      )}
    </button>
  )
}

/** Grouped grid of the tools that don't fit the phone dock. */
function MoreSheet({ dock, open, onClose }: { dock: Dock; open: boolean; onClose: () => void }) {
  const panel = useActivePanel()
  const clip = useSelectedClip()
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Tools"
      snapPoints={dock.more.length > 1 ? [0.5, 0.85] : [0.4]}
      fit
    >
      <div className="flex flex-col gap-5 px-4 pb-4" data-testid="dock-more-sheet">
        {dock.more.map((g) => (
          <section key={g.title} aria-label={g.title}>
            {dock.more.length > 1 && (
              <h3 className="mb-2 text-[13px] font-semibold tracking-wide text-muted uppercase">
                {g.title}
              </h3>
            )}
            <div className="grid grid-cols-4 gap-x-2 gap-y-3">
              {g.tools.map((t) => {
                const Icon = t.icon
                const pressed =
                  (!!t.panel && t.panel === panel) || (clip && t.pressed ? t.pressed(clip) : false)
                return (
                  <button
                    key={t.id}
                    type="button"
                    data-tool={t.id}
                    aria-pressed={t.panel || t.pressed ? pressed : undefined}
                    onClick={() => {
                      onClose()
                      activateTool(t)
                    }}
                    className="group flex min-w-0 flex-col items-center gap-1.5 rounded-2xl py-1 text-xs font-medium text-muted transition-colors hover:text-fg aria-pressed:text-accent"
                  >
                    <span className="grid size-12 place-items-center rounded-2xl bg-surface-2 text-fg transition-[transform,background-color] duration-150 ease-[var(--ease-spring)] group-hover:bg-surface-3 group-active:scale-95 group-aria-pressed:bg-accent/15 group-aria-pressed:text-accent">
                      <Icon size={22} />
                    </span>
                    <span className="max-w-full truncate">{t.label}</span>
                  </button>
                )
              })}
            </div>
          </section>
        ))}
      </div>
    </Sheet>
  )
}

function Divider() {
  return <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-line" />
}

function DoneButton({ compact }: { compact: boolean }) {
  return (
    <button
      type="button"
      aria-label="Done"
      title="Done"
      onClick={() => {
        editorStore.getState().clearSelection()
        if (isClipPanel(editorStore.getState().activePanel)) closePanel()
      }}
      className={cn(
        'grid shrink-0 place-items-center rounded-full bg-surface-2 text-fg transition-colors hover:bg-surface-3',
        compact ? 'size-9' : 'h-11 w-11',
      )}
    >
      <ChevronLeft size={compact ? 16 : 22} />
    </button>
  )
}

function ToolBar({ compact }: { compact: boolean }) {
  const dock = useDock()
  const panel = useActivePanel()
  const activeTool = useActiveTool()
  const aiBusy = useAnyAiRunning()
  const hasSelection = useEditor((s) => s.selection.clipIds.length > 0)
  const [moreOpen, setMoreOpen] = useState(false)
  const button = (t: ToolDef, quiet?: boolean) => (
    <ToolButton
      key={t.id}
      tool={t}
      compact={compact}
      active={!!t.panel && t.panel === panel}
      busy={t.id === 'ai' && aiBusy}
      quiet={quiet}
    />
  )
  const rest = dock.more.flatMap((g) => g.tools)

  if (compact) {
    return (
      <div
        className="flex h-11 items-center gap-0.5 overflow-x-auto px-2"
        role="toolbar"
        aria-label="Tools"
      >
        {hasSelection && <DoneButton compact />}
        {dock.primary.map((t) => button(t))}
        {rest.length > 0 && <Divider />}
        {rest.map((t) => button(t, true))}
      </div>
    )
  }

  // A tool opened from "More" sits in the dock while its panel is open.
  const promoted = rest.find((t) => (t.panel ? t.panel === panel : t.id === activeTool))
  return (
    <div className="flex h-16 items-center gap-0.5 px-1.5" role="toolbar" aria-label="Tools">
      {hasSelection && <DoneButton compact={false} />}
      {dock.primary.map((t) => button(t))}
      {promoted && button(promoted)}
      {rest.length > 0 && (
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen(true)}
          data-testid="dock-more"
          className="flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-xl px-0.5 text-[11px] font-semibold text-muted transition-colors hover:text-fg"
        >
          <LayoutGrid size={22} />
          More
        </button>
      )}
      <MoreSheet dock={dock} open={moreOpen} onClose={() => setMoreOpen(false)} />
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
      fit
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
