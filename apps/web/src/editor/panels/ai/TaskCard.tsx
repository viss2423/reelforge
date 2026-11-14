/**
 * Live state of one AI task: host progress while running, the preview to confirm, or the
 * error with Retry. When the task is idle it renders `children` (the start control).
 */
import { AlertTriangle, Check, RotateCcw, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/Button.tsx'
import { cn } from '@/lib/cn.ts'
import { aiTasks, useAiTask, type AiTaskId, type AiTasks } from './tasks.ts'

export function TaskCard({
  id,
  children,
  tasks = aiTasks,
}: {
  id: AiTaskId
  children: ReactNode
  tasks?: AiTasks
}) {
  const t = useAiTask(id, tasks)
  if (!t) return <>{children}</>
  if (t.status === 'running') {
    const pct = Math.round(t.progress * 100)
    return (
      <div className="flex flex-col gap-2 rounded-xl bg-surface-2 p-3" data-testid={`task-${id}`}>
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="font-semibold">{t.label}</span>
          <span className="text-muted tabular-nums">{pct}%</span>
        </div>
        <div
          role="progressbar"
          aria-label={t.label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-valuetext={t.message}
          className="h-1.5 overflow-hidden rounded-full bg-surface-3"
        >
          <div
            className="h-full origin-left rounded-full bg-accent transition-transform duration-300"
            style={{ transform: `scaleX(${t.progress})` }}
          />
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs text-muted">{t.message}</span>
          <Button size="sm" variant="ghost" icon={<X size={14} />} onClick={() => tasks.cancel(id)}>
            Cancel
          </Button>
        </div>
      </div>
    )
  }
  const review = t.status === 'review'
  return (
    <div
      className={cn('flex flex-col gap-3 rounded-xl p-3', review ? 'bg-accent/10' : 'bg-danger/10')}
      data-testid={`task-${id}`}
      role={review ? 'status' : 'alert'}
    >
      <div className="flex items-start gap-2 text-sm">
        {review ? (
          <Check size={18} className="mt-0.5 shrink-0 text-accent" />
        ) : (
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-danger" />
        )}
        <div className="flex flex-col">
          <span className="font-semibold">{review ? t.review?.summary : `${t.label} failed`}</span>
          <span className="text-muted">{review ? t.review?.detail : t.error}</span>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => tasks.dismiss(id)}>
          {review ? 'Discard' : 'Dismiss'}
        </Button>
        {review ? (
          <Button size="sm" variant="primary" onClick={() => tasks.apply(id)}>
            Apply
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            icon={<RotateCcw size={14} />}
            onClick={() => tasks.retry(id)}
          >
            Retry
          </Button>
        )}
      </div>
    </div>
  )
}
