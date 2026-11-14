import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react'
import { cn } from '@/lib/cn.ts'

export interface TooltipProps {
  content: ReactNode
  /** The trigger; receives `aria-describedby`. */
  children: ReactElement<{ 'aria-describedby'?: string }>
  side?: 'top' | 'bottom'
  className?: string
}

/**
 * Lightweight hover/focus tooltip. Pure CSS show/hide (no state, no re-render on hover);
 * Tailwind's `hover` variants only match hover-capable pointers, so touch devices never get
 * stuck tooltips — on phones the trigger's accessible name carries the meaning.
 */
export function Tooltip({ content, children, side = 'top', className }: TooltipProps) {
  const id = useId()
  const trigger = isValidElement(children)
    ? cloneElement(children, { 'aria-describedby': id })
    : children
  return (
    <span className="group/tt relative inline-flex">
      {trigger}
      <span
        role="tooltip"
        id={id}
        className={cn(
          'pointer-events-none absolute left-1/2 z-[60] -translate-x-1/2 rounded-lg bg-surface-3 px-2 py-1 text-xs font-medium whitespace-nowrap text-fg opacity-0 shadow-pop transition-opacity',
          'group-hover/tt:opacity-100 group-hover/tt:delay-500 group-has-[:focus-visible]/tt:opacity-100',
          side === 'top' ? 'bottom-full mb-2' : 'top-full mt-2',
          className,
        )}
      >
        {content}
      </span>
    </span>
  )
}
