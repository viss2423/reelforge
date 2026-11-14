import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import { cn } from '@/lib/cn.ts'

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Accessible name; also shown as a native tooltip on desktop. */
  label: string
  icon: ReactNode
  variant?: 'ghost' | 'solid' | 'accent'
  /** Pressed state for toggles (rendered as aria-pressed). */
  pressed?: boolean
  size?: 'sm' | 'md'
  ref?: Ref<HTMLButtonElement>
}

/** Square icon-only button with a 44 px touch target (32 px visual for `sm`). */
export function IconButton({
  label,
  icon,
  variant = 'ghost',
  pressed,
  size = 'md',
  className,
  type = 'button',
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={cn(
        // No base `position`: callers may pass `absolute` etc. (cn does not merge conflicts).
        'inline-flex shrink-0 select-none items-center justify-center rounded-xl transition-colors disabled:opacity-40',
        size === 'md' ? 'size-11' : 'size-8 rounded-lg',
        // Invisible hit-area extension keeps small buttons at 44 px for touch.
        size === 'sm' && 'relative before:absolute before:-inset-1.5 before:content-[""]',
        variant === 'ghost' && 'text-fg hover:bg-surface-2',
        variant === 'solid' && 'bg-surface-2 text-fg hover:bg-surface-3',
        variant === 'accent' && 'bg-accent text-accent-fg hover:bg-accent-hover',
        pressed && 'bg-surface-3 text-accent',
        className,
      )}
      {...rest}
    >
      {icon}
    </button>
  )
}
