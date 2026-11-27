import { ArrowRight, Plus, Sparkles, Upload } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { useProjects } from '@/api/queries.ts'
import { Button } from '@/components/Button.tsx'
import { EmptyState } from '@/components/EmptyState.tsx'
import { FileButton } from '@/components/FileButton.tsx'
import { Skeleton } from '@/components/Skeleton.tsx'
import { cn } from '@/lib/cn.ts'
import { AppFrame, SectionTitle } from './AppFrame.tsx'
import { AutoEditSheet } from './home/AutoEditSheet.tsx'
import { ProjectCard } from './home/ProjectCard.tsx'
import { TemplateCarousel } from './home/Templates.tsx'
import { useStartProject } from './home/useImport.ts'

/** Projects shown before "Show all" (phones show the first four). */
const PREVIEW = 6
const GRID = 'grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 lg:grid-cols-6'

/** Home: one hero ("Make a reel"), two quiet starts, your projects, trending templates. */
export function HomeScreen() {
  const projects = useProjects()
  const { start, pending } = useStartProject()
  const [showAll, setShowAll] = useState(false)
  // `?autoedit=1&topic=…&vibe=…` (from the trends screen) opens Auto edit prefilled.
  const [params, setParams] = useSearchParams()
  const autoEditOpen = params.get('autoedit') === '1'
  const openAutoEdit = () => setParams({ autoedit: '1' })
  const closeAutoEdit = () => setParams({}, { replace: true })
  const topic = params.get('topic') ?? undefined
  const vibe = params.get('vibe') ?? undefined

  const sorted = projects.data?.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)) ?? []
  const shown = showAll ? sorted : sorted.slice(0, PREVIEW)
  // Phones show 4 until expanded; wider grids show a full row of 6.
  const hiddenOnPhone = Math.max(0, Math.min(sorted.length, PREVIEW) - 4)
  const more = sorted.length - PREVIEW

  return (
    <AppFrame title="Projects">
      <div className="mt-2 flex flex-col gap-3 md:mt-6 lg:flex-row">
        <button
          type="button"
          data-testid="auto-edit"
          onClick={openAutoEdit}
          className="rf-shimmer bg-magic-soft animate-rf-drift group relative flex min-h-40 w-full lg:min-h-52 lg:flex-1 lg:p-7 flex-col justify-between gap-6 rounded-[1.75rem] p-5 text-left text-white shadow-[0_12px_40px_rgb(139_92_246/0.25)] ring-1 ring-white/10 transition-transform duration-200 ease-[var(--ease-spring)] active:scale-[0.985]"
        >
          <span className="glass grid size-11 place-items-center rounded-full">
            <Sparkles size={22} aria-hidden />
          </span>
          <span className="flex items-end justify-between gap-4">
            <span className="flex min-w-0 flex-col gap-1">
              <span className="text-[26px] leading-none font-bold tracking-tight">Make a reel</span>
              <span className="text-[15px] text-white/80">
                Drop your clips — Magic edits them to the beat
              </span>
            </span>
            <span
              aria-hidden
              className="grid size-11 shrink-0 place-items-center rounded-full bg-white text-[#121218] transition-transform duration-200 ease-[var(--ease-spring)] group-hover:translate-x-0.5"
            >
              <ArrowRight size={20} />
            </span>
          </span>
        </button>
        <div className="flex gap-2 lg:w-60 lg:flex-col">
          <button
            type="button"
            aria-label="New project"
            disabled={pending}
            onClick={() => void start()}
            className="flex h-11 flex-1 lg:h-auto items-center justify-center gap-2 rounded-full bg-surface-2 text-sm font-semibold text-fg transition-colors hover:bg-surface-3 disabled:opacity-50 lg:rounded-3xl"
          >
            <Plus size={18} aria-hidden />
            Blank project
          </button>
          <FileButton
            testId="import-media"
            onFiles={(files) => void start(files)}
            disabled={pending}
            className="h-11 flex-1 gap-2 lg:h-auto rounded-full bg-surface-2 text-sm font-semibold text-fg transition-colors hover:bg-surface-3 lg:rounded-3xl"
          >
            <Upload size={18} aria-hidden />
            Import
          </FileButton>
        </div>
      </div>
      {autoEditOpen && (
        <AutoEditSheet
          open
          onClose={closeAutoEdit}
          prefill={{ ...(topic ? { topic } : {}), ...(vibe ? { vibe } : {}) }}
        />
      )}

      <SectionTitle
        action={
          sorted.length > 4 && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              aria-expanded={showAll}
              className={cn(
                'h-8 rounded-full px-3 text-sm font-semibold text-accent hover:bg-surface-2',
                // Nothing extra to reveal on wide screens when everything already fits.
                !showAll && more <= 0 && 'sm:hidden',
              )}
            >
              {showAll ? 'Show less' : `Show all (${sorted.length})`}
            </button>
          )
        }
      >
        Your projects
      </SectionTitle>
      {projects.isPending ? (
        <ul className={GRID}>
          {[0, 1, 2, 3].map((i) => (
            <li key={i}>
              <Skeleton className="aspect-[9/16] w-full rounded-2xl" />
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
      ) : sorted.length === 0 ? (
        <EmptyProjects />
      ) : (
        <ul
          className={cn(
            GRID,
            !showAll && hiddenOnPhone > 0 && 'max-sm:[&>li:nth-child(n+5)]:hidden',
          )}
          data-testid="projects"
        >
          {shown.map((p) => (
            <li key={p.id} className="animate-rf-rise">
              <ProjectCard project={p} />
            </li>
          ))}
        </ul>
      )}

      <TemplateCarousel />
    </AppFrame>
  )
}

/** Three ghost reels fanned out, with a one-line nudge. */
function EmptyProjects() {
  return (
    <div className="flex items-center gap-5 rounded-3xl bg-surface px-5 py-6">
      <div aria-hidden className="relative h-20 w-20 shrink-0">
        <span className="absolute top-2 left-1 h-16 w-9 -rotate-12 rounded-lg bg-violet/30" />
        <span className="absolute top-2 right-1 h-16 w-9 rotate-12 rounded-lg bg-accent/30" />
        <span className="absolute top-0 left-1/2 grid h-[4.5rem] w-10 -translate-x-1/2 place-items-center rounded-lg bg-surface-3 ring-1 ring-line">
          <Sparkles size={16} className="text-accent" />
        </span>
      </div>
      <div className="min-w-0">
        <p className="font-semibold">No reels yet</p>
        <p className="text-sm text-muted">Your projects will show up here.</p>
      </div>
    </div>
  )
}
