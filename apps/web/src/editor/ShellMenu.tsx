/**
 * Small anchored option menus for the editor shell: the stage's glass "⋯" (safe zones,
 * crop) and the timeline's "⋯" (ripple / roll, tracks). A trigger button plus a popover
 * that closes on Escape, an outside press or `close()`. The popover is a labelled group of
 * ordinary buttons (toggles keep `aria-pressed`), not an ARIA menu, so toggles stay simple.
 * `className` replaces the wrapper's default `relative`, so it must position the wrapper.
 */
import { useEffect, useId, useRef, useState, type HTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/cn.ts'

export interface ShellMenuProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** Accessible name of the trigger and the popover. */
  label: string
  icon: ReactNode
  /** Trigger look. 'glass' floats over video; 'plain' sits on the calm surface. */
  tone?: 'glass' | 'plain'
  /** Where the popover opens relative to the trigger. */
  side?: 'top' | 'bottom'
  align?: 'start' | 'end'
  triggerClassName?: string
  triggerTestId?: string
  panelClassName?: string
  children: (close: () => void) => ReactNode
}

export function ShellMenu({
  label,
  icon,
  tone = 'plain',
  side = 'bottom',
  align = 'end',
  triggerClassName,
  triggerTestId,
  panelClassName,
  className,
  children,
  ...rest
}: ShellMenuProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const id = useId()

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  return (
    <div ref={ref} className={className ?? 'relative'} {...rest}>
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        data-testid={triggerTestId}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'relative grid place-items-center rounded-full transition-[background-color,color,transform] duration-150 ease-[var(--ease-spring)] active:scale-95',
          // Visual stays small; the hit area is 44 px.
          'before:absolute before:-inset-2 before:content-[""]',
          tone === 'glass'
            ? 'shell-glass size-8 hover:bg-black/55'
            : 'size-7 text-muted hover:bg-surface-2 hover:text-fg aria-expanded:bg-surface-2 aria-expanded:text-fg',
          triggerClassName,
        )}
      >
        {icon}
      </button>
      {open && (
        <div
          id={id}
          role="group"
          aria-label={label}
          className={cn(
            'shell-pop absolute z-50 flex min-w-48 flex-col gap-0.5 rounded-2xl p-1.5 shadow-pop',
            tone === 'glass'
              ? 'bg-black/75 text-white ring-1 ring-white/10 backdrop-blur-md'
              : 'border border-line bg-surface-2 text-fg',
            side === 'bottom' ? 'top-full mt-2' : 'bottom-full mb-2',
            align === 'end' ? 'right-0' : 'left-0',
            panelClassName,
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

/** A row in a ShellMenu: icon, label and (for toggles) a small switch. */
export function ShellMenuItem({
  icon,
  label,
  pressed,
  onClick,
  tone = 'plain',
  hint,
  ...rest
}: {
  icon: ReactNode
  label: string
  pressed?: boolean
  onClick: () => void
  tone?: 'glass' | 'plain'
  /** One-line explanation, shown as the native tooltip. */
  hint?: string
} & Omit<HTMLAttributes<HTMLButtonElement>, 'onClick'>) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      title={hint}
      onClick={onClick}
      className={cn(
        'flex h-11 items-center gap-3 rounded-xl px-2.5 text-left text-[15px] transition-colors',
        tone === 'glass' ? 'text-white hover:bg-white/10' : 'text-fg hover:bg-surface-3',
      )}
      {...rest}
    >
      <span className="grid size-5 shrink-0 place-items-center opacity-80">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {pressed !== undefined && (
        <span
          aria-hidden
          className={cn(
            'relative h-5 w-8 shrink-0 rounded-full transition-colors duration-200',
            pressed ? 'bg-accent' : tone === 'glass' ? 'bg-white/20' : 'bg-surface-3',
          )}
        >
          <span
            className={cn(
              'absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform duration-200 ease-[var(--ease-spring)]',
              pressed && 'translate-x-3',
            )}
          />
        </span>
      )}
    </button>
  )
}

/** Section title inside a ShellMenu. */
export function ShellMenuLabel({ children }: { children: ReactNode }) {
  return (
    <p className="px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">
      {children}
    </p>
  )
}
