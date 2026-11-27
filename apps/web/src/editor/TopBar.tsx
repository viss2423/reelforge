import type { Job } from '@reelforge/core'
import { ChevronLeft, Upload } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { isActiveJob, useJobs } from '@/api/queries.ts'
import { AdaptiveModal } from '@/components/Dialog.tsx'
import { IconButton } from '@/components/IconButton.tsx'
import { ProgressRing } from '@/components/ProgressRing.tsx'
import { Spinner } from '@/components/Spinner.tsx'
import { cn } from '@/lib/cn.ts'
import { formatEta } from '@/lib/format.ts'
import { editorStore } from '@/state/editorStore.ts'
import { useProjectName, useSyncInfo } from '@/state/selectors.ts'
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
  matte: 'Separating subject',
  'music.suggest': 'Finding music',
  trends: 'Refreshing trends',
  highlights: 'Choosing best moments',
  copywriter: 'Writing copy',
  emphasis: 'Styling captions',
}

/**
 * Editable project name, styled as the screen title (tap to rename); commits on blur/Enter
 * as one undo step. The input sizes to its text (an invisible twin sets the width), so the
 * save dot sits right after the name.
 */
function ProjectName() {
  const name = useProjectName()
  const [draft, setDraft] = useState<string | null>(null)
  const value = draft ?? name
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
    <span className="relative inline-grid max-w-full min-w-0 shrink grid-cols-1">
      <span
        aria-hidden
        className="invisible col-start-1 row-start-1 overflow-hidden px-2 text-[17px] font-semibold whitespace-pre"
      >
        {value || ' '}
      </span>
      <input
        aria-label="Project name"
        title="Rename"
        value={value}
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
        className="col-start-1 row-start-1 h-10 w-full min-w-0 truncate rounded-xl bg-transparent px-2 text-[17px] font-semibold outline-none transition-colors hover:bg-surface-2 focus:bg-surface-2"
      />
    </span>
  )
}

/** Save state as a tiny mark after the title: dot (saved), spinner (saving), amber (problem). */
function SyncBadge() {
  const { status, error } = useSyncInfo()
  const problem = status === 'offline' || status === 'error'
  const saving = status === 'saving' || status === 'pending'
  const text = problem
    ? status === 'offline'
      ? 'Offline'
      : 'Not saved'
    : saving
      ? 'Saving'
      : status === 'saved'
        ? 'Saved'
        : ''
  return (
    <span
      role="status"
      title={problem ? (error ?? text) : text || undefined}
      className={cn(
        'flex shrink-0 items-center gap-1.5 text-xs',
        problem ? 'text-warning' : 'text-muted',
      )}
      data-testid="sync"
      data-status={status}
    >
      {saving ? (
        <Spinner size={12} />
      ) : (
        <span
          aria-hidden
          className={cn(
            'size-1.5 rounded-full transition-colors duration-300',
            problem ? 'bg-warning' : status === 'saved' ? 'bg-success/80' : 'bg-subtle',
          )}
        />
      )}
      {/* Problems say so in words; the calm states are a dot (read out to screen readers). */}
      <span className={problem ? 'max-sm:sr-only' : 'sr-only'}>{text}</span>
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

/**
 * Editor header: back, the project title (tap to rename) with its save mark, background
 * activity, and the screen's one primary action, Export. Undo/redo live in the transport.
 */
export function TopBar() {
  const navigate = useNavigate()
  const [exportOpen, setExportOpen] = useState(false)
  const s = editorStore.getState
  return (
    <header className="flex h-14 shrink-0 items-center gap-1 bg-canvas pr-2 pl-1 lg:bg-surface lg:pr-3">
      <IconButton
        label="Back to projects"
        icon={<ChevronLeft size={24} />}
        onClick={() => {
          // Leave immediately; the session keeps flushing in the background.
          void flushProject().catch(() => undefined)
          void navigate('/')
        }}
      />
      <div className="flex min-w-0 flex-1 items-center gap-0.5">
        <ProjectName />
        <SyncBadge />
      </div>
      <Activity />
      <button
        type="button"
        onClick={() => {
          s().setPlaying(false)
          setExportOpen(true)
        }}
        data-testid="export-open"
        className="shell-primary ml-1 inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full px-4 text-[15px] font-semibold"
      >
        <Upload size={16} strokeWidth={2.5} aria-hidden />
        Export
      </button>
      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />
    </header>
  )
}
