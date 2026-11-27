/**
 * On-canvas editing layer over the preview: selection frame with scale/rotate handles,
 * snapping guides, the Reels safe-zone overlay, crop mode and inline text editing. React
 * renders the static structure (and re-renders only for the selected clip's identity, crop
 * mode and text editing); everything per frame is positioned by `OverlayController`.
 */
import { produce } from 'immer'
import { Crop as CropIcon, Ellipsis, LayoutTemplate, Check } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { cn } from '@/lib/cn.ts'
import { editorStore } from '@/state/editorStore.ts'
import { locateClip, useEditor } from '@/state/selectors.ts'
import { setEditPref, useEditPref } from '../../editPrefs.ts'
import { ShellMenu, ShellMenuItem } from '../../ShellMenu.tsx'
import { setText } from '../../panels/model/edits.ts'
import { setPreviewOverride } from '../previewOverride.ts'
import { OverlayController } from './controller.ts'
import { SAFE_ZONE_RECTS, textBlockSize, CANVAS_H, CANVAS_W } from './geometry.ts'

const CORNERS = ['nw', 'ne', 'se', 'sw'] as const
const CORNER_POS: Record<(typeof CORNERS)[number], string> = {
  nw: '-top-2 -left-2 cursor-nwse-resize',
  ne: '-top-2 -right-2 cursor-nesw-resize',
  se: '-right-2 -bottom-2 cursor-nwse-resize',
  sw: '-bottom-2 -left-2 cursor-nesw-resize',
}

/** Crop handles at displayed sides/corners (the controller maps them through flips). */
const CROP_HANDLES = [
  { at: 'left,top', cls: '-top-1.5 -left-1.5 size-4 cursor-nwse-resize' },
  { at: 'right,top', cls: '-top-1.5 -right-1.5 size-4 cursor-nesw-resize' },
  { at: 'right,bottom', cls: '-right-1.5 -bottom-1.5 size-4 cursor-nwse-resize' },
  { at: 'left,bottom', cls: '-bottom-1.5 -left-1.5 size-4 cursor-nesw-resize' },
  { at: 'left', cls: 'top-1/2 -left-1.5 h-8 w-3 -translate-y-1/2 cursor-ew-resize' },
  { at: 'right', cls: 'top-1/2 -right-1.5 h-8 w-3 -translate-y-1/2 cursor-ew-resize' },
  { at: 'top', cls: '-top-1.5 left-1/2 h-3 w-8 -translate-x-1/2 cursor-ns-resize' },
  { at: 'bottom', cls: '-bottom-1.5 left-1/2 h-3 w-8 -translate-x-1/2 cursor-ns-resize' },
] as const

export function TransformOverlay({ width, height }: { width: number; height: number }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const guideXRef = useRef<HTMLDivElement>(null)
  const guideYRef = useRef<HTMLDivElement>(null)
  const badgeRef = useRef<HTMLDivElement>(null)
  const cropFullRef = useRef<HTMLDivElement>(null)
  const cropRectRef = useRef<HTMLDivElement>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [cropMode, setCropMode] = useState(false)
  const [ctl] = useState(() => new OverlayController(editorStore, { onEditText: setEditing }))
  const selectedId = useEditor((s) =>
    s.selection.clipIds.length === 1 ? s.selection.clipIds[0]! : null,
  )
  const selectedType = useEditor((s) =>
    selectedId ? (locateClip(s.project, selectedId)?.clip.type ?? null) : null,
  )
  const safeZones = useEditPref('safeZones')
  const hasClips = useEditor((s) => s.project?.tracks.some((t) => t.clips.length > 0) ?? false)
  const media = selectedType === 'video' || selectedType === 'image'
  const crop = cropMode && media

  useLayoutEffect(() => {
    ctl.attach({
      root: rootRef.current!,
      frame: frameRef.current!,
      guideX: guideXRef.current!,
      guideY: guideYRef.current!,
      badge: badgeRef.current!,
      cropFull: cropFullRef.current!,
      cropRect: cropRectRef.current!,
    })
    return () => ctl.destroy()
  }, [ctl])

  useLayoutEffect(() => {
    ctl.setSize(width)
  }, [ctl, width])

  useLayoutEffect(() => {
    ctl.setCropMode(crop)
  }, [ctl, crop])

  // Always mounted (refs must exist when the controller attaches); hidden until sized.
  return (
    <div
      ref={rootRef}
      data-testid="transform-overlay"
      data-crop-mode={crop || undefined}
      hidden={width === 0}
      className="group/ov absolute inset-0 touch-none select-none"
      style={{ width, height }}
    >
      <SafeZones visible={safeZones} />
      <div
        ref={guideXRef}
        hidden
        aria-hidden
        data-testid="canvas-guide-x"
        className="pointer-events-none absolute inset-y-0 left-0 w-px bg-accent shadow-[0_0_4px_var(--rf-accent)] data-[kind=safe]:bg-warning"
      />
      <div
        ref={guideYRef}
        hidden
        aria-hidden
        data-testid="canvas-guide-y"
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-accent shadow-[0_0_4px_var(--rf-accent)] data-[kind=safe]:bg-warning"
      />
      <div
        ref={frameRef}
        hidden
        data-testid="transform-frame"
        className="absolute top-0 left-0 origin-center cursor-move rounded-[2px] outline-2 outline-white [box-shadow:0_0_0_1px_rgb(0_0_0/0.5)] data-locked:cursor-not-allowed data-locked:outline-dashed"
      >
        {CORNERS.map((c) => (
          <div
            key={c}
            data-handle={c}
            data-testid={`handle-${c}`}
            className={cn(
              'absolute size-4 rounded-full border-2 border-accent bg-white shadow',
              // 40 px touch target, 16 px visual.
              'before:absolute before:-inset-3 before:content-[""]',
              'in-data-locked:hidden',
              CORNER_POS[c],
            )}
          />
        ))}
        <div
          data-handle="rot"
          data-testid="handle-rot"
          aria-label="Rotate"
          className="absolute -top-9 left-1/2 size-5 in-data-rot-in:top-3 -translate-x-1/2 cursor-grab rounded-full border-2 border-accent bg-white shadow before:absolute before:-inset-3 before:content-[''] in-data-locked:hidden"
        />
      </div>
      <div
        ref={cropFullRef}
        hidden
        data-testid="crop-frame"
        className="pointer-events-none absolute top-0 left-0 origin-center overflow-hidden outline outline-1 outline-white/60"
      >
        <div
          ref={cropRectRef}
          data-testid="crop-rect"
          className="pointer-events-auto absolute outline-2 outline-white [box-shadow:0_0_0_9999px_rgb(0_0_0/0.55)]"
        >
          <div className="pointer-events-none absolute inset-0 [background:linear-gradient(to_right,transparent_33%,rgb(255_255_255/0.35)_33%,rgb(255_255_255/0.35)_calc(33%+1px),transparent_calc(33%+1px),transparent_66%,rgb(255_255_255/0.35)_66%,rgb(255_255_255/0.35)_calc(66%+1px),transparent_calc(66%+1px))]" />
          {CROP_HANDLES.map((h) => (
            <div
              key={h.at}
              data-crop-at={h.at}
              data-crop={h.at}
              data-testid={`crop-${h.at.replace(',', '-')}`}
              className={cn('absolute rounded-sm bg-white shadow', h.cls)}
            />
          ))}
        </div>
      </div>
      <div
        ref={badgeRef}
        hidden
        aria-hidden
        data-testid="transform-badge"
        className="pointer-events-none absolute top-0 left-0 rounded bg-black/80 px-1.5 py-0.5 font-mono text-[11px] text-white"
      />
      {/* An empty stage shows its own call to action instead of options. */}
      {hasClips && (
        <OverlayToolbar
          media={media}
          crop={crop}
          onCrop={() => setCropMode(!crop)}
          safeZones={safeZones}
        />
      )}
      {editing && (
        <InlineTextEditor
          clipId={editing}
          scale={width / CANVAS_W}
          onDone={() => setEditing(null)}
        />
      )}
    </div>
  )
}

function OverlayToolbar({
  media,
  crop,
  onCrop,
  safeZones,
}: {
  media: boolean
  crop: boolean
  onCrop: () => void
  safeZones: boolean
}) {
  // Cropping: a single glass "Done" pill replaces the menu until the crop is finished.
  if (crop)
    return (
      <button
        type="button"
        data-ov-ignore
        aria-pressed
        aria-label="Done cropping"
        data-testid="crop-toggle"
        onClick={onCrop}
        className="shell-glass shell-pop absolute top-2 left-1/2 z-10 flex h-9 -translate-x-1/2 items-center gap-1.5 rounded-full px-4 text-sm font-semibold"
      >
        <Check size={16} aria-hidden />
        Done
      </button>
    )
  return (
    <ShellMenu
      data-ov-ignore
      label="Preview options"
      tone="glass"
      icon={<Ellipsis size={18} />}
      triggerTestId="stage-more"
      className="absolute top-2 right-2 z-10"
    >
      {(close) => (
        <>
          <ShellMenuItem
            tone="glass"
            icon={<LayoutTemplate size={16} />}
            label="Safe zones"
            hint="Where Reels, TikTok and Shorts draw their buttons"
            pressed={safeZones}
            data-testid="safe-zones-toggle"
            onClick={() => setEditPref('safeZones', !safeZones)}
          />
          {media && (
            <ShellMenuItem
              tone="glass"
              icon={<CropIcon size={16} />}
              label="Crop"
              data-testid="crop-toggle"
              onClick={() => {
                close()
                onCrop()
              }}
            />
          )}
        </>
      )}
    </ShellMenu>
  )
}

/** Reels UI overlay zones; also shown faintly while moving a clip. */
function SafeZones({ visible }: { visible: boolean }) {
  return (
    <svg
      aria-hidden
      data-testid="safe-zones"
      data-visible={visible || undefined}
      viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-0 hidden size-full group-data-moving/ov:block data-visible:block"
    >
      {SAFE_ZONE_RECTS.map((z) => (
        <g key={z.id}>
          <rect
            x={z.x}
            y={z.y}
            width={z.w}
            height={z.h}
            fill="rgb(255 80 80 / 0.16)"
            stroke="rgb(255 120 120 / 0.8)"
            strokeWidth={3}
            strokeDasharray="14 10"
          />
          <text
            x={z.id === 'rail' ? z.x + z.w / 2 : z.x + 24}
            y={z.y + (z.id === 'top' ? z.h - 24 : 52)}
            fill="rgb(255 255 255 / 0.85)"
            fontSize={34}
            fontWeight={700}
            textAnchor={z.id === 'rail' ? 'middle' : 'start'}
            writingMode={z.id === 'rail' ? 'tb' : undefined}
          >
            {z.label}
          </text>
        </g>
      ))}
    </svg>
  )
}

/**
 * Edits a text clip in place: a textarea over the text block (in the clip's font, at the
 * on-screen size) while the preview hides the rendered text. Enter adds a line; Ctrl/⌘+Enter
 * or clicking away commits ONE undo step; Escape cancels.
 */
function InlineTextEditor({
  clipId,
  scale,
  onDone,
}: {
  clipId: string
  scale: number
  onDone: () => void
}) {
  const s = editorStore.getState()
  const loc = locateClip(s.project, clipId)
  const clip = loc?.clip.type === 'text' ? loc.clip : undefined
  const [value, setValue] = useState(clip?.text ?? '')
  const ref = useRef<HTMLTextAreaElement>(null)
  const done = useRef(false)

  useEffect(() => {
    const base = editorStore.getState().project
    if (base)
      setPreviewOverride(
        produce(base, (d) => {
          for (const t of d.tracks) {
            const c = t.clips.find((x) => x.id === clipId)
            if (c?.type === 'text') c.text = ''
          }
        }),
      )
    ref.current?.focus()
    ref.current?.select()
    return () => setPreviewOverride(null)
  }, [clipId])

  if (!clip) return null
  const finish = (commit: boolean) => {
    if (done.current) return
    done.current = true
    setPreviewOverride(null)
    if (commit && value !== clip.text) {
      editorStore.getState().dispatch('Edit text', (d) => setText(d, clipId, value))
    }
    onDone()
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      finish(false)
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      finish(true)
    }
  }
  const st = clip.style
  const tr = clip.transform
  const size = textBlockSize(clip)
  const k = scale * tr.scale.value
  return (
    <textarea
      ref={ref}
      data-ov-ignore
      data-testid="inline-text-editor"
      aria-label="Edit text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => e.stopPropagation()}
      className="absolute z-20 resize-none overflow-hidden rounded-md bg-black/45 p-0 text-center leading-[1.1] text-white outline-2 outline-accent"
      style={{
        left: tr.x.value * scale,
        top: tr.y.value * scale,
        width: Math.max(80, size.width * k + 16),
        height: Math.max(32, size.height * k + 8),
        transform: `translate(-50%,-50%) rotate(${tr.rotation.value}deg)`,
        fontFamily: st.fontFamily,
        fontWeight: st.fontWeight,
        fontStyle: st.italic ? 'italic' : undefined,
        fontSize: st.fontSize * k,
        lineHeight: st.lineHeight,
        textTransform: st.uppercase ? 'uppercase' : undefined,
        textAlign: st.align,
        color: st.color,
      }}
    />
  )
}
