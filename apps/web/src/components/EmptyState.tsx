import type { ReactNode } from 'react'
import { cn } from '@/lib/cn.ts'

export interface EmptyStateProps {
  icon?: ReactNode
  title: string
  description?: ReactNode
  action?: ReactNode
  className?: string
}

/** Friendly placeholder for empty lists and unavailable features. */
export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 py-10 text-center',
        className,
      )}
    >
      {icon && (
        <div className="grid size-14 place-items-center rounded-2xl bg-surface-2 text-muted">
          {icon}
        </div>
      )}
      <div>
        <p className="text-base font-semibold">{title}</p>
        {description && <div className="mt-1 max-w-sm text-sm text-muted">{description}</div>}
      </div>
      {action}
    </div>
  )
}
