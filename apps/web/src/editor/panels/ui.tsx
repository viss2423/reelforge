/**
 * Small layout pieces shared by every panel and the inspector, so sheets (phones) and
 * inspector sections (desktop) look and behave the same.
 */
import { Check, ChevronDown, Diamond } from 'lucide-react'
import { createContext, useContext, useState, type ReactNode } from 'react'
import { api } from '@/api/index.ts'
import { Slider } from '@/components/Slider.tsx'
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
  const toggle = () => {
    openState.set(title, !open)
    setOpen(!open)
  }
  return (
    <section className={cn('flex flex-col gap-3', className)} aria-label={title}>
      <header className="flex min-h-8 items-center justify-between gap-2">
        {canCollapse ? (
          <button
            type="button"
            className="flex flex-1 items-center gap-1.5 text-left text-xs font-bold tracking-wide text-muted uppercase"
            aria-expanded={open}
            onClick={toggle}
          >
            <ChevronDown size={14} className={cn('transition-transform', !open && '-rotate-90')} />
            {title}
          </button>
        ) : (
          <h3 className="text-xs font-bold tracking-wide text-muted uppercase">{title}</h3>
        )}
        {action}
      </header>
      {(!canCollapse || open) && children}
    </section>
  )
}

/** Scrollable padded body of a panel. */
export function PanelBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-col gap-6 p-4 pb-8', className)}>{children}</div>
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
