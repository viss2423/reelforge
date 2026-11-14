import { Clapperboard, Film, Plus, Upload } from 'lucide-react'
import { Link } from 'react-router'
import { useJobs, useProjects, selectExports } from '@/api/queries.ts'
import { Button } from '@/components/Button.tsx'
import { EmptyState } from '@/components/EmptyState.tsx'
import { FileButton } from '@/components/FileButton.tsx'
import { Skeleton } from '@/components/Skeleton.tsx'
import { formatRelative } from '@/lib/format.ts'
import { AppFrame, SectionTitle } from './AppFrame.tsx'
import { ProjectCard } from './home/ProjectCard.tsx'
import { TemplateCarousel } from './home/Templates.tsx'
import { useStartProject } from './home/useImport.ts'

const selectRecentExports = (jobs: Parameters<typeof selectExports>[0]) =>
  selectExports(jobs)
    .filter((j) => j.status === 'done')
    .slice(0, 3)

/** Projects, quick start (new / import), trending templates and recent exports. */
export function HomeScreen() {
  const projects = useProjects()
  const recentExports = useJobs(selectRecentExports)
  const { start, pending } = useStartProject()

  return (
    <AppFrame title="Projects">
      <div className="mt-4 grid grid-cols-2 gap-3 sm:max-w-md">
        <FileButton
          testId="import-media"
          onFiles={(files) => void start(files)}
          disabled={pending}
          className="h-24 flex-col gap-1.5 rounded-card bg-accent font-semibold text-accent-fg"
        >
          <Upload size={24} />
          Import media
        </FileButton>
        <button
          type="button"
          disabled={pending}
          onClick={() => void start()}
          className="flex h-24 flex-col items-center justify-center gap-1.5 rounded-card border border-line bg-surface-2 font-semibold disabled:opacity-50"
        >
          <Plus size={24} />
          New project
        </button>
      </div>

      <TemplateCarousel />

      <SectionTitle>Your projects</SectionTitle>
      {projects.isPending ? (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {[0, 1, 2, 3].map((i) => (
            <li key={i}>
              <Skeleton className="aspect-[9/16] w-full" />
              <Skeleton className="mt-2 h-4 w-3/4" />
            </li>
          ))}
        </ul>
      ) : projects.isError ? (
        <EmptyState
          title="Couldn't load projects"
          description={projects.error.message}
          action={<Button onClick={() => void projects.refetch()}>Retry</Button>}
        />
      ) : projects.data.length === 0 ? (
        <EmptyState
          icon={<Clapperboard size={28} />}
          title="No projects yet"
          description="Import a few clips or start from a trending template."
        />
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" data-testid="projects">
          {projects.data
            .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .map((p) => (
              <li key={p.id}>
                <ProjectCard project={p} />
              </li>
            ))}
        </ul>
      )}

      {recentExports.data && recentExports.data.length > 0 && (
        <>
          <SectionTitle
            action={
              <Link to="/exports" className="text-sm font-semibold text-accent">
                See all
              </Link>
            }
          >
            Recent exports
          </SectionTitle>
          <ul className="flex flex-col gap-2">
            {recentExports.data.map((j) => (
              <li key={j.id}>
                <Link
                  to="/exports"
                  className="flex min-h-14 items-center gap-3 rounded-xl bg-surface px-3 py-2"
                >
                  <Film size={20} className="shrink-0 text-violet" />
                  <span className="min-w-0 flex-1 truncate">
                    {projects.data?.find((p) => p.id === j.projectId)?.name ?? 'Export'}
                  </span>
                  <span className="text-xs text-muted">
                    {formatRelative(j.finishedAt ?? j.createdAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </AppFrame>
  )
}
