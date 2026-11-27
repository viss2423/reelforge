import type { Job } from '@reelforge/core'
import { ChevronDown, CircleAlert, Film } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { api } from '@/api/index.ts'
import { useJobs, useProjects, selectExports } from '@/api/queries.ts'
import type { ProjectSummary } from '@/api/schemas.ts'
import { Button } from '@/components/Button.tsx'
import { EmptyState } from '@/components/EmptyState.tsx'
import { Skeleton } from '@/components/Skeleton.tsx'
import { ExportActions, ExportPlayer, ExportProgress } from '@/exports/ExportResult.tsx'
import { cn } from '@/lib/cn.ts'
import { formatBytes, formatDuration, formatRelative } from '@/lib/format.ts'
import { AppFrame } from './AppFrame.tsx'

/** Every export job on the host, newest first, with live progress and playback. */
export function ExportsScreen() {
  const jobs = useJobs(selectExports)
  const projects = useProjects()
  const projectOf = (id: string | undefined) => projects.data?.find((p) => p.id === id)
  // Only one inline player at a time: video elements are expensive on phones.
  const [open, setOpen] = useState<string | null>(null)
  const firstDone = jobs.data?.find((j) => j.status === 'done')?.id ?? null
  const expanded = open ?? firstDone

  return (
    <AppFrame title="Exports">
      <div className="mx-auto mt-2 max-w-3xl">
        {jobs.isPending ? (
          <div className="flex flex-col gap-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-24 w-full rounded-2xl" />
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
            description="Finished reels land here, on every device."
            action={
              <Link
                to="/"
                className="bg-magic inline-flex h-11 items-center rounded-full px-5 font-semibold text-white"
              >
                Make a reel
              </Link>
            }
          />
        ) : (
          <ul className="flex flex-col gap-2" data-testid="exports">
            {jobs.data.map((j) => (
              <ExportRow
                key={j.id}
                job={j}
                project={projectOf(j.projectId)}
                expanded={expanded === j.id}
                onToggle={() => setOpen(expanded === j.id ? '' : j.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </AppFrame>
  )
}

const STATUS_LABEL: Record<Job['status'], string> = {
  queued: 'Waiting',
  running: 'Exporting',
  done: 'Ready',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

/** Size and length of a finished export (the render result), when the host reported them. */
const outputInfo = (job: Job): { size?: number; duration?: number } => {
  const r = job.result as { size?: unknown; duration?: unknown } | null | undefined
  return {
    ...(typeof r?.size === 'number' ? { size: r.size } : {}),
    ...(typeof r?.duration === 'number' ? { duration: r.duration } : {}),
  }
}

function Thumb({ project }: { project: ProjectSummary | undefined }) {
  const [failed, setFailed] = useState(false)
  return (
    <span className="relative block aspect-[9/16] w-12 shrink-0 overflow-hidden rounded-lg bg-gradient-to-br from-violet/30 to-accent/20">
      {project?.thumbAssetId && !failed ? (
        <img
          src={api.posterUrl(project.thumbAssetId)}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="absolute inset-0 size-full object-cover"
        />
      ) : (
        <Film size={18} aria-hidden className="absolute inset-0 m-auto text-white/70" />
      )}
    </span>
  )
}

function ExportRow({
  job,
  project,
  expanded,
  onToggle,
}: {
  job: Job
  project: ProjectSummary | undefined
  expanded: boolean
  onToggle: () => void
}) {
  const active = job.status === 'queued' || job.status === 'running'
  const done = job.status === 'done'
  const { size, duration } = outputInfo(job)
  const meta = [
    done ? null : STATUS_LABEL[job.status],
    done && duration ? formatDuration(duration) : null,
    done && size ? formatBytes(size) : null,
    formatRelative(job.finishedAt ?? job.createdAt),
  ].filter(Boolean)
  return (
    <li
      className={cn(
        'overflow-hidden rounded-2xl bg-surface transition-colors',
        expanded && 'bg-surface-2/60',
      )}
      data-status={job.status}
    >
      <button
        type="button"
        onClick={onToggle}
        disabled={!done}
        aria-expanded={done ? expanded : undefined}
        className="flex w-full items-center gap-3 p-3 text-left"
      >
        <Thumb project={project} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold">
            {project?.name ?? 'Deleted project'}
          </span>
          <span
            className={cn(
              'mt-0.5 block truncate text-xs tabular-nums',
              job.status === 'failed' ? 'text-danger' : 'text-muted',
            )}
          >
            {meta.join(' · ')}
          </span>
        </span>
        {done && (
          <ChevronDown
            size={18}
            aria-hidden
            className={cn(
              'mr-1 shrink-0 text-muted transition-transform duration-200',
              expanded && 'rotate-180',
            )}
          />
        )}
      </button>
      {active && (
        <div className="px-3 pb-3">
          <ExportProgress job={job} />
        </div>
      )}
      {job.status === 'failed' && job.error && (
        <p className="flex gap-2 px-4 pb-3 text-sm text-danger">
          <CircleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
          <span className="line-clamp-2">{job.error}</span>
        </p>
      )}
      {done && expanded && (
        <div className="animate-rf-rise flex flex-col gap-3 px-3 pb-3 sm:flex-row sm:items-end">
          <ExportPlayer job={job} className="max-h-[60vh] rounded-xl sm:w-56" />
          <ExportActions job={job} projectName={project?.name} />
        </div>
      )}
    </li>
  )
}
