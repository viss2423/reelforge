import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { cn } from '@/lib/cn.ts'
import { haptic } from '@/lib/haptics.ts'

/* ------------------------------------------------------------------ pure helpers (tested) */

const decimals = (step: number): number => {
  const s = String(step)
  const i = s.indexOf('.')
  return i === -1 ? 0 : s.length - i - 1
}

/** Clamp to [min,max] and round to the step grid anchored at `min` (float-safe). */
export const quantize = (v: number, min: number, max: number, step: number): number => {
  if (!Number.isFinite(v)) return min
  const q = Math.round((v - min) / step) * step + min
  return Number(Math.min(max, Math.max(min, q)).toFixed(decimals(step)))
}

/**
 * Fine-scrubbing factor: dragging the finger away from the track (vertically) slows the
 * slider down, so tiny adjustments are possible on a phone (same idea as iOS scrubbing).
 */
export const precisionScale = (verticalDistancePx: number): number => {
  const d = Math.max(0, Math.abs(verticalDistancePx) - 24)
  return 1 / (1 + d / 48)
}

/** Magnetic detent: snap to the default when within 1.5 % of the range. */
export const applyDetent = (
  v: number,
  def: number | undefined,
  min: number,
  max: number,
): number => (def !== undefined && Math.abs(v - def) <= (max - min) * 0.015 ? def : v)

/* ------------------------------------------------------------------ component */

export interface SliderProps {
  value: number
  min: number
  max: number
  step?: number
  /** Value restored by double-tap / double-click; also the magnetic detent. */
  defaultValue?: number
  label: string
  /** Live updates while dragging. */
  onChange: (value: number) => void
  /** Gesture began (pointer down, key press, numeric entry) — e.g. begin a transaction. */
  onChangeStart?: () => void
  /** Gesture finished — e.g. commit the transaction. */
  onChangeEnd?: (value: number) => void
  format?: (value: number) => string
  /** Unit suffix shown after the value. */
  unit?: string
  disabled?: boolean
  showValue?: boolean
  className?: string
}

const DOUBLE_TAP_MS = 300

/**
 * Touch-first slider: relative drag with fine-scrub precision, double-tap reset, a numeric
 * entry field (tap the value), full keyboard support and light haptics at detents/limits.
 */
export function Slider({
  value,
  min,
  max,
  step = 1,
  defaultValue,
  label,
  onChange,
  onChangeStart,
  onChangeEnd,
  format,
  unit = '',
  disabled = false,
  showValue = true,
  className,
}: SliderProps) {
  const id = useId()
  const trackRef = useRef<HTMLDivElement>(null)
  /** Active drag: last pointer x/y, unquantized value and the last value emitted. */
  const drag = useRef<{ x: number; y: number; v: number; last: number; width: number } | null>(null)
  const lastTap = useRef(0)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const range = max - min || 1
  const pct = ((Math.min(max, Math.max(min, value)) - min) / range) * 100
  const bipolar = min < 0 && max > 0
  const zeroPct = ((0 - min) / range) * 100
  const display = format ? format(value) : `${quantize(value, min, max, step)}${unit}`

  const emit = (v: number, prev: number) => {
    if (v === prev) return
    if ((v === min || v === max) && prev !== v) haptic(8)
    else if (defaultValue !== undefined && v === defaultValue) haptic(10)
    onChange(v)
  }

  const oneShot = (v: number) => {
    const next = quantize(v, min, max, step)
    onChangeStart?.()
    emit(next, value)
    onChangeEnd?.(next)
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return
    const now = e.timeStamp
    if (defaultValue !== undefined && now - lastTap.current < DOUBLE_TAP_MS) {
      lastTap.current = 0
      oneShot(defaultValue)
      return
    }
    lastTap.current = now
    const rect = trackRef.current?.getBoundingClientRect()
    const width = rect?.width || 1
    e.currentTarget.setPointerCapture(e.pointerId)
    onChangeStart?.()
    // Tapping the track jumps there (unless the thumb itself was grabbed).
    let start = value
    if (rect && !(e.target as HTMLElement).dataset.thumb) {
      start = quantize(min + ((e.clientX - rect.left) / width) * range, min, max, step)
      emit(start, value)
    }
    drag.current = { x: e.clientX, y: e.clientY, v: start, last: start, width }
  }

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    const scale = precisionScale(e.clientY - d.y)
    // Re-anchor on each move so changing the precision mid-drag doesn't jump.
    const raw = d.v + ((e.clientX - d.x) / d.width) * range * scale
    d.x = e.clientX
    d.v = Math.min(max, Math.max(min, raw))
    const next = quantize(applyDetent(d.v, defaultValue, min, max), min, max, step)
    emit(next, d.last)
    d.last = next
  }

  const onPointerUp = () => {
    const d = drag.current
    if (!d) return
    drag.current = null
    // The last emitted value, not the prop: the parent may not have re-rendered yet.
    onChangeEnd?.(d.last)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (disabled) return
    const big = step * 10
    let next: number | undefined
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        next = value + (e.shiftKey ? big : step)
        break
      case 'ArrowLeft':
      case 'ArrowDown':
        next = value - (e.shiftKey ? big : step)
        break
      case 'PageUp':
        next = value + big
        break
      case 'PageDown':
        next = value - big
        break
      case 'Home':
        next = min
        break
      case 'End':
        next = max
        break
      default:
        return
    }
    e.preventDefault()
    oneShot(next)
  }

  const commitDraft = () => {
    setEditing(false)
    const n = Number.parseFloat(draft.replace(',', '.'))
    if (Number.isFinite(n)) oneShot(n)
  }

  return (
    <div className={cn('flex flex-col gap-1.5', disabled && 'opacity-50', className)}>
      <div className="flex items-center justify-between gap-2">
        <span id={`${id}-label`} className="text-sm text-muted">
          {label}
        </span>
        {showValue &&
          (editing ? (
            <input
              autoFocus
              aria-label={`${label} value`}
              inputMode="decimal"
              className="w-20 rounded-md border border-line bg-surface-2 px-2 py-0.5 text-right text-sm tabular-nums outline-none focus:border-accent"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitDraft}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitDraft()
                else if (e.key === 'Escape') setEditing(false)
              }}
            />
          ) : (
            <button
              type="button"
              disabled={disabled}
              aria-label={`Edit ${label} value`}
              className="min-h-7 rounded-md px-1.5 text-sm font-semibold tabular-nums hover:bg-surface-2"
              onClick={() => {
                setDraft(String(quantize(value, min, max, step)))
                setEditing(true)
              }}
            >
              {display}
            </button>
          ))}
      </div>
      <div
        className={cn(
          'relative flex h-11 touch-none items-center select-none',
          !disabled && 'cursor-pointer',
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div ref={trackRef} className="relative h-1.5 w-full rounded-full bg-surface-3">
          <div
            className="absolute inset-y-0 rounded-full bg-accent"
            style={
              bipolar
                ? { left: `${Math.min(pct, zeroPct)}%`, width: `${Math.abs(pct - zeroPct)}%` }
                : { left: 0, width: `${pct}%` }
            }
          />
          {defaultValue !== undefined && defaultValue !== min && (
            <div
              aria-hidden
              className="absolute top-1/2 h-3 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded bg-subtle"
              style={{ left: `${((defaultValue - min) / range) * 100}%` }}
            />
          )}
        </div>
        <div
          id={id}
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-labelledby={`${id}-label`}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          aria-valuetext={display}
          aria-disabled={disabled || undefined}
          data-thumb="1"
          onKeyDown={onKeyDown}
          className="absolute top-1/2 size-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent bg-white shadow-md outline-none focus-visible:ring-4 focus-visible:ring-accent/40"
          style={{ left: `${pct}%` }}
        />
      </div>
    </div>
  )
}
