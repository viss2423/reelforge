/**
 * Editor session: loads a project into the editor store and keeps it saved and in sync
 * with other devices for as long as the editor is open.
 */
import type { Asset, Project } from '@reelforge/core'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, deviceId, events } from '@/api/index.ts'
import { qk, useAssets } from '@/api/queries.ts'
import { toast } from '@/components/Toast.tsx'
import { editorStore } from '@/state/editorStore.ts'
import { createProjectSync, type ProjectSync, type SyncNotice } from '@/state/sync.ts'

let current: ProjectSync | null = null

/**
 * Makes sure the host has every local edit (e.g. before exporting or running an AI job on
 * the project). Resolves immediately when nothing is pending or no editor is open.
 */
export const flushProject = (): Promise<void> => current?.flush() ?? Promise.resolve()

/** True while local edits have not reached the host yet. */
export const hasPendingChanges = (): boolean => current?.pending ?? false

const NOTICES: Record<SyncNotice, string | null> = {
  'remote-applied': null,
  merged: 'Merged changes from another device',
  'local-discarded': 'Another device changed this project — your last edits were replaced',
  'draft-restored': 'Recovered unsaved edits',
}

export type SessionState =
  { status: 'loading' } | { status: 'error'; error: Error } | { status: 'ready'; projectId: string }

/**
 * Opens `projectId` in the editor store. The project is fetched once; after that the store
 * is the source of truth and the sync engine (autosave + live sync) keeps the host in step.
 */
export const useProjectSession = (projectId: string): SessionState => {
  const query = useQuery({
    queryKey: qk.project(projectId),
    queryFn: ({ signal }) => api.project(projectId, signal),
    // The editor owns the project once loaded; background refetches would fight local edits.
    // Dropped when the editor closes so reopening always starts from the host's latest.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
  const qc = useQueryClient()
  const assets = useAssets()
  const [readyId, setReadyId] = useState<string | null>(null)
  const loaded: Project | undefined = query.data

  useEffect(() => {
    if (!loaded) return
    editorStore.getState().load(loaded, qc.getQueryData<Asset[]>(qk.assets) ?? [])
    const sync = createProjectSync({
      store: editorStore,
      api,
      deviceId: deviceId(),
      onNotice: (n) => {
        const msg = NOTICES[n]
        if (msg) toast(msg)
      },
    })
    current = sync
    void sync.recoverDraft()
    const offProject = events.on('project', (e) => {
      if (e.projectId === projectId) void sync.onRemoteRevision(e.revision, e.origin)
    })
    // Missed events while disconnected: ask for the latest revision on reconnect.
    const offReconnect = events.onReconnect(
      () => void sync.onRemoteRevision(Number.MAX_SAFE_INTEGER, ''),
    )
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (sync.pending) e.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    // "Ready" means the sync engine above is attached, which only this effect knows.
    // oxlint-disable-next-line react/set-state-in-effect
    setReadyId(loaded.id)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      offProject()
      offReconnect()
      if (current === sync) current = null
      setReadyId(null)
      // Push the last edits before closing; the project stays in the store until then (the
      // sync engine ignores it once another project is loaded). Anything still unsent is
      // persisted as a draft by dispose() and recovered next time.
      const finish = () => {
        sync.dispose()
        if (editorStore.getState().project?.id === projectId) editorStore.getState().unload()
      }
      if (sync.pending)
        void sync
          .flush()
          .catch(() => undefined)
          .finally(finish)
      else finish()
    }
  }, [loaded, projectId, qc])

  // Asset metadata (proxy ready, probe results…) changes independently of the project.
  useEffect(() => {
    if (assets.data && editorStore.getState().project) editorStore.getState().setAssets(assets.data)
  }, [assets.data, readyId])

  if (query.isError) return { status: 'error', error: query.error }
  if (readyId === projectId) return { status: 'ready', projectId }
  return { status: 'loading' }
}
