/**
 * Running Magic tasks as slim rows pinned to the top of the panel: live progress with
 * cancel, the result to apply or discard, or the error with Retry. Each row carries
 * `data-testid="task-<id>"` like the full TaskCard does, and stays the same element as the
 * task moves from running to its outcome.
 */
import { AlertTriangle, Check, RotateCcw, X } from 'lucide-react'
import { useStore } from 'zustand'
import { Button } from '@/components/Button.tsx'
import { IconButton } from '@/components/IconButton.tsx'
import { cn } from '@/lib/cn.ts'
import { aiTasks, type AiTasks, type TaskState } from './tasks.ts'

function Running({ t, tasks }: { t: TaskState; tasks: AiTasks }) {
  const pct = Math.round(t.progress * 100)
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm">
          <span className="font-semibold">{t.label}</span>
          <span className="text-muted"> · {t.message}</span>
        </span>
        <span className="text-xs text-muted tabular-nums">{pct}%</span>
        <IconButton
          size="sm"
          label="Cancel"
          icon={<X size={16} />}
          onClick={() => tasks.cancel(t.id)}
        />
      </div>
      <div
        role="progressbar"
        aria-label={t.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={t.message}
        className="mr-2 h-1 overflow-hidden rounded-full bg-surface-3"
      >
        <div
          className="panels-cta h-full origin-left rounded-full bg-accent transition-transform duration-300"
          style={{ transform: `scaleX(${t.progress})` }}
        />
      </div>
    </>
  )
}

function Outcome({ t, tasks }: { t: TaskState; tasks: AiTasks }) {
  const review = t.status === 'review'
  const detail = review ? t.review?.detail : t.error
  return (
    <div className="panels-enter flex items-center gap-2">
      {review ? (
        <Check size={18} className="shrink-0 text-accent" />
      ) : (
        <AlertTriangle size={18} className="shrink-0 text-danger" />
      )}
      <span className="flex min-w-0 flex-1 flex-col text-sm">
        <span className="truncate font-semibold">
          {review ? t.review?.summary : `${t.label} failed`}
        </span>
        {detail && <span className="truncate text-xs text-muted">{detail}</span>}
      </span>
      <Button size="sm" variant="ghost" onClick={() => tasks.dismiss(t.id)}>
        {review ? 'Discard' : 'Dismiss'}
      </Button>
      {review ? (
        <Button
          size="sm"
          variant="primary"
          className="panels-cta"
          onClick={() => tasks.apply(t.id)}
        >
          Apply
        </Button>
      ) : (
        <Button
          size="sm"
          variant="primary"
          icon={<RotateCcw size={14} />}
          onClick={() => tasks.retry(t.id)}
        >
          Retry
        </Button>
      )}
    </div>
  )
}

function TaskRow({ t, tasks }: { t: TaskState; tasks: AiTasks }) {
  const running = t.status === 'running'
  const review = t.status === 'review'
  return (
    <li
      className={cn(
        'flex flex-col gap-1.5 rounded-2xl py-2 pl-3',
        running ? 'bg-surface-2 pr-1' : review ? 'bg-accent/10 pr-2' : 'bg-danger/10 pr-2',
      )}
      data-testid={`task-${t.id}`}
      role={running ? undefined : review ? 'status' : 'alert'}
    >
      {running ? <Running t={t} tasks={tasks} /> : <Outcome t={t} tasks={tasks} />}
    </li>
  )
}

/** Every active task, newest last. Renders nothing when idle. */
export function TaskStrip({ tasks = aiTasks }: { tasks?: AiTasks }) {
  const list = useStore(tasks.store, (s) => s.tasks)
  const active = Object.values(list).filter((t): t is TaskState => !!t)
  if (active.length === 0) return null
  return (
    <ul
      aria-label="Magic tasks"
      className="sticky top-0 z-10 -mx-4 -mt-4 flex flex-col gap-1.5 bg-surface/95 px-4 pt-3 pb-2 backdrop-blur-md"
    >
      {active.map((t) => (
        <TaskRow key={t.id} t={t} tasks={tasks} />
      ))}
    </ul>
  )
}
