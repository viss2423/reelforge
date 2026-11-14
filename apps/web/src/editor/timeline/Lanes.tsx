/**
 * Lane rows: tracks (virtualised clips + main-track transition handles), the caption lane
 * (word chips, merged into bars when zoomed out) and the markers lane (beats, scenes, user
 * markers). Each lane renders only what intersects the render window, found by binary
 * search, so cost is independent of project length.
 */
import type { Marker, Track, Word } from '@reelforge/core'
import { Blend, Plus } from 'lucide-react'
import { memo, type ReactNode } from 'react'
import { cn } from '@/lib/cn.ts'
import { editorStore, useIsSelected } from '@/state/index.ts'
import { MEDIA_PANEL } from '../layout.ts'
import { ClipView } from './ClipView.tsx'
import { openTransition } from './commands.ts'
import {
  lowerBound,
  timeToX,
  trackSpans,
  upperBound,
  visibleRange,
  type Row,
  type TimeWindow,
} from './geometry.ts'

const TRACK_NAME: Record<Track['kind'], string> = {
  main: 'Main track',
  overlay: 'Overlay track',
  text: 'Text track',
  audio: 'Audio track',
}

export const trackLabel = (t: Track): string => t.name || TRACK_NAME[t.kind]

interface LaneProps {
  ppu: number
  win: TimeWindow
}

/* ------------------------------------------------------------------ tracks */

export const TrackLane = memo(function TrackLane({
  row,
  track,
  ppu,
  win,
  pinned,
}: LaneProps & {
  row: Extract<Row, { type: 'track' }>
  track: Track
  pinned: ReadonlySet<string>
}) {
  const spans = trackSpans(track)
  const [from, to] = visibleRange(spans, win.start, win.end)
  const indices: number[] = []
  for (let i = from; i < to; i++) indices.push(i)
  // Dragged clips stay mounted even when auto-scroll carries their origin off-window.
  if (pinned.size)
    track.clips.forEach((c, i) => {
      if ((i < from || i >= to) && pinned.has(c.id)) indices.push(i)
    })
  const main = track.kind === 'main'
  const transitions: ReactNode[] = []
  if (main)
    for (let i = Math.max(1, from); i < to; i++) {
      const clip = track.clips[i]!
      transitions.push(
        <TransitionHandle
          key={clip.id}
          clipId={clip.id}
          prevId={track.clips[i - 1]!.id}
          trackId={track.id}
          x={timeToX(spans.starts[i]! + spans.overlaps[i]! / 2, ppu)}
          overlapPx={spans.overlaps[i]! * ppu}
          active={(clip.type === 'video' || clip.type === 'image') && !!clip.transitionIn}
          height={row.height}
        />,
      )
    }
  return (
    <div
      role="group"
      aria-label={trackLabel(track)}
      data-track-id={track.id}
      data-track-kind={track.kind}
      className={cn(
        'absolute inset-x-0',
        main ? 'rounded-md bg-surface-2/80' : 'bg-surface-2/30',
        track.locked &&
          'bg-[repeating-linear-gradient(135deg,transparent_0_6px,rgb(127_127_127/0.08)_6px_12px)]',
      )}
      style={{ top: row.y, height: row.height }}
    >
      {indices.map((i) => {
        const c = track.clips[i]!
        return (
          <ClipView
            key={c.id}
            clip={c}
            trackId={track.id}
            trackKind={track.kind}
            locked={track.locked}
            hidden={track.hidden}
            muted={track.muted}
            start={spans.starts[i]!}
            end={spans.ends[i]!}
            ppu={ppu}
            height={row.height}
            win={win}
          />
        )
      })}
      {transitions}
      {main && track.clips.length === 0 && <EmptyMainHint />}
    </div>
  )
})

/**
 * Button between two main-track clips: shows / edits the transition into the right clip.
 * Hidden while either neighbour is selected: the selected clip's trim handles own that edge
 * (the Transitions tool still reaches it through the selection).
 */
function TransitionHandle({
  clipId,
  prevId,
  trackId,
  x,
  overlapPx,
  active,
  height,
}: {
  clipId: string
  prevId: string
  trackId: string
  x: number
  overlapPx: number
  active: boolean
  height: number
}) {
  const rightSelected = useIsSelected(clipId)
  const leftSelected = useIsSelected(prevId)
  if (rightSelected || leftSelected) return null
  return (
    <>
      {active && overlapPx >= 2 && (
        <div
          aria-hidden
          className="pointer-events-none absolute top-0 z-10 bg-white/25 bg-[linear-gradient(90deg,transparent,rgb(255_255_255/0.35),transparent)]"
          style={{ left: x - overlapPx / 2, width: overlapPx, height }}
        />
      )}
      <button
        type="button"
        data-tl-ignore
        data-testid="transition-handle"
        aria-label={active ? 'Edit transition' : 'Add transition'}
        title={active ? 'Edit transition' : 'Add transition'}
        onClick={() => openTransition(editorStore, clipId, trackId)}
        className={cn(
          'absolute z-10 flex size-5 -translate-x-1/2 items-center justify-center rounded-md border shadow',
          // 44 px touch target without a 44 px visual.
          'before:absolute before:-inset-2.5 before:content-[""]',
          active
            ? 'border-white bg-accent text-accent-fg'
            : 'border-white/70 bg-surface-3/90 text-fg hover:bg-surface-3',
        )}
        style={{ left: x, top: height / 2 - 10 }}
      >
        {active ? <Blend size={12} /> : <Plus size={12} />}
      </button>
    </>
  )
}

function EmptyMainHint() {
  return (
    <button
      type="button"
      data-tl-ignore
      onClick={() => editorStore.getState().setActivePanel(MEDIA_PANEL)}
      className="absolute inset-y-1 left-4 flex items-center gap-2 rounded-md border border-dashed border-line px-3 text-xs text-muted hover:text-fg"
    >
      <Plus size={14} /> Add media
    </button>
  )
}

/* ------------------------------------------------------------------ captions */

/** Below this width a word has no room for text and merges into a bar. */
const CHIP_MIN_PX = 14

type CaptionItem =
  | { kind: 'chip'; index: number; word: Word; x: number; w: number }
  | { kind: 'bar'; x: number; w: number }

/**
 * Visible caption items: words wide enough get a chip; runs of narrow words are merged
 * into bars so zoomed-out timelines stay at a few dozen nodes instead of thousands.
 */
export const captionItems = (
  words: readonly Word[],
  ppu: number,
  win: TimeWindow,
): CaptionItem[] => {
  const out: CaptionItem[] = []
  // Words are sorted and non-overlapping, so ends are monotonic too.
  let lo = 0
  let hi = words.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (words[mid]!.end <= win.start) lo = mid + 1
    else hi = mid
  }
  let bar: { x: number; end: number } | null = null
  const flush = () => {
    if (bar) out.push({ kind: 'bar', x: bar.x, w: Math.max(2, bar.end - bar.x) })
    bar = null
  }
  for (let i = lo; i < words.length && words[i]!.start < win.end; i++) {
    const word = words[i]!
    const x = timeToX(word.start, ppu)
    const w = (word.end - word.start) * ppu
    if (w >= CHIP_MIN_PX) {
      flush()
      out.push({ kind: 'chip', index: i, word, x, w })
    } else if (bar && x - bar.end < 3) bar.end = x + w
    else {
      flush()
      bar = { x, end: x + w }
    }
  }
  flush()
  return out
}

export const CaptionLane = memo(function CaptionLane({
  row,
  words,
  enabled,
  ppu,
  win,
}: LaneProps & { row: Row; words: readonly Word[]; enabled: boolean }) {
  const items = captionItems(words, ppu, win)
  return (
    <div
      role="group"
      aria-label="Captions"
      data-testid="caption-lane"
      className={cn('absolute inset-x-0', !enabled && 'opacity-40')}
      style={{ top: row.y, height: row.height }}
    >
      {items.map((it) =>
        it.kind === 'chip' ? (
          <div
            key={`w${it.index}`}
            data-word-index={it.index}
            title={it.word.text}
            className={cn(
              'absolute inset-y-0.5 truncate rounded-sm px-1 text-[10px] leading-[18px] font-semibold',
              it.word.filler
                ? 'bg-surface-3 text-subtle line-through'
                : it.word.emphasis
                  ? 'bg-amber-400 text-black'
                  : 'bg-sky-500/80 text-white',
            )}
            style={{ left: it.x, width: Math.max(2, it.w - 1) }}
          >
            {it.word.emoji ? `${it.word.text} ${it.word.emoji}` : it.word.text}
          </div>
        ) : (
          <div
            key={`b${it.x}`}
            aria-hidden
            className="absolute inset-y-1.5 rounded-sm bg-sky-500/60"
            style={{ left: it.x, width: it.w }}
          />
        ),
      )}
    </div>
  )
})

/* ------------------------------------------------------------------ markers */

const sortedCache = new WeakMap<readonly Marker[], { list: Marker[]; times: Float64Array }>()

const sortedMarkers = (markers: readonly Marker[]) => {
  let s = sortedCache.get(markers)
  if (!s) {
    const list = markers.toSorted((a, b) => a.t - b.t)
    s = { list, times: Float64Array.from(list, (m) => m.t) }
    sortedCache.set(markers, s)
  }
  return s
}

export const MarkerLane = memo(function MarkerLane({
  row,
  markers,
  ppu,
  win,
}: LaneProps & { row: Row; markers: readonly Marker[] }) {
  const { list, times } = sortedMarkers(markers)
  const from = lowerBound(times, win.start)
  const to = upperBound(times, win.end)
  const out: ReactNode[] = []
  for (let i = from; i < to; i++) {
    const m = list[i]!
    const x = timeToX(m.t, ppu)
    out.push(
      m.kind === 'user' ? (
        <div
          key={m.id}
          data-marker-kind="user"
          title={m.label ?? 'Marker'}
          className="absolute top-0 flex h-full items-center"
          style={{ left: x - 1 }}
        >
          <span className="h-full w-0.5 bg-accent" />
          {m.label && (
            <span className="ml-0.5 max-w-24 truncate rounded-sm bg-accent px-1 text-[9px] leading-3 text-accent-fg">
              {m.label}
            </span>
          )}
        </div>
      ) : (
        <span
          key={m.id}
          data-marker-kind={m.kind}
          aria-hidden
          className={cn(
            'absolute',
            m.kind === 'scene'
              ? 'inset-y-0 w-0.5 bg-violet'
              : 'top-1/2 size-1 -translate-y-1/2 rounded-full bg-muted',
          )}
          style={{ left: m.kind === 'scene' ? x - 1 : x - 2 }}
        />
      ),
    )
  }
  return (
    <div
      role="group"
      aria-label="Markers"
      data-testid="marker-lane"
      className="absolute inset-x-0"
      style={{ top: row.y, height: row.height }}
    >
      {out}
    </div>
  )
})
