import { formatTimecode } from '@reelforge/core'
import {
  ChevronFirst,
  ChevronLast,
  Maximize,
  Minimize,
  Pause,
  Play,
  Redo2,
  StepBack,
  StepForward,
  Undo2,
} from 'lucide-react'
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/cn.ts'
import { useIsDesktop } from '@/lib/useMediaQuery.ts'
import { editorStore } from '@/state/editorStore.ts'
import {
  timelineEnd,
  useDuration,
  useHistoryFlags,
  usePlayhead,
  usePlaying,
} from '@/state/selectors.ts'
import { stepFrames } from '../actions.ts'

/** Hold on Play this long to reveal frame stepping. */
const LONG_PRESS_MS = 450
/** The frame stepper hides itself after this long without use. */
const STEPPER_IDLE_MS = 4000

/** "0:02 / 0:11". Isolated so 60 fps playhead updates re-render only this. */
function Timecode() {
  const t = usePlayhead()
  const total = useDuration()
  return (
    <span
      className="font-mono text-xs whitespace-nowrap text-muted tabular-nums"
      data-testid="timecode"
    >
      <span className="text-fg">{formatTimecode(t, false)}</span>
      <span className="text-subtle"> / </span>
      {formatTimecode(total, false)}
    </span>
  )
}

/** Quiet icon-only button (44 px target): muted until hovered. */
function Quiet({
  label,
  icon,
  className,
  ...rest
}: { label: string; icon: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'grid size-11 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent',
        className,
      )}
      {...rest}
    >
      {icon}
    </button>
  )
}

/** Undo / redo: small ghost icons at the left of the transport. */
function History() {
  const history = useHistoryFlags()
  const s = editorStore.getState
  return (
    <>
      <Quiet
        label={history.undoLabel ? `Undo ${history.undoLabel}` : 'Undo'}
        icon={<Undo2 size={19} />}
        disabled={!history.canUndo}
        onClick={() => s().undo()}
      />
      <Quiet
        label={history.redoLabel ? `Redo ${history.redoLabel}` : 'Redo'}
        icon={<Redo2 size={19} />}
        disabled={!history.canRedo}
        onClick={() => s().redo()}
      />
    </>
  )
}

/**
 * The big play button. A long press (or right click) reveals the frame-step buttons; the
 * press that reveals them does not also toggle playback.
 */
function PlayButton({ onHold }: { onHold: () => void }) {
  const playing = usePlaying()
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const held = useRef(false)
  const cancel = () => clearTimeout(timer.current)
  useEffect(() => () => clearTimeout(timer.current), [])
  const hold = () => {
    held.current = true
    onHold()
  }
  return (
    <button
      type="button"
      aria-label={playing ? 'Pause' : 'Play'}
      title={playing ? 'Pause (Space)' : 'Play (Space) · hold for frame step'}
      data-testid="play-toggle"
      onPointerDown={(e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return
        held.current = false
        cancel()
        timer.current = setTimeout(hold, LONG_PRESS_MS)
      }}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onContextMenu={(e) => {
        e.preventDefault()
        cancel()
        hold()
      }}
      onClick={() => {
        if (held.current) {
          held.current = false
          return
        }
        editorStore.getState().togglePlaying()
      }}
      className="grid size-12 shrink-0 place-items-center rounded-full bg-fg text-canvas shadow-pop transition-transform duration-150 ease-[var(--ease-spring)] select-none [-webkit-touch-callout:none] hover:scale-105 active:scale-95"
    >
      {playing ? (
        <Pause size={22} fill="currentColor" />
      ) : (
        <Play size={22} fill="currentColor" className="translate-x-px" />
      )}
    </button>
  )
}

export interface TransportProps {
  fullscreen: boolean
  onToggleFullscreen: () => void
  /** Extra controls on the left, after undo/redo. */
  leading?: ReactNode
  /** Extra controls on the right. */
  trailing?: ReactNode
  className?: string
}

/**
 * Undo · redo on the left, a big centred play button with "0:02 / 0:11" beside it, and
 * full screen on the right. On phones frame stepping is behind a long press on play (and the
 * arrow keys); it floats beside play for a few seconds. Desktop keeps quiet start / step /
 * end buttons around play.
 */
export function Transport({
  fullscreen,
  onToggleFullscreen,
  leading,
  trailing,
  className,
}: TransportProps) {
  const s = editorStore.getState
  const desktop = useIsDesktop()
  const [stepper, setStepper] = useState(false)
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const showStepper = () => {
    setStepper(true)
    clearTimeout(idle.current)
    idle.current = setTimeout(() => setStepper(false), STEPPER_IDLE_MS)
  }
  useEffect(() => () => clearTimeout(idle.current), [])
  const step = (n: number) => {
    stepFrames(editorStore, n)
    if (!desktop) showStepper()
  }
  const prev = (cls?: string) => (
    <Quiet
      label="Previous frame"
      icon={<StepBack size={18} />}
      className={cls}
      onClick={() => step(-1)}
    />
  )
  const next = (cls?: string) => (
    <Quiet
      label="Next frame"
      icon={<StepForward size={18} />}
      className={cls}
      onClick={() => step(1)}
    />
  )
  // Phones: while revealed, the stepper takes undo/redo's place (the timecode stays in view).
  const phoneStepper = !desktop && stepper
  const pop = 'shell-pop bg-surface-2 text-fg'
  return (
    <div className={cn('flex h-16 shrink-0 items-center gap-1 px-2', className)}>
      <div className="flex min-w-0 flex-1 items-center gap-1">
        {phoneStepper ? (
          <>
            {prev(pop)}
            {next(pop)}
          </>
        ) : (
          !fullscreen && <History />
        )}
        {leading}
      </div>
      <div className="flex items-center gap-0.5">
        {desktop && (
          <Quiet
            label="Go to start"
            icon={<ChevronFirst size={18} />}
            onClick={() => s().setPlayhead(0)}
          />
        )}
        {desktop && prev()}
        <PlayButton onHold={showStepper} />
        {desktop && next()}
        {desktop && (
          <Quiet
            label="Go to end"
            icon={<ChevronLast size={18} />}
            onClick={() => s().setPlayhead(timelineEnd(s().project))}
          />
        )}
      </div>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-1">
        <span className="mr-auto min-w-0 overflow-hidden pl-2">
          <Timecode />
        </span>
        {trailing}
        <Quiet
          label={fullscreen ? 'Exit full screen' : 'Full screen'}
          icon={fullscreen ? <Minimize size={19} /> : <Maximize size={19} />}
          onClick={onToggleFullscreen}
        />
      </div>
    </div>
  )
}
