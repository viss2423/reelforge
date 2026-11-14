import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from '@/lib/cn.ts'

export interface TabItem<T extends string> {
  id: T
  label: ReactNode
  icon?: ReactNode
}

/** Moves focus/selection with arrow keys, Home and End (WAI-ARIA roving tabindex). */
export const nextIndex = (key: string, i: number, n: number): number | null => {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (i + 1) % n
    case 'ArrowLeft':
    case 'ArrowUp':
      return (i - 1 + n) % n
    case 'Home':
      return 0
    case 'End':
      return n - 1
    default:
      return null
  }
}

export interface TabsProps<T extends string> {
  items: readonly TabItem<T>[]
  value: T
  onChange: (id: T) => void
  label: string
  className?: string
  /** Renders the panel for the active tab. */
  children?: (active: T) => ReactNode
}

/** Accessible underline tabs (scrollable when they overflow on phones). */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  label,
  className,
  children,
}: TabsProps<T>) {
  const base = useId()
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const onKeyDown = (e: KeyboardEvent, i: number) => {
    const n = nextIndex(e.key, i, items.length)
    if (n === null) return
    e.preventDefault()
    const item = items[n]
    if (!item) return
    onChange(item.id)
    refs.current[n]?.focus()
  }
  return (
    <div className={className}>
      <div
        role="tablist"
        aria-label={label}
        className="flex gap-1 overflow-x-auto border-b border-line"
      >
        {items.map((t, i) => {
          const selected = t.id === value
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[i] = el
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${t.id}`}
              aria-selected={selected}
              aria-controls={children ? `${base}-panel` : undefined}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(t.id)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={cn(
                'relative flex min-h-11 shrink-0 items-center gap-2 px-3 text-sm font-semibold whitespace-nowrap transition-colors',
                selected ? 'text-fg' : 'text-muted hover:text-fg',
              )}
            >
              {t.icon}
              {t.label}
              {selected && (
                <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />
              )}
            </button>
          )
        })}
      </div>
      {children && (
        <div role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${value}`}>
          {children(value)}
        </div>
      )}
    </div>
  )
}
