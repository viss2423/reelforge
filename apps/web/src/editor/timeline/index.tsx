/**
 * Timeline slot (see ../README.md). React renders the lanes for the current render window
 * and zoom; everything that changes per frame — scroll, ruler, playhead, drag previews,
 * snapping guides — is painted imperatively by `TimelineView` in requestAnimationFrame,
 * driven by `TimelineGestures`. Edits are committed as single store dispatches.
 */
import { Maximize2, ZoomIn, ZoomOut } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type DragEvent } from 'react'
import { cn } from '@/lib/cn.ts'
import { useIsDesktop } from '@/lib/useMediaQuery.ts'
import { editorStore, useEditor, useFps, useTracks, useZoom } from '@/state/index.ts'
import { ASSET_DRAG_MIME } from '../media/MediaLibrary.tsx'
import { ZOOM_STEP } from '../shortcuts.ts'
import { dropAsset, trackAccepts } from './commands.ts'
import { ADD_TRACK_SPACE, RULER_HEIGHT } from './constants.ts'
import { TimelineViewContext } from './context.ts'
import {
  contentEnd,
  layoutRows,
  pxPerUs,
  rowAt,
  timeToX,
  type Row,
  type TimeWindow,
} from './geometry.ts'
import { TimelineGestures } from './gestures.ts'
import { CaptionLane, MarkerLane, TrackLane } from './Lanes.tsx'
import { TrackHeaders } from './TrackHeaders.tsx'
import { TimelineView } from './view.ts'

const EMPTY_WORDS: never[] = []
const EMPTY_PINNED: ReadonlySet<string> = new Set()

const ASSET_CLIP_TYPE = { video: 'video', image: 'image', audio: 'audio' } as const

export function Timeline() {
  const [win, setWin] = useState<TimeWindow>({ start: 0, end: 0 })
  const [pinned, setPinned] = useState<ReadonlySet<string>>(EMPTY_PINNED)
  const [view] = useState(
    () => new TimelineView(editorStore, { onWindow: setWin, onPin: setPinned }),
  )
  const desktop = useIsDesktop()
  const [expandedPref, setExpanded] = useState<boolean | null>(null)
  const expanded = expandedPref ?? desktop

  const tracks = useTracks()
  const words = useEditor((s) => s.project?.captions?.words) ?? EMPTY_WORDS
  const captionsEnabled = useEditor((s) => s.project?.captions?.enabled ?? false)
  const markers = useEditor((s) => s.project?.markers) ?? EMPTY_WORDS
  const endUs = useEditor((s) => contentEnd(s.project))
  const empty = useEditor((s) => s.project?.tracks.every((t) => t.clips.length === 0) ?? true)
  const fps = useFps()
  const zoom = useZoom()
  const ppu = pxPerUs(zoom)
  const hasCaptions = words.length > 0
  const layout = layoutRows(tracks, hasCaptions)

  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const rulerRef = useRef<HTMLCanvasElement>(null)
  const headersRef = useRef<HTMLDivElement>(null)
  const playheadRef = useRef<HTMLDivElement>(null)
  const guideRef = useRef<HTMLDivElement>(null)
  const indicatorRef = useRef<HTMLDivElement>(null)
  const badgeRef = useRef<HTMLDivElement>(null)
  const rowsRef = useRef<readonly Row[]>(layout.rows)

  useLayoutEffect(() => {
    view.attach(
      {
        viewport: viewportRef.current!,
        content: contentRef.current!,
        ruler: rulerRef.current!,
        headers: headersRef.current,
        playhead: playheadRef.current!,
        guide: guideRef.current!,
        indicator: indicatorRef.current!,
        badge: badgeRef.current!,
      },
      { rowsHeight: layout.height + ADD_TRACK_SPACE, endUs, fps },
    )
    const gestures = new TimelineGestures({ view, store: editorStore, rows: () => rowsRef.current })
    gestures.attach()
    return () => {
      gestures.destroy()
      view.destroy()
    }
    // Attach once per mount; layout updates flow through the effect below.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [view])

  useLayoutEffect(() => {
    rowsRef.current = layout.rows
    view.setLayout({ rowsHeight: layout.height + ADD_TRACK_SPACE, endUs, fps })
  }, [view, layout.rows, layout.height, endUs, fps])

  // Headers live outside the viewport but scroll with it vertically.
  useLayoutEffect(() => {
    view.els.headers = headersRef.current
    view.scrollTo(view.scrollX, view.scrollY)
  }, [view, expanded])

  /* ---------------------------------------------------------------- library drops */

  const dropTarget = (e: DragEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const pt = view.point(e.clientX, e.clientY, rect)
    const row = rowsRef.current[rowAt(rowsRef.current, pt.y, true)]
    return { t: Math.max(0, pt.t), row }
  }
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes(ASSET_DRAG_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    view.setGuide(dropTarget(e).t)
  }
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    const id = e.dataTransfer.getData(ASSET_DRAG_MIME)
    view.setGuide(null)
    if (!id) return
    e.preventDefault()
    const asset = editorStore.getState().assets[id]
    if (!asset) return
    const { t, row } = dropTarget(e)
    const track =
      row?.type === 'track' && trackAccepts(row.track.kind, ASSET_CLIP_TYPE[asset.kind])
        ? row.track
        : undefined
    dropAsset(editorStore, asset, track?.id, t)
  }

  return (
    <TimelineViewContext value={view}>
      <div
        className="flex h-full min-h-0 flex-col bg-surface select-none [-webkit-touch-callout:none]"
        data-testid="timeline"
      >
        <div className="relative flex min-h-0 flex-1">
          <TrackHeaders
            rows={layout.rows}
            rowsHeight={layout.height}
            expanded={expanded}
            onToggleExpanded={() => setExpanded(!expanded)}
            captionsEnabled={captionsEnabled}
            innerRef={headersRef}
          />
          <div
            ref={viewportRef}
            role="region"
            aria-label="Timeline"
            data-testid="timeline-viewport"
            className="relative min-w-0 flex-1 touch-none overflow-hidden overscroll-contain"
            onDragOver={onDragOver}
            onDragLeave={() => view.setGuide(null)}
            onDrop={onDrop}
          >
            <canvas
              ref={rulerRef}
              aria-hidden
              data-testid="timeline-ruler"
              className="absolute top-0 left-0 cursor-col-resize border-b border-line bg-surface"
              style={{ height: RULER_HEIGHT }}
            />
            <div
              className="absolute inset-x-0 bottom-0 overflow-hidden"
              style={{ top: RULER_HEIGHT }}
            >
              <div
                ref={contentRef}
                data-testid="timeline-content"
                className="absolute top-0 left-0"
                style={{ width: timeToX(Math.max(win.end, endUs), ppu), height: layout.height }}
              >
                {layout.rows.map((row) =>
                  row.type === 'track' ? (
                    <TrackLane
                      key={row.key}
                      row={row}
                      track={row.track}
                      ppu={ppu}
                      win={win}
                      pinned={pinned}
                    />
                  ) : row.type === 'captions' ? (
                    <CaptionLane
                      key={row.key}
                      row={row}
                      words={words}
                      enabled={captionsEnabled}
                      ppu={ppu}
                      win={win}
                    />
                  ) : (
                    <MarkerLane key={row.key} row={row} markers={markers} ppu={ppu} win={win} />
                  ),
                )}
              </div>
            </div>
            <div
              ref={indicatorRef}
              hidden
              aria-hidden
              data-testid="insert-indicator"
              className="pointer-events-none absolute top-0 left-0 z-30 w-0.5 rounded-full bg-accent shadow-[0_0_8px_var(--rf-accent)]"
            />
            <div
              ref={guideRef}
              hidden
              aria-hidden
              data-testid="snap-guide"
              className={cn(
                'pointer-events-none absolute inset-y-0 left-0 z-30 w-px bg-warning',
                'data-[kind=playhead]:bg-accent data-[kind=marker]:bg-accent data-[kind=beat]:bg-violet data-[kind=scene]:bg-violet',
              )}
            />
            <div
              ref={badgeRef}
              hidden
              aria-hidden
              data-testid="drag-badge"
              className="pointer-events-none absolute top-0 left-0 z-40 rounded bg-black/80 px-1.5 py-0.5 font-mono text-[10px] text-white"
            />
            <div
              ref={playheadRef}
              aria-hidden
              data-testid="timeline-playhead"
              className="pointer-events-none absolute inset-y-0 left-0 z-30 w-0"
            >
              <div className="absolute inset-y-0 -left-px w-0.5 bg-fg shadow-[0_0_2px_rgb(0_0_0/0.6)]" />
              <div className="absolute top-0 -left-[6px] h-3.5 w-3 rounded-b-sm bg-fg [clip-path:polygon(0_0,100%_0,100%_60%,50%_100%,0_60%)]" />
            </div>
            {desktop && <ZoomControls view={view} />}
            {empty && (
              <p className="pointer-events-none absolute right-3 bottom-2 text-[11px] text-subtle">
                Add media to start editing
              </p>
            )}
          </div>
        </div>
      </div>
    </TimelineViewContext>
  )
}

function ZoomControls({ view }: { view: TimelineView }) {
  const btn =
    'flex size-7 items-center justify-center rounded-md text-muted hover:bg-surface-3 hover:text-fg'
  return (
    <div
      data-tl-ignore
      className="absolute right-2 bottom-2 z-30 flex items-center gap-0.5 rounded-lg border border-line bg-surface/90 p-0.5 shadow backdrop-blur"
    >
      <button
        type="button"
        aria-label="Zoom out"
        title="Zoom out"
        className={btn}
        onClick={() => view.zoomTo(view.zoom / ZOOM_STEP)}
      >
        <ZoomOut size={14} />
      </button>
      <button
        type="button"
        aria-label="Zoom in"
        title="Zoom in"
        className={btn}
        onClick={() => view.zoomTo(view.zoom * ZOOM_STEP)}
      >
        <ZoomIn size={14} />
      </button>
      <button
        type="button"
        aria-label="Zoom to fit"
        title="Zoom to fit"
        className={btn}
        onClick={() => {
          view.zoomTo(view.fitZoom(), 0)
          view.scrollTo(0)
        }}
      >
        <Maximize2 size={14} />
      </button>
    </div>
  )
}
