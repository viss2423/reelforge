import { cn } from '@/lib/cn.ts'

/**
 * Loading placeholder. Give it the exact size of the content it stands in for so nothing
 * shifts when the data arrives.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        'animate-shimmer rounded-xl bg-[linear-gradient(90deg,var(--rf-surface-2)_25%,var(--rf-surface-3)_50%,var(--rf-surface-2)_75%)] bg-[length:200%_100%]',
        className,
      )}
    />
  )
}
