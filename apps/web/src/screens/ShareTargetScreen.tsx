import { FileVideo, Inbox, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useCreateProject, useProjects } from '@/api/queries.ts'
import { Button } from '@/components/Button.tsx'
import { EmptyState } from '@/components/EmptyState.tsx'
import { Spinner } from '@/components/Spinner.tsx'
import { toast } from '@/components/Toast.tsx'
import { formatBytes, formatRelative } from '@/lib/format.ts'
import { discardSharedBatch, peekSharedBatch, type SharedBatch } from '@/lib/shareInbox.ts'
import { enqueueUploads, whenSettled } from '@/state/uploads.ts'
import { AppFrame, SectionTitle } from './AppFrame.tsx'
import { newProjectName } from './home/useImport.ts'

type Load = { state: 'loading' } | { state: 'missing' } | { state: 'ready'; batch: SharedBatch }
const LOADING: Load = { state: 'loading' }
const MISSING: Load = { state: 'missing' }

/**
 * Landing page for media shared from other apps (Android share sheet → service worker →
 * IndexedDB). The user picks a new or existing project; uploads start immediately and the
 * editor places the clips on the timeline as they arrive.
 */
export function ShareTargetScreen() {
  const [params] = useSearchParams()
  const id = params.get('id')
  const navigate = useNavigate()
  const projects = useProjects()
  const create = useCreateProject()
  // Keyed by batch id so a different ?id= shows "loading" again without a reset effect.
  const [loaded, setLoaded] = useState<{ id: string; load: Load } | null>(null)
  const load: Load = !id ? MISSING : loaded?.id === id ? loaded.load : LOADING

  useEffect(() => {
    if (!id) return
    const ac = new AbortController()
    const settle = (next: Load) => {
      if (!ac.signal.aborted) setLoaded({ id, load: next })
    }
    peekSharedBatch(id)
      .then((batch) => settle(batch && batch.files.length ? { state: 'ready', batch } : MISSING))
      .catch(() => settle(MISSING))
    return () => ac.abort()
  }, [id])

  const importInto = async (projectId: string | null) => {
    if (load.state !== 'ready' || !id) return
    try {
      const target =
        projectId ?? (await create.mutateAsync({ name: load.batch.title || newProjectName() })).id
      const tasks = enqueueUploads(load.batch.files, { projectId: target, addToTimeline: true })
      // Keep the parked files until the uploads settle, so a crash mid-way can still recover.
      void whenSettled(tasks).then(() => discardSharedBatch(id))
      void navigate(`/p/${target}`, { replace: true })
    } catch (err) {
      toast.error('Could not import', err instanceof Error ? err.message : undefined)
    }
  }

  return (
    <AppFrame title="Add to ReelForge">
      {load.state === 'loading' ? (
        <div className="grid h-60 place-items-center">
          <Spinner size={28} />
        </div>
      ) : load.state === 'missing' ? (
        <EmptyState
          icon={<Inbox size={28} />}
          title="Nothing to import"
          description="The shared files were already imported or could not be received."
          action={
            <Button variant="primary" onClick={() => void navigate('/', { replace: true })}>
              Go to projects
            </Button>
          }
        />
      ) : (
        <>
          <SectionTitle>
            {load.batch.files.length} file{load.batch.files.length === 1 ? '' : 's'}
          </SectionTitle>
          <ul className="flex flex-col gap-2">
            {load.batch.files.map((f, i) => (
              <li
                key={`${f.name}-${i}`}
                className="flex min-h-12 items-center gap-3 rounded-2xl bg-surface px-4 py-2.5"
              >
                <FileVideo size={20} className="shrink-0 text-violet" />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <span className="text-xs text-muted tabular-nums">{formatBytes(f.size)}</span>
              </li>
            ))}
          </ul>
          <Button
            className="bg-magic mt-5 rounded-full"
            variant="primary"
            size="lg"
            block
            icon={<Plus size={20} />}
            loading={create.isPending}
            onClick={() => void importInto(null)}
          >
            New project
          </Button>
          {projects.data && projects.data.length > 0 && (
            <>
              <SectionTitle>Or add to a project</SectionTitle>
              <ul className="flex flex-col gap-2">
                {projects.data
                  .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                  .slice(0, 8)
                  .map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => void importInto(p.id)}
                        className="flex min-h-14 w-full items-center gap-3 rounded-2xl bg-surface px-4 py-2 text-left transition-colors hover:bg-surface-2"
                      >
                        <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
                        <span className="text-xs text-muted">{formatRelative(p.updatedAt)}</span>
                      </button>
                    </li>
                  ))}
              </ul>
            </>
          )}
        </>
      )}
    </AppFrame>
  )
}
