import type { Job } from '@reelforge/core'
import { Download, HardDriveDownload, Share2, X } from 'lucide-react'
import { useState } from 'react'
import { api } from '@/api/index.ts'
import { useCancelJob } from '@/api/queries.ts'
import { Button } from '@/components/Button.tsx'
import { ProgressRing } from '@/components/ProgressRing.tsx'
import { toast } from '@/components/Toast.tsx'
import { cn } from '@/lib/cn.ts'
import { formatEta } from '@/lib/format.ts'
import {
  canShareFiles,
  canStreamSave,
  exportFileName,
  saveExportToDisk,
  shareExport,
} from './share.ts'

/** Download / Share / Save actions for a finished export. */
export function ExportActions({
  job,
  projectName,
}: {
  job: Job
  projectName?: string | undefined
}) {
  const [busy, setBusy] = useState<'share' | 'save' | null>(null)
  const name = exportFileName(projectName, job.id)
  const share = canShareFiles()
  const save = canStreamSave()

  const run = async (kind: 'share' | 'save') => {
    setBusy(kind)
    try {
      const ok =
        kind === 'share' ? await shareExport(job.id, name) : await saveExportToDisk(job.id, name)
      if (ok && kind === 'save') toast.success('Saved', name)
    } catch (err) {
      toast.error(
        kind === 'share' ? 'Could not share' : 'Could not save',
        err instanceof Error ? err.message : undefined,
      )
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      {share && (
        <Button
          variant="primary"
          icon={<Share2 size={18} />}
          loading={busy === 'share'}
          onClick={() => void run('share')}
        >
          Share
        </Button>
      )}
      {save && (
        <Button
          icon={<HardDriveDownload size={18} />}
          loading={busy === 'save'}
          onClick={() => void run('save')}
        >
          Save to device
        </Button>
      )}
      <a
        href={api.exportFileUrl(job.id, true)}
        download={name}
        data-testid="export-download"
        className={cn(
          'inline-flex h-11 items-center gap-2 rounded-xl px-4 font-semibold',
          share ? 'border border-line bg-surface-2' : 'bg-accent text-accent-fg',
        )}
      >
        <Download size={18} />
        Download
      </a>
    </div>
  )
}

/** Inline player for a finished export (streams via HTTP Range; metadata only until played). */
export function ExportPlayer({ job, className }: { job: Job; className?: string }) {
  return (
    <video
      src={api.exportFileUrl(job.id)}
      controls
      playsInline
      preload="metadata"
      className={cn('aspect-[9/16] w-full rounded-card bg-black object-contain', className)}
    />
  )
}

/** Live progress for a queued/running export, with cancel. */
export function ExportProgress({ job }: { job: Job }) {
  const cancel = useCancelJob()
  const queued = job.status === 'queued'
  return (
    <div className="flex items-center gap-3">
      <ProgressRing
        value={queued ? undefined : job.progress}
        size={48}
        label="Export progress"
        showLabel
        className="text-accent"
      />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{queued ? 'Waiting to start…' : 'Exporting…'}</p>
        <p className="truncate text-sm text-muted">
          {[job.message, formatEta(job.eta)].filter(Boolean).join(' · ') || ' '}
        </p>
      </div>
      <Button
        size="sm"
        variant="ghost"
        icon={<X size={16} />}
        loading={cancel.isPending}
        onClick={() => cancel.mutate(job.id)}
      >
        Cancel
      </Button>
    </div>
  )
}
