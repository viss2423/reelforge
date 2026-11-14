import type { Job } from '@reelforge/core'
import { ChevronDown, CircleAlert, Film } from 'lucide-react'
import { useState } from 'react'
import { useJobs, useProjects, selectExports } from '@/api/queries.ts'
import { Button } from '@/components/Button.tsx'
import { EmptyState } from '@/components/EmptyState.tsx'
import { Skeleton } from '@/components/Skeleton.tsx'
import { ExportActions, ExportPlayer, ExportProgress } from '@/exports/ExportResult.tsx'
import { cn } from '@/lib/cn.ts'
import { formatRelative } from '@/lib/format.ts'
import { AppFrame } from './AppFrame.tsx'

/** Every export job on the host, newest first, with live progress and playback. */
export function ExportsScreen() {
  const jobs = useJobs(selectExports)
  const projects = useProjects()
  const nameOf = (id: string | undefined) => projects.data?.find((p) => p.id === id)?.name
  // Only one inline player at a time: video elements are expensive on phones.
  const [open, setOpen] = useState<string | null>(null)
  const firstDone = jobs.data?.find((j) => j.status === 'done')?.id ?? null
  const expanded = open ?? firstDone

  return (
    <AppFrame title="Exports">
      {jobs.isPending ? (
        <div className="mt-4 flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : jobs.isError ? (
        <EmptyState
          title="Couldn't load exports"
          description={jobs.error.message}
          action={<Button onClick={() => void jobs.refetch()}>Retry</Button>}
        />
      ) : jobs.data.length === 0 ? (
        <EmptyState
          icon={<Film size={28} />}
          title="No exports yet"
          description="Open a project and tap Export. Finished videos show up here on every device."
        />
      ) : (
        <ul className="mt-4 flex flex-col gap-2" data-testid="exports">
          {jobs.data.map((j) => (
            <ExportRow
              key={j.id}
              job={j}
              projectName={nameOf(j.projectId)}
              expanded={expanded === j.id}
              onToggle={() => setOpen(expanded === j.id ? '' : j.id)}
            />
          ))}
        </ul>
      )}
    </AppFrame>
  )
}

const STATUS_LABEL: Record<Job['status'], string> = {
  queued: 'Queued',
  running: 'Exporting',
  done: 'Ready',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

function ExportRow({
  job,
  projectName,
  expanded,
  onToggle,
}: {
  job: Job
  projectName: string | undefined
  expanded: boolean
  onToggle: () => void
}) {
  const active = job.status === 'queued' || job.status === 'running'
  return (
    <li
      className="overflow-hidden rounded-card border border-line bg-surface"
      data-status={job.status}
    >
      <button
        type="button"
        onClick={onToggle}
        disabled={job.status !== 'done'}
        aria-expanded={job.status === 'done' ? expanded : undefined}
        className="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left"
      >
        <Film size={20} className="shrink-0 text-violet" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{projectName ?? 'Deleted project'}</span>
          <span className="block text-xs text-muted">
            {STATUS_LABEL[job.status]} · {formatRelative(job.finishedAt ?? job.createdAt)}
          </span>
        </span>
        {job.status === 'done' && (
          <ChevronDown
            size={18}
            className={cn('shrink-0 transition-transform', expanded && 'rotate-180')}
          />
        )}
      </button>
      {active && (
        <div className="px-4 pb-4">
          <ExportProgress job={job} />
        </div>
      )}
      {job.status === 'failed' && (
        <p className="flex gap-2 px-4 pb-4 text-sm text-danger">
          <CircleAlert size={16} className="mt-0.5 shrink-0" />
          {job.error ?? 'Export failed'}
        </p>
      )}
      {job.status === 'done' && expanded && (
        <div className="flex flex-col gap-3 px-4 pb-4 sm:flex-row sm:items-start">
          <ExportPlayer job={job} className="max-h-[60vh] sm:w-56" />
          <ExportActions job={job} projectName={projectName} />
        </div>
      )}
    </li>
  )
}
