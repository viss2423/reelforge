/**
 * Small layout pieces shared by every panel and the inspector, so sheets (phones) and
 * inspector sections (desktop) look and behave the same.
 */
import { Check, ChevronDown, Diamond } from 'lucide-react'
import {
  createContext,
  useContext,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { api } from '@/api/index.ts'
import { ColorPicker, DEFAULT_SWATCHES, type ColorPickerProps } from '@/components/ColorPicker.tsx'
import { Slider, type SliderProps } from '@/components/Slider.tsx'
import { nextIndex } from '@/components/Tabs.tsx'
import { cn } from '@/lib/cn.ts'
import { haptic } from '@/lib/haptics.ts'
import type { GestureHandlers } from './model/commands.ts'

/** Titled group of controls. Collapsible sections remember their state per title. */
const openState = new Map<string, boolean>()

/**
 * Lets a container make every section inside it collapsible (the desktop inspector stacks
 * many sections; sheets show one tool and keep them open).
 */
export const SectionsCollapsible = createContext(false)

/**
 * Title of the sheet (or inspector panel) a section renders in: a section titled the same
 * keeps its accessible name but drops the repeated visible heading.
 */
export const PanelTitle = createContext<string | undefined>(undefined)

export function Section({
  title,
  children,
  action,
  collapsible,
  defaultOpen = true,
  className,
}: {
  title: string
  children: ReactNode
  action?: ReactNode
  collapsible?: boolean
  defaultOpen?: boolean
  className?: string
}) {
  const inherited = useContext(SectionsCollapsible)
  const canCollapse = collapsible ?? inherited
  const [open, setOpen] = useState(() => openState.get(title) ?? defaultOpen)
  const panelTitle = useContext(PanelTitle)
  const repeated = !canCollapse && panelTitle?.toLowerCase() === title.toLowerCase()
  const toggle = () => {
    openState.set(title, !open)
    setOpen(!open)
  }
  return (
    <section className={cn('flex flex-col gap-2.5', className)} aria-label={title}>
      <header
        className={cn(
          'flex items-center gap-2',
          repeated ? (action ? '-mb-2 min-h-8 justify-end' : 'sr-only') : 'min-h-7 justify-between',
        )}
      >
        {canCollapse ? (
          <button
            type="button"
            className="flex min-h-8 flex-1 items-center gap-1.5 text-left text-[13px] font-semibold tracking-wide text-muted uppercase"
            aria-expanded={open}
            onClick={toggle}
          >
            <ChevronDown size={14} className={cn('transition-transform', !open && '-rotate-90')} />
            {title}
          </button>
        ) : (
          <h3
            className={cn(
              'text-[13px] font-semibold tracking-wide text-muted uppercase',
              repeated && 'sr-only',
            )}
          >
            {title}
          </h3>
        )}
        {action}
      </header>
      {(!canCollapse || open) && children}
    </section>
  )
}

/** Scrollable padded body of a panel. */
export function PanelBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-col gap-5 p-4 pb-6', className)}>{children}</div>
}

/** Accessible on/off switch with a 44 px row. */
export function Toggle({
  label,
  checked,
  onChange,
  description,
  disabled,
}: {
  label: string
  checked: boolean
  onChange: (on: boolean) => void
  description?: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => {
        haptic(5)
        onChange(!checked)
      }}
      className="flex min-h-11 w-full items-center justify-between gap-3 text-left disabled:opacity-50"
    >
      <span className="flex flex-col">
        <span className="text-[15px]">{label}</span>
        {description && <span className="text-xs text-muted">{description}</span>}
      </span>
      <span
        aria-hidden
        className={cn(
          'relative h-7 w-12 shrink-0 rounded-full transition-colors',
          checked ? 'bg-accent' : 'bg-surface-3',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 size-6 rounded-full bg-white shadow transition-transform',
            checked ? 'translate-x-5.5' : 'translate-x-0.5',
          )}
        />
      </span>
    </button>
  )
}

/** Diamond toggle for a keyframe at the playhead. */
export function KeyframeButton({
  label,
  active,
  animated,
  onToggle,
  disabled,
}: {
  label: string
  /** A keyframe sits at the playhead. */
  active: boolean
  /** The property has keyframes somewhere. */
  animated: boolean
  onToggle: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={`${active ? 'Remove' : 'Add'} ${label} keyframe`}
      aria-pressed={active}
      title={`${active ? 'Remove' : 'Add'} keyframe`}
      disabled={disabled}
      onClick={() => {
        haptic(6)
        onToggle()
      }}
      className={cn(
        'grid size-9 shrink-0 place-items-center rounded-lg hover:bg-surface-2 disabled:opacity-40',
        active ? 'text-accent' : animated ? 'text-fg' : 'text-subtle',
      )}
    >
      <Diamond size={16} fill={active ? 'currentColor' : 'none'} />
    </button>
  )
}

/** Thumbnail image from a pack (lazy, async decode, fixed box → no layout shift). */
export function PackThumb({ path, alt = '' }: { path: string; alt?: string }) {
  return (
    <img
      src={api.packFileUrl(path)}
      alt={alt}
      loading="lazy"
      decoding="async"
      draggable={false}
      className="absolute inset-0 size-full object-cover"
    />
  )
}

/** Selectable gallery tile: a square preview with a caption underneath. */
export function Tile({
  label,
  selected = false,
  onClick,
  children,
  badge,
  aspect = 'square',
  testId,
}: {
  label: string
  selected?: boolean
  onClick: () => void
  children?: ReactNode
  badge?: ReactNode
  aspect?: 'square' | 'portrait' | 'wide'
  testId?: string
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={label}
      data-testid={testId}
      onClick={() => {
        haptic(5)
        onClick()
      }}
      className="group flex min-w-0 flex-col gap-1 text-left"
    >
      <span
        className={cn(
          'relative grid w-full place-items-center overflow-hidden rounded-xl bg-surface-2 ring-2 transition-shadow',
          aspect === 'square' && 'aspect-square',
          aspect === 'portrait' && 'aspect-[9/16]',
          aspect === 'wide' && 'aspect-[16/10]',
          selected ? 'ring-accent' : 'ring-transparent group-hover:ring-line',
        )}
      >
        {children}
        {selected && (
          <span className="absolute top-1 right-1 grid size-5 place-items-center rounded-full bg-accent text-accent-fg">
            <Check size={12} strokeWidth={3} />
          </span>
        )}
        {badge}
      </span>
      <span className={cn('truncate text-xs', selected ? 'font-semibold text-fg' : 'text-muted')}>
        {label}
      </span>
    </button>
  )
}

/** Responsive grid for tiles (3 columns on phones, more when wider). */
export function Gallery({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div
      role="group"
      aria-label={label}
      className="grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-3"
    >
      {children}
    </div>
  )
}

/** Slider for a microsecond value, shown and stepped in seconds. */
export function SecondsSlider({
  label,
  value,
  min = 0,
  max,
  step = 0.05,
  defaultValue,
  handlers,
  disabled,
}: {
  label: string
  /** µs */
  value: number
  /** µs */
  min?: number
  /** µs */
  max: number
  /** seconds */
  step?: number
  /** µs */
  defaultValue?: number
  handlers: GestureHandlers<number>
  disabled?: boolean
}) {
  const toS = (us: number) => us / 1_000_000
  return (
    <Slider
      label={label}
      value={toS(value)}
      min={toS(min)}
      max={Math.max(toS(min) + step, toS(max))}
      step={step}
      {...(defaultValue !== undefined ? { defaultValue: toS(defaultValue) } : {})}
      format={(v) => `${v.toFixed(2)} s`}
      disabled={disabled}
      onChangeStart={handlers.onChangeStart}
      onChange={(s) => handlers.onChange(Math.round(s * 1_000_000))}
      onChangeEnd={handlers.onChangeEnd}
    />
  )
}

/** Empty / guidance message inside a panel. */
export function Hint({ children }: { children: ReactNode }) {
  return <p className="rounded-xl bg-surface-2 px-3 py-2.5 text-sm text-muted">{children}</p>
}

/** Horizontal chip list (single choice). */
export function Chips<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly { value: T; label: string }[]
  value: T | undefined
  onChange: (v: T) => void
  label: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => {
            haptic(5)
            onChange(o.value)
          }}
          className={cn(
            'h-9 shrink-0 rounded-full border px-3.5 text-sm font-semibold whitespace-nowrap',
            o.value === value
              ? 'border-accent bg-accent text-accent-fg'
              : 'border-line bg-surface-2 text-fg hover:bg-surface-3',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ progressive disclosure */

/**
 * "Advanced" disclosure: the controls most people never touch stay one tap away. Remembers
 * its state per `id` for the session (like collapsible sections).
 */
export function Advanced({
  children,
  label = 'Advanced',
  id,
  defaultOpen = false,
  className,
}: {
  children: ReactNode
  label?: string
  /** Key for remembering the open state (defaults to the label). */
  id?: string
  defaultOpen?: boolean
  className?: string
}) {
  const key = `adv:${id ?? label}`
  const [open, setOpen] = useState(() => openState.get(key) ?? defaultOpen)
  const body = useId()
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={body}
        onClick={() => {
          openState.set(key, !open)
          setOpen(!open)
        }}
        className="-mx-2 flex min-h-11 items-center gap-1.5 self-start rounded-xl px-2 text-sm font-semibold text-muted hover:text-fg"
      >
        <ChevronDown
          size={16}
          className={cn('transition-transform duration-200', !open && '-rotate-90')}
        />
        {label}
      </button>
      {open && (
        <div id={body} className="panels-enter flex flex-col gap-4">
          {children}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ visual choices */

export interface ChoiceOption<T extends string> {
  value: T
  label: string
  icon: ReactNode
  /** Optional second line (e.g. a size estimate). */
  meta?: ReactNode
  disabled?: boolean
}

/**
 * Single-choice icon tiles (role="radiogroup"): a visual alternative to a text segmented
 * control. Arrow keys move the choice like any radio group.
 */
export function ChoiceTiles<T extends string>({
  options,
  value,
  onChange,
  label,
  columns,
  size = 'md',
  className,
}: {
  options: readonly ChoiceOption<T>[]
  value: T
  onChange: (v: T) => void
  label: string
  /** Defaults to one column per option. */
  columns?: number
  size?: 'sm' | 'md'
  className?: string
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const pick = (v: T) => {
    if (v === value) return
    haptic(5)
    onChange(v)
  }
  const onKeyDown = (e: KeyboardEvent, i: number) => {
    const n = nextIndex(e.key, i, options.length)
    if (n === null) return
    e.preventDefault()
    const o = options[n]
    if (!o || o.disabled) return
    pick(o.value)
    refs.current[n]?.focus()
  }
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn('grid gap-2', className)}
      style={{ gridTemplateColumns: `repeat(${columns ?? options.length}, minmax(0, 1fr))` }}
    >
      {options.map((o, i) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={o.disabled}
            tabIndex={on ? 0 : -1}
            onClick={() => pick(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              'flex min-w-0 flex-col items-center justify-center gap-1 rounded-2xl px-1 text-center transition-[background-color,box-shadow,color] duration-200 disabled:opacity-40',
              size === 'md' ? 'min-h-[4.25rem] py-2' : 'min-h-14 py-1.5',
              on
                ? 'bg-accent/15 text-fg ring-2 ring-accent'
                : 'bg-surface-2 text-muted hover:text-fg',
            )}
          >
            <span className={cn('grid place-items-center', on && 'text-accent')} aria-hidden>
              {o.icon}
            </span>
            <span className="line-clamp-2 max-w-full text-xs leading-tight font-semibold">
              {o.label}
            </span>
            {o.meta !== undefined && (
              <span className="max-w-full truncate text-[11px] text-muted tabular-nums">
                {o.meta}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/** The big readout above a panel's one primary slider ("1.5×", "120 %"). */
export function ValueBubble({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex justify-center" aria-hidden>
      <span
        className="rounded-full bg-surface-2 px-4 py-1.5 text-2xl font-bold tabular-nums"
        title={label}
      >
        {value}
      </span>
    </div>
  )
}

/**
 * A panel's one primary slider: the value in a big bubble above a full-width track. The
 * slider keeps its label for screen readers (visually hidden) and all its gestures.
 */
export function HeroSlider({
  display,
  className,
  ...props
}: SliderProps & {
  /** The formatted value shown in the bubble. */
  display: string
}) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <ValueBubble value={display} label={props.label} />
      <Slider {...props} showValue={false} className="[&>div:first-child]:sr-only" />
    </div>
  )
}

/**
 * Colour choice, swatches first: one row of the trending colours plus a "Custom" swatch that
 * opens the full picker. Takes the same props as ColorPicker.
 */
export function SwatchPicker({
  label,
  value,
  onChange,
  onChangeStart,
  onChangeEnd,
  alpha,
  swatches = DEFAULT_SWATCHES,
}: ColorPickerProps) {
  const [custom, setCustom] = useState(false)
  const current = value.slice(0, 7).toUpperCase()
  const known = swatches.some((c) => c.toUpperCase() === current)
  const pick = (c: string) => {
    haptic(5)
    onChangeStart?.()
    onChange(c)
    onChangeEnd?.(c)
  }
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-3">
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 py-1">
        {swatches.map((c) => {
          const on = c.toUpperCase() === current
          return (
            <button
              key={c}
              type="button"
              aria-label={`Use colour ${c}`}
              aria-pressed={on}
              onClick={() => pick(c)}
              className={cn(
                'size-9 shrink-0 rounded-full ring-1 ring-white/15 transition-transform duration-150 active:scale-90',
                on && 'ring-2 ring-accent ring-offset-2 ring-offset-surface',
              )}
              style={{ background: c }}
            />
          )
        })}
        <button
          type="button"
          aria-label="Custom colour"
          aria-expanded={custom}
          onClick={() => setCustom(!custom)}
          className={cn(
            'relative size-9 shrink-0 rounded-full ring-1 ring-white/15',
            (custom || !known) && 'ring-2 ring-accent ring-offset-2 ring-offset-surface',
          )}
          style={{
            background: 'conic-gradient(#f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)',
          }}
        >
          {!known && (
            <span
              className="absolute inset-2 rounded-full ring-2 ring-white"
              style={{ background: value }}
            />
          )}
        </button>
      </div>
      {custom && (
        <ColorPicker
          label={`${label} picker`}
          value={value}
          onChange={onChange}
          {...(onChangeStart ? { onChangeStart } : {})}
          {...(onChangeEnd ? { onChangeEnd } : {})}
          {...(alpha ? { alpha } : {})}
          swatches={[]}
          className="panels-enter"
        />
      )}
    </div>
  )
}
