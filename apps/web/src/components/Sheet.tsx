import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/cn.ts'
import { haptic } from '@/lib/haptics.ts'

export interface SnapInput {
  /** Snap heights in px, ascending. */
  heights: readonly number[]
  /** Current visible height in px (after the drag). */
  current: number
  /** Release velocity in px/ms, positive = moving down (closing). */
  velocity: number
  dismissible: boolean
}

/** Lookahead applied to release velocity, so a flick travels like a physical throw. */
const FLICK_MS = 180

/**
 * Picks the snap point a released sheet should settle on, or -1 to dismiss.
 * Pure so it can be unit-tested without pointer events.
 */
export const resolveSnap = ({ heights, current, velocity, dismissible }: SnapInput): number => {
  const projected = current - velocity * FLICK_MS
  const lowest = heights[0] ?? 0
  if (dismissible && projected < lowest * 0.5) return -1
  let best = 0
  let bestDist = Number.POSITIVE_INFINITY
  heights.forEach((h, i) => {
    const d = Math.abs(h - projected)
    if (d < bestDist) {
      bestDist = d
      best = i
    }
  })
  return best
}

export interface SheetProps {
  open: boolean
  onClose: () => void
  /** Accessible title, shown in the header. */
  title: string
  hideTitle?: boolean
  /** Snap points as fractions of the viewport height, ascending. */
  snapPoints?: readonly number[]
  /** Index into snapPoints to open at. */
  initialSnap?: number
  /** Modal sheets dim and block the page; non-modal ones leave it interactive (editor panels). */
  modal?: boolean
  dismissible?: boolean
  headerAction?: ReactNode
  children: ReactNode
  className?: string
}

const CLOSE_MS = 240
const DEFAULT_SNAPS: readonly number[] = [0.6]

/**
 * Mobile bottom sheet with drag-to-dismiss and snap points. The drag handle and header
 * are the drag surface so scrollable content keeps native scrolling.
 */
export function Sheet({
  open,
  onClose,
  title,
  hideTitle = false,
  snapPoints = DEFAULT_SNAPS,
  initialSnap = 0,
  modal = true,
  dismissible = true,
  headerAction,
  children,
  className,
}: SheetProps) {
  const [mounted, setMounted] = useState(open)
  const [closing, setClosing] = useState(false)
  const [vh, setVh] = useState(() => (typeof window === 'undefined' ? 800 : window.innerHeight))
  const [snap, setSnap] = useState(initialSnap)
  const [dragY, setDragY] = useState<number | null>(null)
  const [entered, setEntered] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const restoreFocus = useRef<HTMLElement | null>(null)
  const drag = useRef<{ startY: number; lastY: number; lastT: number; v: number } | null>(null)

  const heights = snapPoints.map((f) => Math.round(f * vh))
  const maxH = heights.at(-1) ?? vh
  const snapH = heights[Math.min(snap, heights.length - 1)] ?? maxH

  // Mount/unmount with an exit animation. `open` changes are applied during render (React's
  // "adjust state on prop change" pattern) so opening never paints a stale frame.
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      setMounted(true)
      setClosing(false)
      setSnap(initialSnap)
    } else if (mounted) setClosing(true)
  }
  useEffect(() => {
    if (!closing) return
    const t = setTimeout(() => {
      setMounted(false)
      setClosing(false)
      setEntered(false)
    }, CLOSE_MS)
    return () => clearTimeout(t)
  }, [closing])

  // Start off-screen, then transition to the snap height on the next frame.
  useLayoutEffect(() => {
    if (!mounted || entered) return
    const id = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(id)
  }, [mounted, entered])

  useEffect(() => {
    const onResize = () => setVh(window.innerHeight)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Focus management + Escape.
  useEffect(() => {
    if (!open) return
    restoreFocus.current = document.activeElement as HTMLElement | null
    panelRef.current?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissible) {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      restoreFocus.current?.focus?.({ preventScroll: true })
    }
  }, [open, dismissible, onClose])

  if (!mounted) return null

  const visibleH = !entered || closing ? 0 : dragY !== null ? dragY : snapH
  const translate = maxH - visibleH

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { startY: e.clientY, lastY: e.clientY, lastT: e.timeStamp, v: 0 }
    setDragY(snapH)
  }
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d) return
    const dt = Math.max(1, e.timeStamp - d.lastT)
    // Exponential smoothing so one jittery sample doesn't decide the flick.
    d.v = 0.7 * ((e.clientY - d.lastY) / dt) + 0.3 * d.v
    d.lastY = e.clientY
    d.lastT = e.timeStamp
    const raw = snapH - (e.clientY - d.startY)
    // Rubber-band beyond the tallest snap point.
    const h = raw > maxH ? maxH + (raw - maxH) * 0.2 : raw
    setDragY(Math.max(0, h))
  }
  const onPointerUp = () => {
    const d = drag.current
    if (!d || dragY === null) return
    drag.current = null
    const next = resolveSnap({ heights, current: dragY, velocity: d.v, dismissible })
    setDragY(null)
    if (next === -1) {
      haptic(6)
      onClose()
    } else {
      if (next !== snap) haptic(6)
      setSnap(next)
    }
  }

  return createPortal(
    <div className={cn('fixed inset-0 z-50', !modal && 'pointer-events-none')}>
      {modal && (
        <div
          aria-hidden
          className={cn(
            'absolute inset-0 bg-scrim transition-opacity duration-200',
            entered && !closing ? 'opacity-100' : 'opacity-0',
          )}
          onClick={dismissible ? onClose : undefined}
        />
      )}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal={modal}
        aria-label={title}
        tabIndex={-1}
        data-snap={snap}
        className={cn(
          'pointer-events-auto absolute inset-x-0 bottom-0 flex flex-col rounded-t-3xl border-t border-line bg-surface shadow-sheet outline-none',
          dragY === null && 'transition-transform duration-300 ease-[var(--ease-spring)]',
          className,
        )}
        style={{ height: maxH, transform: `translate3d(0, ${translate}px, 0)` }}
      >
        <div
          data-testid="sheet-handle"
          className="shrink-0 cursor-grab touch-none select-none active:cursor-grabbing"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div className="mx-auto mt-2 h-1.5 w-10 rounded-full bg-surface-3" />
          <div className={cn('flex min-h-11 items-center gap-2 px-4', hideTitle && 'sr-only')}>
            <h2 className="flex-1 truncate text-base font-semibold">{title}</h2>
            {headerAction}
          </div>
        </div>
        {/* Content scrolls inside the visible part only. */}
        <div
          className="min-h-0 overflow-y-auto overscroll-contain pb-safe"
          style={{ height: snapH - 56 }}
        >
          {children}
        </div>
      </div>
    </div>,
    document.body,
  )
}
