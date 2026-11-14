import type { Asset, Job } from '@reelforge/core'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useNavigate } from 'react-router'
import { events } from '@/api/index.ts'
import { applyServerEvent, qk, refetchAfterReconnect, upsertById } from '@/api/queries.ts'
import { toast } from '@/components/Toast.tsx'
import { editorStore } from '@/state/editorStore.ts'
import { onAssetUploaded } from '@/state/uploads.ts'

/**
 * Connects the realtime socket for the signed-in app and folds every server event into
 * the query cache (and the open editor's asset map), so screens never poll. Renders nothing.
 */
export function Realtime() {
  const qc = useQueryClient()
  const navigate = useNavigate()

  useEffect(() => {
    events.start()
    const offAny = events.onAny((e) => {
      if (e.type === 'job' && e.job.kind === 'export')
        notifyExport(qc, e.job, () => void navigate('/exports'))
      applyServerEvent(qc, e)
      if (e.type === 'asset' && editorStore.getState().project)
        editorStore.getState().upsertAsset(e.asset)
    })
    const offReconnect = events.onReconnect(() => refetchAfterReconnect(qc))
    const offUploaded = onAssetUploaded((asset) => {
      qc.setQueryData<Asset[]>(qk.assets, (l) => upsertById(l, asset))
      if (editorStore.getState().project) editorStore.getState().upsertAsset(asset)
    })
    return () => {
      offAny()
      offReconnect()
      offUploaded()
      events.stop()
    }
  }, [qc, navigate])

  return null
}

/** Toasts once when an export finishes or fails (compares with the cached job state). */
const notifyExport = (qc: ReturnType<typeof useQueryClient>, job: Job, open: () => void): void => {
  const prev = qc.getQueryData<Job[]>(qk.jobs)?.find((j) => j.id === job.id)
  if (prev?.status === job.status) return
  if (job.status === 'done') {
    toast('Export ready', { tone: 'success', action: { label: 'View', onClick: open } })
  } else if (job.status === 'failed') {
    toast.error('Export failed', job.error)
  }
}
