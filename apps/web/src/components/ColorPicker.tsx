import { useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { cn } from '@/lib/cn.ts'
import { hexToRgba, hsvToHex, normalizeHex, rgbToHsv, type Hsv } from '@/lib/color.ts'

/** Swatches tuned for short-form video text & captions (high contrast, trending accents). */
export const DEFAULT_SWATCHES = [
  '#FFFFFF',
  '#000000',
  '#FFE400',
  '#FF2D7A',
  '#00E5FF',
  '#39FF14',
  '#FF6B00',
  '#8B5CF6',
  '#FF3B30',
  '#34C759',
  '#007AFF',
  '#F5E6C8',
] as const

const RECENT_KEY = 'rf.recentColors'
const RECENT_MAX = 12

export const readRecentColors = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown
    return Array.isArray(v)
      ? v.filter((c): c is string => typeof c === 'string').slice(0, RECENT_MAX)
      : []
  } catch {
    return []
  }
}

export const pushRecentColor = (hex: string): string[] => {
  const next = [hex, ...readRecentColors().filter((c) => c !== hex)].slice(0, RECENT_MAX)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // Non-essential.
  }
  return next
}

export interface ColorPickerProps {
  value: string
  onChange: (hex: string) => void
  onChangeStart?: () => void
  onChangeEnd?: (hex: string) => void
  /** Show an opacity bar (emits 8-digit hex when < 100 %). */
  alpha?: boolean
  label: string
  swatches?: readonly string[]
  className?: string
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

/** Pointer-drag helper for the 2D/1D colour areas. */
function DragArea({
  className,
  style,
  label,
  onPos,
  onStart,
  onEnd,
  children,
}: {
  className: string
  style?: React.CSSProperties
  label: string
  onPos: (x: number, y: number) => void
  onStart: () => void
  onEnd: () => void
  children: ReactNode
}) {
  const active = useRef(false)
  const pos = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    onPos(
      clamp01((e.clientX - r.left) / (r.width || 1)),
      clamp01((e.clientY - r.top) / (r.height || 1)),
    )
  }
  return (
    <div
      aria-label={label}
      className={cn('relative touch-none select-none', className)}
      style={style}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        active.current = true
        onStart()
        pos(e)
      }}
      onPointerMove={(e) => active.current && pos(e)}
      onPointerUp={() => {
        if (!active.current) return
        active.current = false
        onEnd()
      }}
      onPointerCancel={() => {
        if (!active.current) return
        active.current = false
        onEnd()
      }}
    >
      {children}
    </div>
  )
}

/** Swatches + recent colours, HSV area, hue/opacity bars and a hex field. */
export function ColorPicker({
  value,
  onChange,
  onChangeStart,
  onChangeEnd,
  alpha = false,
  label,
  swatches = DEFAULT_SWATCHES,
  className,
}: ColorPickerProps) {
  const rgba = hexToRgba(value)
  // Keep HSV locally: converting through hex loses hue for greys/black, which would make
  // the hue bar jump while dragging the saturation/value area.
  const [hsv, setHsv] = useState<Hsv>(() => rgbToHsv(rgba))
  const [a, setA] = useState(rgba.a)
  const [lastHex, setLastHex] = useState(value)
  const [hexDraft, setHexDraft] = useState<string | null>(null)
  const [recent, setRecent] = useState(readRecentColors)
  const latest = useRef(value)

  // Adopt external value changes (undo, another device) without fighting local drags.
  if (value !== lastHex) {
    setLastHex(value)
    const next = hexToRgba(value)
    setHsv(rgbToHsv(next))
    setA(next.a)
  }

  const emit = (h: Hsv, al: number) => {
    const hex = hsvToHex(h, alpha ? al : 1)
    setHsv(h)
    setA(al)
    setLastHex(hex)
    latest.current = hex
    if (hex !== value) onChange(hex)
  }
  const end = () => {
    setRecent(pushRecentColor(latest.current))
    onChangeEnd?.(latest.current)
  }
  const start = () => {
    latest.current = value
    onChangeStart?.()
  }
  const pick = (hex: string) => {
    const n = normalizeHex(hex)
    if (!n) return
    start()
    const c = hexToRgba(n)
    emit(rgbToHsv(c), alpha ? c.a : 1)
    end()
  }
  const commitHex = () => {
    if (hexDraft !== null) pick(hexDraft)
    setHexDraft(null)
  }

  const pure = hsvToHex({ h: hsv.h, s: 1, v: 1 })
  const opaque = hsvToHex(hsv)
  const swatch = (c: string) => (
    <button
      key={c}
      type="button"
      aria-label={`Use colour ${c}`}
      aria-pressed={c === value}
      onClick={() => pick(c)}
      className={cn(
        'size-8 shrink-0 rounded-full border border-line',
        c === value && 'ring-2 ring-accent ring-offset-2 ring-offset-surface',
      )}
      style={{ background: c }}
    />
  )

  return (
    <div role="group" aria-label={label} className={cn('flex flex-col gap-3', className)}>
      <div className="flex flex-wrap gap-2">{swatches.map(swatch)}</div>
      {recent.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs text-subtle">Recent</p>
          <div className="flex gap-2 overflow-x-auto" data-testid="recent-colors">
            {recent.map(swatch)}
          </div>
        </div>
      )}
      <DragArea
        label="Saturation and brightness"
        className="h-40 cursor-crosshair overflow-hidden rounded-xl"
        style={{
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${pure})`,
        }}
        onStart={start}
        onEnd={end}
        onPos={(x, y) => emit({ h: hsv.h, s: x, v: 1 - y }, a)}
      >
        <span
          className="pointer-events-none absolute size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: opaque }}
        />
      </DragArea>
      <DragArea
        label="Hue"
        className="h-6 cursor-pointer rounded-full"
        style={{
          background: 'linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)',
        }}
        onStart={start}
        onEnd={end}
        onPos={(x) => emit({ ...hsv, h: x * 360 }, a)}
      >
        <span
          className="pointer-events-none absolute top-1/2 size-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
          style={{ left: `${(hsv.h / 360) * 100}%`, background: pure }}
        />
      </DragArea>
      {alpha && (
        <DragArea
          label="Opacity"
          className="h-6 cursor-pointer rounded-full"
          style={{
            background: `linear-gradient(to right, transparent, ${opaque}), repeating-conic-gradient(#888 0 25%, #ccc 0 50%) 0 0 / 12px 12px`,
          }}
          onStart={start}
          onEnd={end}
          onPos={(x) => emit(hsv, Math.round(x * 100) / 100)}
        >
          <span
            className="pointer-events-none absolute top-1/2 size-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
            style={{ left: `${a * 100}%` }}
          />
        </DragArea>
      )}
      <div className="flex items-center gap-2">
        <span
          className="size-9 shrink-0 rounded-lg border border-line"
          style={{ background: value }}
        />
        <input
          aria-label="Hex colour"
          spellCheck={false}
          autoCapitalize="characters"
          className={cn(
            'h-10 min-w-0 flex-1 rounded-lg border bg-surface-2 px-3 font-mono text-sm uppercase outline-none',
            hexDraft !== null && !normalizeHex(hexDraft)
              ? 'border-danger'
              : 'border-line focus:border-accent',
          )}
          value={hexDraft ?? value}
          onChange={(e) => setHexDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={commitHex}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitHex()
            if (e.key === 'Escape') setHexDraft(null)
          }}
        />
      </div>
    </div>
  )
}
