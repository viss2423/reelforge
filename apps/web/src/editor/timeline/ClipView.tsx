/**
 * One clip on a lane: filmstrip (video/image), waveform (audio, and a strip under videos
 * with sound), label, effect/filter/speed badges and — when selected — trim handles and
 * keyframe diamonds. Pointer input is handled by the gesture controller (geometry hit
 * testing); this component handles keyboard access: focus, Enter/Space select, arrows nudge.
 */
import { formatTimecode, type Clip, type TrackKind } from '@reelforge/core'
import { Droplet, Gauge, Lock, Music, Rewind, Smile, Sparkles, Type, VolumeX } from 'lucide-react'
import {
  memo,
  useCallback,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { api } from '@/api/index.ts'
import { cn } from '@/lib/cn.ts'
import { editorStore, useAsset, useIsSelected } from '@/state/index.ts'
import { nudgeClip } from './commands.ts'
import { HANDLE_WIDTH } from './constants.ts'
import { useTimelineView } from './context.ts'
import { timeToX, type TimeWindow } from './geometry.ts'
import {
  drawWaveform,
  filmstrip,
  sourceAt,
  useThumbsIndex,
  useWaveform,
  type ThumbsIndex,
} from './media.ts'

export interface ClipViewProps {
  clip: Clip
  trackId: string
  trackKind: TrackKind
  locked: boolean
  hidden: boolean
  muted: boolean
  /** Playback span. */
  start: number
  end: number
  ppu: number
  height: number
  win: TimeWindow
}

const TYPE_LABEL: Record<Clip['type'], string> = {
  video: 'Video',
  image: 'Photo',
  audio: 'Audio',
  text: 'Text',
  sticker: 'Sticker',
}

const colorClass = (clip: Clip, kind: TrackKind): string => {
  switch (clip.type) {
    case 'audio':
      return 'bg-emerald-600/75 text-white'
    case 'text':
      return 'bg-amber-400/90 text-black'
    case 'sticker':
      return 'bg-pink-500/75 text-white'
    default:
      return kind === 'main' ? 'bg-violet-600/55 text-white' : 'bg-sky-600/70 text-white'
  }
}

/** Unique keyframe times (clip-relative) across all animated transform properties. */
const keyframeTimes = (clip: Clip): number[] => {
  if (clip.type === 'audio') return []
  const tr = clip.transform
  const set = new Set<number>()
  for (const a of [tr.x, tr.y, tr.scale, tr.rotation, tr.opacity])
    for (const k of a.keyframes) if (k.t >= 0 && k.t <= clip.duration) set.add(k.t)
  return [...set].toSorted((a, b) => a - b)
}

const stop = (e: KeyboardEvent) => {
  e.preventDefault()
  e.stopPropagation()
}

export const ClipView = memo(function ClipView(props: ClipViewProps) {
  const { clip, trackId, trackKind, locked, hidden, muted, start, end, ppu, height, win } = props
  const view = useTimelineView()
  const selected = useIsSelected(clip.id)
  const assetId = 'assetId' in clip ? clip.assetId : undefined
  const asset = useAsset(assetId)

  const left = timeToX(start, ppu)
  const width = Math.max(2, (end - start) * ppu)
  // Visible slice of the clip (clip-local px) — tiles and waveform only cover this.
  const from = Math.max(0, timeToX(win.start, ppu) - left)
  const to = Math.min(width, timeToX(win.end, ppu) - left)

  // Stable per clip so React does not unregister/re-register the element every render.
  const register = useCallback(
    (el: HTMLDivElement) => {
      view.registerClip(clip.id, el)
      return () => view.unregisterClip(clip.id, el)
    },
    [view, clip.id],
  )

  const name =
    clip.name ?? (clip.type === 'text' ? clip.text : asset?.name) ?? TYPE_LABEL[clip.type]
  const label = `${TYPE_LABEL[clip.type]} clip ${name}, ${formatTimecode(start)} to ${formatTimecode(end)}${locked ? ', locked' : ''}`

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (e.altKey || e.ctrlKey || e.metaKey) return
      stop(e)
      const frames = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowLeft' ? -1 : 1)
      if (nudgeClip(editorStore, clip.id, frames))
        editorStore.getState().select([clip.id], { trackId })
    } else if (e.key === 'Enter' || e.key === ' ') {
      stop(e)
      const s = editorStore.getState()
      if (e.shiftKey || e.ctrlKey || e.metaKey) s.toggleSelect(clip.id)
      else s.select([clip.id], { trackId })
    }
  }

  let media: ReactNode
  if (clip.type === 'video' || clip.type === 'image') {
    media = (
      <>
        <Filmstrip
          clip={clip}
          assetId={assetId}
          ready={asset?.thumbnails === 'ready'}
          ppu={ppu}
          width={width}
          height={height}
          from={from}
          to={to}
        />
        {clip.type === 'video' &&
          asset?.hasAudio &&
          !clip.audio.muted &&
          !muted &&
          height >= 40 && (
            <div className="absolute inset-x-0 bottom-0 h-3 bg-black/35">
              <WaveformCanvas
                clip={clip}
                assetId={assetId}
                ready={asset.waveform === 'ready'}
                ppu={ppu}
                height={12}
                from={from}
                to={to}
              />
            </div>
          )}
      </>
    )
  } else if (clip.type === 'audio') {
    media = (
      <WaveformCanvas
        clip={clip}
        assetId={assetId}
        ready={asset?.waveform === 'ready'}
        ppu={ppu}
        height={height}
        from={from}
        to={to}
      />
    )
  }

  return (
    <div
      ref={register}
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-pressed={selected}
      data-testid="timeline-clip"
      data-clip-id={clip.id}
      data-clip-type={clip.type}
      data-selected={selected || undefined}
      onKeyDown={onKeyDown}
      className={cn(
        'absolute top-0 overflow-hidden rounded-md outline-none select-none',
        colorClass(clip, trackKind),
        hidden && 'opacity-40',
        locked && 'saturate-50',
        'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
        'transition-[scale] duration-150',
        'data-dragging:z-20 data-dragging:opacity-90 data-dragging:shadow-pop data-dragging:will-change-transform',
        'data-shifting:transition-transform data-shifting:duration-150 data-shifting:will-change-transform',
        'data-lifted:z-20 data-lifted:scale-[1.04] data-lifted:shadow-pop',
      )}
      style={{ left, width, height }}
    >
      <div data-clip-media className="absolute inset-0 data-slipping:opacity-0">
        {media}
      </div>
      {width > 28 && <ClipLabel clip={clip} name={name} locked={locked} />}
      {selected && (
        <SelectionChrome clip={clip} width={width} ppu={ppu} from={from} to={to} locked={locked} />
      )}
    </div>
  )
})

function ClipLabel({ clip, name, locked }: { clip: Clip; name: string; locked: boolean }) {
  const badges: ReactNode[] = []
  if (locked) badges.push(<Lock key="lock" size={10} aria-label="Locked" />)
  if ((clip.type === 'video' || clip.type === 'audio') && clip.speed !== 1)
    badges.push(
      <span key="speed" className="flex items-center gap-0.5" aria-label={`Speed ${clip.speed}x`}>
        <Gauge size={10} />
        {Number(clip.speed.toFixed(2))}×
      </span>,
    )
  if (clip.type === 'video' && clip.speedRamp.length > 0 && clip.speed === 1)
    badges.push(<Gauge key="ramp" size={10} aria-label="Speed ramp" />)
  if (clip.type === 'video' && clip.reverse)
    badges.push(<Rewind key="rev" size={10} aria-label="Reversed" />)
  if ((clip.type === 'video' || clip.type === 'image') && clip.filter)
    badges.push(<Droplet key="filter" size={10} aria-label="Filter" />)
  if ((clip.type === 'video' || clip.type === 'image') && clip.effects.length > 0)
    badges.push(
      <span
        key="fx"
        className="flex items-center gap-0.5"
        aria-label={`${clip.effects.length} effects`}
      >
        <Sparkles size={10} />
        {clip.effects.length > 1 && clip.effects.length}
      </span>,
    )
  if ((clip.type === 'video' || clip.type === 'audio') && clip.audio.muted)
    badges.push(<VolumeX key="mute" size={10} aria-label="Muted" />)

  const icon =
    clip.type === 'text' ? (
      <Type size={11} className="shrink-0" />
    ) : clip.type === 'sticker' ? (
      <Smile size={11} className="shrink-0" />
    ) : clip.type === 'audio' ? (
      <Music size={11} className="shrink-0" />
    ) : null
  const onMedia = clip.type === 'video' || clip.type === 'image'
  return (
    <div className="pointer-events-none absolute inset-x-1 top-0.5 flex min-w-0 items-center gap-1 text-[10px] leading-4 font-semibold">
      {(icon || onMedia) && (
        <span
          className={cn(
            'flex min-w-0 items-center gap-1 truncate rounded px-1',
            onMedia && 'bg-black/45 text-white',
          )}
        >
          {icon}
          <span className="truncate">{name}</span>
        </span>
      )}
      {!icon && !onMedia && <span className="truncate">{name}</span>}
      {badges.length > 0 && (
        <span className="ml-auto flex shrink-0 items-center gap-1 rounded bg-black/45 px-1 text-white">
          {badges}
        </span>
      )}
    </div>
  )
}

/** Selection outline, trim handles and keyframe diamonds. */
function SelectionChrome({
  clip,
  width,
  ppu,
  from,
  to,
  locked,
}: {
  clip: Clip
  width: number
  ppu: number
  from: number
  to: number
  locked: boolean
}) {
  const kfs = keyframeTimes(clip)
  return (
    <>
      <div className="pointer-events-none absolute inset-0 rounded-md ring-2 ring-white ring-inset" />
      {!locked && width >= HANDLE_WIDTH * 2 && (
        <>
          <div
            data-handle="start"
            className="pointer-events-none absolute inset-y-0 left-0 flex items-center justify-center rounded-l-md bg-white"
            style={{ width: HANDLE_WIDTH }}
          >
            <span className="h-1/3 w-0.5 rounded bg-black/50" />
          </div>
          <div
            data-handle="end"
            className="pointer-events-none absolute inset-y-0 right-0 flex items-center justify-center rounded-r-md bg-white"
            style={{ width: HANDLE_WIDTH }}
          >
            <span className="h-1/3 w-0.5 rounded bg-black/50" />
          </div>
        </>
      )}
      {kfs.map((t) => {
        const x = t * ppu
        if (x < from - 6 || x > to + 6) return null
        return (
          <span
            key={t}
            data-keyframe={t}
            aria-hidden
            className="pointer-events-none absolute bottom-1 size-2 rotate-45 border border-black/60 bg-white"
            style={{ left: Math.min(Math.max(x, 4), width - 4) - 4 }}
          />
        )
      })}
    </>
  )
}

/** Filmstrip: one absolutely positioned sprite tile per visible slot. */
function Filmstrip(props: {
  clip: Clip
  assetId: string | undefined
  ready: boolean
  ppu: number
  width: number
  height: number
  from: number
  to: number
}) {
  const index = useThumbsIndex(props.assetId, props.ready)
  if (!index || !props.assetId) return null
  return <Tiles index={index} {...props} assetId={props.assetId} />
}

function Tiles({
  index,
  clip,
  assetId,
  ppu,
  width,
  height,
  from,
  to,
}: {
  index: ThumbsIndex
  clip: Clip
  assetId: string
  ppu: number
  width: number
  height: number
  from: number
  to: number
}) {
  const strip = filmstrip(index, clip, ppu, width, height, from, to)
  const image = `url("${api.thumbsUrl(assetId)}")`
  const size = `${strip.bgWidth}px ${strip.bgHeight}px`
  return (
    <>
      {strip.slots.map((s) => (
        <div
          key={s.x}
          className="absolute top-0 bg-no-repeat"
          style={{
            left: s.x,
            width: strip.slotWidth,
            height,
            backgroundImage: image,
            backgroundSize: size,
            backgroundPosition: `${s.bgX}px ${s.bgY}px`,
          }}
        />
      ))}
    </>
  )
}

/**
 * Peak waveform on a canvas covering only the visible slice of the clip, sized for the
 * device pixel ratio (≤ 2) and redrawn only when zoom, slice or source mapping change.
 */
function WaveformCanvas({
  clip,
  assetId,
  ready,
  ppu,
  height,
  from,
  to,
}: {
  clip: Clip
  assetId: string | undefined
  ready: boolean
  ppu: number
  height: number
  from: number
  to: number
}) {
  const wave = useWaveform(assetId, ready)
  const ref = useRef<HTMLCanvasElement>(null)
  const w = Math.max(0, Math.ceil(to - from))
  const reverse = clip.type === 'video' && clip.reverse
  const speed = clip.type === 'video' || clip.type === 'audio' ? clip.speed : 1
  const srcStart = sourceAt(clip, from / ppu)
  useLayoutEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx || !wave || w === 0) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const cw = Math.round(w * dpr)
    const ch = Math.round(height * dpr)
    if (canvas.width !== cw) canvas.width = cw
    if (canvas.height !== ch) canvas.height = ch
    drawWaveform(ctx, wave, {
      width: w,
      height,
      dpr,
      sourceStart: srcStart,
      usPerPx: (reverse ? -speed : speed) / ppu,
      color: 'rgba(255,255,255,0.8)',
    })
  }, [wave, w, height, srcStart, speed, reverse, ppu])
  if (!wave || w === 0) return null
  return (
    <canvas
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute top-0"
      style={{ left: from, width: w, height }}
    />
  )
}
