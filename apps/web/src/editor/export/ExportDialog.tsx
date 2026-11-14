import type { ExportSettings } from '@reelforge/core'
import { CircleAlert, Cpu, Zap } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useJobs, useStartExport, useSystem } from '@/api/queries.ts'
import { Button } from '@/components/Button.tsx'
import { AdaptiveModal } from '@/components/Dialog.tsx'
import { SegmentedControl } from '@/components/SegmentedControl.tsx'
import { toast } from '@/components/Toast.tsx'
import { ExportActions, ExportPlayer, ExportProgress } from '@/exports/ExportResult.tsx'
import { formatBytes } from '@/lib/format.ts'
import { editorStore } from '@/state/editorStore.ts'
import { useDuration, useFps, useProjectName } from '@/state/selectors.ts'
import { flushProject } from '../session.ts'
import { estimateExportBytes, loadExportSettings, saveExportSettings } from './estimate.ts'

type Fps = NonNullable<ExportSettings['fps']>
const FPS_OPTIONS: readonly Fps[] = [24, 25, 30, 50, 60]

/** Export settings → live progress (WebSocket-driven) → play / share / download. */
export function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [settings, setSettings] = useState<ExportSettings>(loadExportSettings)
  const [jobId, setJobId] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const job = useJobs((l) => (jobId ? l.find((j) => j.id === jobId) : undefined)).data
  const start = useStartExport()
  const system = useSystem()
  const duration = useDuration()
  const projectFps = useFps()
  const projectName = useProjectName()
  const fps = settings.fps ?? projectFps
  const gpu = system.data?.hwEncoders?.[settings.codec]
  const estimate = estimateExportBytes(settings, fps, duration)

  const set = <K extends keyof ExportSettings>(k: K, v: ExportSettings[K]) =>
    setSettings((s) => ({ ...s, [k]: v }))

  const run = async () => {
    const projectId = editorStore.getState().project?.id
    if (!projectId) return
    setPreparing(true)
    try {
      // The host renders what it has stored: make sure it has every edit first.
      await flushProject()
      saveExportSettings(settings)
      const created = await start.mutateAsync({ projectId, settings })
      setJobId(created.id)
    } catch (err) {
      toast.error('Could not start the export', err instanceof Error ? err.message : undefined)
    } finally {
      setPreparing(false)
    }
  }

  const close = () => {
    onClose()
    // Keep a finished/running job visible if reopened soon; a fresh dialog starts at settings.
    if (job && (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled'))
      setJobId(null)
  }

  const showSettings = !job || job.status === 'cancelled'

  return (
    <AdaptiveModal
      open={open}
      onClose={close}
      title="Export"
      locked={preparing}
      footer={
        showSettings ? (
          <Button
            block
            size="lg"
            variant="primary"
            loading={preparing}
            disabled={duration === 0}
            onClick={() => void run()}
            data-testid="export-start"
          >
            Export {settings.resolution}
          </Button>
        ) : job.status === 'done' || job.status === 'failed' ? (
          <Button block onClick={() => setJobId(null)}>
            New export
          </Button>
        ) : undefined
      }
    >
      {showSettings ? (
        <div className="flex flex-col gap-4">
          <Field label="Resolution">
            <SegmentedControl<ExportSettings['resolution']>
              label="Resolution"
              value={settings.resolution}
              onChange={(v) => set('resolution', v)}
              options={[
                { value: '720p', label: '720p' },
                { value: '1080p', label: '1080p' },
                { value: '1440p', label: '2K' },
                { value: '2160p', label: '4K' },
              ]}
            />
          </Field>
          <Field label="Frame rate">
            <SegmentedControl<Fps>
              label="Frame rate"
              value={fps}
              onChange={(v) => set('fps', v === projectFps ? undefined : v)}
              options={FPS_OPTIONS.map((f) => ({ value: f, label: String(f) }))}
            />
          </Field>
          <Field label="Quality">
            <SegmentedControl<ExportSettings['quality']>
              label="Quality"
              value={settings.quality}
              onChange={(v) => set('quality', v)}
              options={[
                { value: 'draft', label: 'Draft' },
                { value: 'standard', label: 'Good' },
                { value: 'high', label: 'High' },
                { value: 'max', label: 'Max' },
              ]}
            />
          </Field>
          <Field label="Codec">
            <SegmentedControl<ExportSettings['codec']>
              label="Codec"
              value={settings.codec}
              onChange={(v) => set('codec', v)}
              options={[
                { value: 'h264', label: 'H.264' },
                { value: 'hevc', label: 'HEVC' },
                { value: 'av1', label: 'AV1' },
              ]}
            />
          </Field>
          <Field label="Encoder">
            <SegmentedControl<ExportSettings['encoder']>
              label="Encoder"
              value={settings.encoder}
              onChange={(v) => set('encoder', v)}
              options={[
                { value: 'auto', label: 'Auto' },
                { value: 'gpu', label: 'GPU', disabled: system.isSuccess && !gpu },
                { value: 'cpu', label: 'CPU' },
              ]}
            />
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted">
              {gpu ? <Zap size={14} className="text-warning" /> : <Cpu size={14} />}
              {gpu ? `GPU encoding available (${gpu})` : 'This codec encodes on the CPU (slower)'}
            </p>
          </Field>
          <label className="flex min-h-11 items-center justify-between gap-3">
            <span>
              <span className="block text-sm font-semibold">Normalize loudness</span>
              <span className="block text-xs text-muted">
                {settings.loudnessTarget} LUFS, like Reels and TikTok
              </span>
            </span>
            <input
              type="checkbox"
              className="size-5 accent-[var(--rf-accent)]"
              checked={settings.normalizeLoudness}
              onChange={(e) => set('normalizeLoudness', e.target.checked)}
            />
          </label>
          <p className="rounded-xl bg-surface-2 px-3 py-2 text-sm">
            Estimated size <b className="tabular-nums">~{formatBytes(estimate)}</b>
          </p>
        </div>
      ) : job.status === 'done' ? (
        <div className="flex flex-col items-center gap-4" data-testid="export-done">
          <ExportPlayer job={job} className="max-h-[50vh] w-auto" />
          <ExportActions job={job} projectName={projectName} />
        </div>
      ) : job.status === 'failed' ? (
        <p className="flex gap-2 text-danger">
          <CircleAlert size={18} className="mt-0.5 shrink-0" />
          {job.error ?? 'Export failed'}
        </p>
      ) : (
        <div className="py-4">
          <ExportProgress job={job} />
          <p className="mt-4 text-xs text-muted">
            You can close this — the host keeps rendering and you'll get a notification. Finished
            exports are under Exports on every device.
          </p>
        </div>
      )}
    </AdaptiveModal>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-sm font-semibold">{label}</p>
      {children}
    </div>
  )
}
