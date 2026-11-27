/**
 * Track header column: per-row icon/name with mute, hide and lock toggles, the add-track
 * menu, and the corner cell (live timecode, collapse toggle). On phones the column starts
 * collapsed to icons; tapping the toggle (or an icon) expands it.
 */
import { formatTimecode, type Track } from '@reelforge/core'
import {
  ChevronsLeft,
  ChevronsRight,
  Eye,
  EyeOff,
  Film,
  Flag,
  Layers,
  Lock,
  LockOpen,
  Music,
  Plus,
  Subtitles,
  Type,
  Volume2,
  VolumeX,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { cn } from '@/lib/cn.ts'
import { editorStore } from '@/state/index.ts'
import { addTrackOfKind, toggleCaptions, toggleTrackFlag, type TrackFlag } from './commands.ts'
import { HEADER_WIDTH_COLLAPSED, HEADER_WIDTH_EXPANDED, RULER_HEIGHT } from './constants.ts'
import type { Row } from './geometry.ts'
import { trackLabel } from './Lanes.tsx'

const KIND_ICON: Record<Track['kind'], LucideIcon> = {
  main: Film,
  overlay: Layers,
  text: Type,
  audio: Music,
}

/** Which toggles a track kind offers. */
const FLAGS: Record<Track['kind'], readonly TrackFlag[]> = {
  main: ['muted', 'hidden', 'locked'],
  overlay: ['muted', 'hidden', 'locked'],
  text: ['hidden', 'locked'],
  audio: ['muted', 'locked'],
}

export interface TrackHeadersProps {
  rows: readonly Row[]
  rowsHeight: number
  expanded: boolean
  onToggleExpanded: () => void
  captionsEnabled: boolean
  innerRef: Ref<HTMLDivElement>
}

export function TrackHeaders({
  rows,
  rowsHeight,
  expanded,
  onToggleExpanded,
  captionsEnabled,
  innerRef,
}: TrackHeadersProps) {
  const width = expanded ? HEADER_WIDTH_EXPANDED : HEADER_WIDTH_COLLAPSED
  return (
    <div
      className="relative flex shrink-0 flex-col border-r border-line bg-surface transition-[width] duration-200"
      style={{ width }}
      data-testid="track-headers"
    >
      <div
        className="flex shrink-0 items-center justify-between gap-1 border-b border-line px-1"
        style={{ height: RULER_HEIGHT }}
      >
        {expanded && <Timecode />}
        <button
          type="button"
          onClick={onToggleExpanded}
          aria-label={expanded ? 'Collapse track headers' : 'Expand track headers'}
          aria-expanded={expanded}
          className="relative ml-auto flex size-6 items-center justify-center rounded text-muted before:absolute before:-inset-2.5 before:content-[''] hover:text-fg"
        >
          {expanded ? <ChevronsLeft size={14} /> : <ChevronsRight size={14} />}
        </button>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div
          ref={innerRef}
          className="absolute inset-x-0 top-0"
          style={{ height: rowsHeight + 120 }}
        >
          {rows.map((row) => (
            <div
              key={row.key}
              className="absolute inset-x-0 flex items-center gap-1 px-1.5"
              style={{ top: row.y, height: row.height }}
            >
              {row.type === 'markers' && (
                <RowLabel icon={Flag} label="Markers" expanded={expanded} small />
              )}
              {row.type === 'captions' && (
                <>
                  <RowLabel icon={Subtitles} label="Captions" expanded={expanded} />
                  {expanded && (
                    <Toggle
                      on={!captionsEnabled}
                      label={captionsEnabled ? 'Hide captions' : 'Show captions'}
                      onClick={() => toggleCaptions(editorStore)}
                      icon={captionsEnabled ? Eye : EyeOff}
                    />
                  )}
                </>
              )}
              {row.type === 'track' && (
                <TrackRow track={row.track} expanded={expanded} onExpand={onToggleExpanded} />
              )}
            </div>
          ))}
          <AddTrack top={rowsHeight + 4} expanded={expanded} />
        </div>
      </div>
    </div>
  )
}

function RowLabel({
  icon: Icon,
  label,
  expanded,
  small,
}: {
  icon: LucideIcon
  label: string
  expanded: boolean
  small?: boolean
}) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5 text-muted" title={label}>
      <Icon size={small ? 11 : 14} className="shrink-0" aria-hidden />
      {expanded && (
        <span className={cn('truncate', small ? 'text-[10px]' : 'text-xs')}>{label}</span>
      )}
    </span>
  )
}

function TrackRow({
  track,
  expanded,
  onExpand,
}: {
  track: Track
  expanded: boolean
  onExpand: () => void
}) {
  const Icon = KIND_ICON[track.kind]
  const label = trackLabel(track)
  if (!expanded) {
    const flagged = track.muted || track.hidden || track.locked
    return (
      <button
        type="button"
        onClick={onExpand}
        aria-label={`${label} — show track controls`}
        title={label}
        className={cn(
          'relative mx-auto flex size-7 items-center justify-center rounded-md',
          track.kind === 'main' ? 'bg-surface-3 text-fg' : 'text-muted',
        )}
      >
        <Icon size={15} aria-hidden />
        {flagged && (
          <span className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-warning" />
        )}
      </button>
    )
  }
  return (
    <>
      <span
        className={cn(
          'flex min-w-0 flex-1 items-center gap-1.5 text-xs',
          track.kind === 'main' ? 'font-semibold text-fg' : 'text-muted',
        )}
        title={label}
      >
        <Icon size={14} className="shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
      </span>
      {FLAGS[track.kind].map((flag) => (
        <FlagToggle key={flag} track={track} flag={flag} />
      ))}
    </>
  )
}

const FLAG_UI: Record<TrackFlag, { on: LucideIcon; off: LucideIcon; label: [string, string] }> = {
  muted: { on: VolumeX, off: Volume2, label: ['Unmute', 'Mute'] },
  hidden: { on: EyeOff, off: Eye, label: ['Show', 'Hide'] },
  locked: { on: Lock, off: LockOpen, label: ['Unlock', 'Lock'] },
}

function FlagToggle({ track, flag }: { track: Track; flag: TrackFlag }) {
  const ui = FLAG_UI[flag]
  const on = track[flag]
  return (
    <Toggle
      on={on}
      icon={on ? ui.on : ui.off}
      label={`${ui.label[on ? 0 : 1]} ${trackLabel(track).toLowerCase()}`}
      onClick={() => toggleTrackFlag(editorStore, track.id, flag)}
    />
  )
}

function Toggle({
  on,
  icon: Icon,
  label,
  onClick,
}: {
  on: boolean
  icon: LucideIcon
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      title={label}
      onClick={onClick}
      className={cn(
        'relative flex size-6 shrink-0 items-center justify-center rounded before:absolute before:-inset-1 before:content-[""]',
        on ? 'text-warning' : 'text-subtle hover:text-fg',
      )}
    >
      <Icon size={13} />
    </button>
  )
}

const ADD_KINDS: ReadonlyArray<{
  kind: 'overlay' | 'text' | 'audio'
  label: string
  icon: LucideIcon
}> = [
  { kind: 'overlay', label: 'Overlay', icon: Layers },
  { kind: 'text', label: 'Text', icon: Type },
  { kind: 'audio', label: 'Audio', icon: Music },
]

function AddTrack({ top, expanded }: { top: number; expanded: boolean }) {
  const [open, setOpen] = useState(false)
  let menu: ReactNode = null
  if (open)
    menu = (
      <div role="menu" aria-label="Add track" className="mt-1 flex flex-col gap-0.5">
        {ADD_KINDS.map(({ kind, label, icon: Icon }) => (
          <button
            key={kind}
            type="button"
            role="menuitem"
            aria-label={`Add ${label.toLowerCase()} track`}
            title={`Add ${label.toLowerCase()} track`}
            onClick={() => {
              setOpen(false)
              addTrackOfKind(editorStore, kind)
            }}
            className="flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs text-muted hover:bg-surface-2 hover:text-fg"
          >
            <Icon size={13} className="shrink-0" aria-hidden />
            {expanded && label}
          </button>
        ))}
      </div>
    )
  return (
    <div className="absolute inset-x-1" style={{ top }}>
      <button
        type="button"
        aria-label="Add track"
        aria-expanded={open}
        aria-haspopup="menu"
        title="Add track"
        onClick={() => setOpen((o) => !o)}
        className="flex h-7 w-full items-center justify-center gap-1 rounded-md border border-dashed border-line text-xs text-muted hover:text-fg"
      >
        <Plus size={13} aria-hidden />
        {expanded && 'Track'}
      </button>
      {menu}
    </div>
  )
}

/**
 * Phones have no header column: the timeline options sheet lists each lane with its
 * mute / hide / lock toggles (same names as the header buttons) and the add-track choices.
 */
export function TrackControls({
  rows,
  captionsEnabled,
  onAdded,
}: {
  rows: readonly Row[]
  captionsEnabled: boolean
  onAdded?: () => void
}) {
  return (
    <div className="flex flex-col gap-4">
      <section aria-label="Tracks">
        <h3 className="mb-1 text-[13px] font-semibold tracking-wide text-muted uppercase">
          Tracks
        </h3>
        <ul className="flex flex-col">
          {rows.map((row) => {
            if (row.type === 'markers') return null
            if (row.type === 'captions')
              return (
                <li key={row.key} className="flex h-11 items-center gap-3">
                  <Subtitles size={18} className="shrink-0 text-muted" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-[15px]">Captions</span>
                  <BigToggle
                    on={!captionsEnabled}
                    label={captionsEnabled ? 'Hide captions' : 'Show captions'}
                    onClick={() => toggleCaptions(editorStore)}
                    icon={captionsEnabled ? Eye : EyeOff}
                  />
                </li>
              )
            const Icon = KIND_ICON[row.track.kind]
            return (
              <li key={row.key} className="flex h-11 items-center gap-3">
                <Icon size={18} className="shrink-0 text-muted" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-[15px]">{trackLabel(row.track)}</span>
                {FLAGS[row.track.kind].map((flag) => {
                  const ui = FLAG_UI[flag]
                  const on = row.track[flag]
                  return (
                    <BigToggle
                      key={flag}
                      on={on}
                      icon={on ? ui.on : ui.off}
                      label={`${ui.label[on ? 0 : 1]} ${trackLabel(row.track).toLowerCase()}`}
                      onClick={() => toggleTrackFlag(editorStore, row.track.id, flag)}
                    />
                  )
                })}
              </li>
            )
          })}
        </ul>
      </section>
      <section aria-label="Add track">
        <h3 className="mb-2 text-[13px] font-semibold tracking-wide text-muted uppercase">
          Add track
        </h3>
        <div className="grid grid-cols-3 gap-2">
          {ADD_KINDS.map(({ kind, label, icon: Icon }) => (
            <button
              key={kind}
              type="button"
              aria-label={`Add ${label.toLowerCase()} track`}
              onClick={() => {
                addTrackOfKind(editorStore, kind)
                onAdded?.()
              }}
              className="flex h-12 items-center justify-center gap-2 rounded-2xl bg-surface-2 text-sm font-medium transition-colors hover:bg-surface-3"
            >
              <Icon size={16} aria-hidden />
              {label}
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}

function BigToggle({
  on,
  icon: Icon,
  label,
  onClick,
}: {
  on: boolean
  icon: LucideIcon
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      title={label}
      onClick={onClick}
      className={cn(
        'grid size-11 shrink-0 place-items-center rounded-full transition-colors',
        on ? 'bg-warning/15 text-warning' : 'text-muted hover:bg-surface-2 hover:text-fg',
      )}
    >
      <Icon size={18} />
    </button>
  )
}

/** Live playhead timecode, written straight to the DOM (no React render per frame). */
function Timecode() {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const el = ref.current!
    el.textContent = formatTimecode(editorStore.getState().playhead)
    return editorStore.subscribe((s, prev) => {
      if (s.playhead !== prev.playhead) el.textContent = formatTimecode(s.playhead)
    })
  }, [])
  return (
    <span
      ref={ref}
      data-testid="timeline-timecode"
      className="font-mono text-[10px] text-muted tabular-nums"
      aria-label="Playhead time"
    />
  )
}
