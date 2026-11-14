import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from '@/lib/cn.ts'
import { haptic } from '@/lib/haptics.ts'
import { nextIndex } from './Tabs.tsx'

export interface SegmentOption<T extends string | number> {
  value: T
  label: ReactNode
  disabled?: boolean
}

export interface SegmentedControlProps<T extends string | number> {
  options: readonly SegmentOption<T>[]
  value: T
  onChange: (value: T) => void
  label: string
  size?: 'sm' | 'md'
  className?: string
}

/** iOS-style segmented radio group with arrow-key navigation. */
export function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
  label,
  size = 'md',
  className,
}: SegmentedControlProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const select = (v: T) => {
    if (v === value) return
    haptic(5)
    onChange(v)
  }
  const onKeyDown = (e: KeyboardEvent, i: number) => {
    let n = nextIndex(e.key, i, options.length)
    if (n === null) return
    e.preventDefault()
    // Skip disabled options in the direction of travel.
    for (let k = 0; k < options.length && options[n]?.disabled; k++) {
      n =
        nextIndex(
          e.key === 'Home' ? 'ArrowRight' : e.key === 'End' ? 'ArrowLeft' : e.key,
          n,
          options.length,
        ) ?? n
    }
    const opt = options[n]
    if (!opt || opt.disabled) return
    select(opt.value)
    refs.current[n]?.focus()
  }
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn('flex gap-1 rounded-xl bg-surface-2 p-1', className)}
    >
      {options.map((o, i) => {
        const checked = o.value === value
        return (
          <button
            key={String(o.value)}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={o.disabled}
            tabIndex={checked ? 0 : -1}
            onClick={() => select(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              'flex-1 rounded-lg px-2 font-semibold whitespace-nowrap transition-colors disabled:opacity-40',
              size === 'md' ? 'min-h-10 text-sm' : 'min-h-8 text-xs',
              checked ? 'bg-surface-3 text-fg shadow-sm' : 'text-muted hover:text-fg',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
