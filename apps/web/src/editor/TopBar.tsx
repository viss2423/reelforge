import type { Job } from '@reelforge/core'
import { ChevronLeft, Cloud, CloudOff, Redo2, Undo2, Upload } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { isActiveJob, useJobs } from '@/api/queries.ts'
import { Button } from '@/components/Button.tsx'
import { AdaptiveModal } from '@/components/Dialog.tsx'
import { IconButton } from '@/components/IconButton.tsx'
import { ProgressRing } from '@/components/ProgressRing.tsx'
import { Spinner } from '@/components/Spinner.tsx'
import { formatEta } from '@/lib/format.ts'
import { editorStore } from '@/state/editorStore.ts'
import { useHistoryFlags, useProjectName, useSyncInfo } from '@/state/selectors.ts'
import { useUploads } from '@/state/uploads.ts'
import { ExportDialog } from './export/ExportDialog.tsx'
import { flushProject } from './session.ts'

const JOB_LABEL: Record<Job['kind'], string> = {
  probe: 'Reading media',
  proxy: 'Optimizing for preview',
  thumbnails: 'Making thumbnails',
  waveform: 'Analyzing audio',
  export: 'Exporting',
  transcribe: 'Transcribing',
  silence: 'Finding silences',
  beats: 'Detecting beats',
  scenes: 'Detecting scenes',
  reframe: 'Auto-reframing',
  denoise: 'Cleaning audio',
  preview: 'Rendering preview',
}

/** Editable project name; commits on blur/Enter as one undo step. */
function ProjectName() {
  const name = useProjectName()
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    const next = draft?.trim()
    setDraft(null)
    if (next && next !== name) {
      editorStore.getState().dispatch('Rename project', (d) => {
        d.name = next.slice(0, 200)
      })
    }
  }
  return (
    <input
      aria-label="Project name"
      value={draft ?? name}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          setDraft(null)
          requestAnimationFrame(() => (e.target as HTMLInputElement).blur())
        }
      }}
      maxLength={200}
      className="h-9 w-full min-w-0 truncate rounded-lg bg-transparent px-2 font-semibold outline-none hover:bg-surface-2 focus:bg-surface-2"
    />
  )
}

function SyncBadge() {
  const { status, error } = useSyncInfo()
  if (status === 'offline' || status === 'error') {
    return (
      <span
        title={error ?? undefined}
        className="flex items-center gap-1 text-xs text-warning"
        data-testid="sync"
        data-status={status}
      >
        <CloudOff size={16} />
        <span className="hidden sm:inline">{status === 'offline' ? 'Offline' : 'Not saved'}</span>
      </span>
    )
  }
  if (status === 'saving' || status === 'pending') {
    return (
      <span
        className="flex items-center gap-1 text-xs text-muted"
        aria-live="polite"
        data-testid="sync"
        data-status={status}
      >
        <Spinner size={14} />
        <span className="hidden sm:inline">Saving</span>
      </span>
    )
  }
  return (
    <span
      className="flex items-center gap-1 text-xs text-subtle"
      data-testid="sync"
      data-status={status}
    >
      <Cloud size={16} />
      <span className="hidden sm:inline">{status === 'saved' ? 'Saved' : ''}</span>
    </span>
  )
}

/** Host jobs + uploads in flight; tap for details. */
function Activity() {
  const jobs = useJobs((l) => l.filter(isActiveJob)).data ?? []
  const uploads = useUploads((s) => s.tasks).filter(
    (t) => t.status === 'uploading' || t.status === 'queued',
  )
  const [open, setOpen] = useState(false)
  const count = jobs.length + uploads.length
  if (count === 0) return null
  const progress =
    (jobs.reduce((s, j) => s + j.progress, 0) +
      uploads.reduce((s, u) => s + (u.size ? u.loaded / u.size : 0), 0)) /
    count
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`${count} task${count === 1 ? '' : 's'} running`}
        className="touch-target relative grid place-items-center text-accent"
        data-testid="activity"
      >
        <ProgressRing value={progress} size={28} stroke={3} label="Background tasks" />
        <span className="absolute text-[10px] font-bold text-fg">{count}</span>
      </button>
      <AdaptiveModal
        open={open}
        onClose={() => setOpen(false)}
        title="Working on it"
        snapPoints={[0.5]}
      >
        <ul className="flex flex-col gap-3">
          {uploads.map((u) => (
            <li key={u.id} className="flex items-center gap-3">
              <ProgressRing
                value={u.size ? u.loaded / u.size : undefined}
                size={32}
                stroke={3}
                label="Upload"
                className="text-accent"
              />
              <span className="min-w-0 flex-1 truncate text-sm">Uploading {u.name}</span>
            </li>
          ))}
          {jobs.map((j) => (
            <li key={j.id} className="flex items-center gap-3">
              <ProgressRing
                value={j.status === 'queued' ? undefined : j.progress}
                size={32}
                stroke={3}
                label={JOB_LABEL[j.kind]}
                className="text-violet"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{JOB_LABEL[j.kind]}</span>
                <span className="block truncate text-xs text-muted">
                  {j.status === 'queued'
                    ? 'Queued'
                    : [j.message, formatEta(j.eta)].filter(Boolean).join(' · ')}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </AdaptiveModal>
    </>
  )
}

/** Editor header: back, name, save state, undo/redo, activity, Export. */
export function TopBar() {
  const navigate = useNavigate()
  const history = useHistoryFlags()
  const [exportOpen, setExportOpen] = useState(false)
  const s = editorStore.getState
  return (
    <header className="flex h-14 shrink-0 items-center gap-1 border-b border-line bg-surface px-1 sm:px-2">
      <IconButton
        label="Back to projects"
        icon={<ChevronLeft size={24} />}
        onClick={() => {
          // Leave immediately; the session keeps flushing in the background.
          void flushProject().catch(() => undefined)
          void navigate('/')
        }}
      />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <ProjectName />
        <SyncBadge />
      </div>
      <Activity />
      <IconButton
        label={history.undoLabel ? `Undo ${history.undoLabel}` : 'Undo'}
        icon={<Undo2 size={20} />}
        disabled={!history.canUndo}
        onClick={() => s().undo()}
      />
      <IconButton
        label={history.redoLabel ? `Redo ${history.redoLabel}` : 'Redo'}
        icon={<Redo2 size={20} />}
        disabled={!history.canRedo}
        onClick={() => s().redo()}
      />
      <Button
        variant="primary"
        size="sm"
        className="ml-1"
        icon={<Upload size={16} />}
        onClick={() => {
          s().setPlaying(false)
          setExportOpen(true)
        }}
        data-testid="export-open"
      >
        Export
      </Button>
      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />
    </header>
  )
}
