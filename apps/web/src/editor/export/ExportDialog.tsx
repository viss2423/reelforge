import type { ExportSettings, Job } from '@reelforge/core'
import {
  CircleAlert,
  Cpu,
  Download,
  Gauge,
  Gem,
  HardDriveDownload,
  Music,
  Share2,
  Sparkles,
  TrendingUp,
  X,
  Zap,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { api } from '@/api/index.ts'
import { useCancelJob, useJobs, useStartExport, useSystem } from '@/api/queries.ts'
import { Button } from '@/components/Button.tsx'
import { AdaptiveModal } from '@/components/Dialog.tsx'
import { ProgressRing } from '@/components/ProgressRing.tsx'
import { SegmentedControl } from '@/components/SegmentedControl.tsx'
import { toast } from '@/components/Toast.tsx'
import { ExportPlayer } from '@/exports/ExportResult.tsx'
import {
  canShareFiles,
  canStreamSave,
  exportFileName,
  saveExportToDisk,
  shareExport,
} from '@/exports/share.ts'
import { cn } from '@/lib/cn.ts'
import { formatBytes, formatDuration, formatEta } from '@/lib/format.ts'
import { editorStore } from '@/state/editorStore.ts'
import { useDuration, useEditor, useFps, useProjectName } from '@/state/selectors.ts'
import { mainMediaClips } from '../panels/model/draft.ts'
import { TrendingSounds } from '../panels/root/TrendingSounds.tsx'
import { Advanced, ChoiceTiles } from '../panels/ui.tsx'
import { flushProject } from '../session.ts'
import { useSoundPreview } from '../soundPreview.ts'
import { estimateExportBytes, loadExportSettings, saveExportSettings } from './estimate.ts'
import { MusicCredits } from './MusicCredits.tsx'

type Fps = NonNullable<ExportSettings['fps']>
type Music = NonNullable<ExportSettings['music']>
const FPS_OPTIONS: readonly Fps[] = [24, 25, 30, 50, 60]

/** The three one-tap qualities; Advanced still sets resolution and quality separately. */
const PRESETS = [
  {
    value: 'good',
    label: 'Good',
    icon: <Gauge size={20} />,
    resolution: '720p',
    quality: 'standard',
  },
  {
    value: 'best',
    label: 'Best',
    icon: <Sparkles size={20} />,
    resolution: '1080p',
    quality: 'high',
  },
  { value: 'max', label: 'Max', icon: <Gem size={20} />, resolution: '2160p', quality: 'max' },
] as const satisfies readonly {
  value: string
  label: string
  icon: ReactNode
  resolution: ExportSettings['resolution']
  quality: ExportSettings['quality']
}[]
type Preset = (typeof PRESETS)[number]['value']

const presetOf = (s: ExportSettings): Preset | '' =>
  PRESETS.find((p) => p.resolution === s.resolution && p.quality === s.quality)?.value ?? ''

const RESOLUTION_LABEL: Record<ExportSettings['resolution'], string> = {
  '720p': '720p',
  '1080p': '1080p',
  '1440p': '2K',
  '2160p': '4K',
}

/** First frame of the reel: the poster of the first clip on the main track. */
function Poster() {
  const assetId = useEditor((s) => {
    const c = s.project ? mainMediaClips(s.project)[0] : undefined
    const a = c ? s.assets[c.assetId] : undefined
    return a && a.kind !== 'audio' && a.thumbnails === 'ready' ? a.id : undefined
  })
  const [failed, setFailed] = useState(false)
  return (
    <span className="relative block aspect-[9/16] w-24 shrink-0 overflow-hidden rounded-2xl bg-surface-2 ring-1 ring-line">
      {assetId && !failed ? (
        <img
          src={api.posterUrl(assetId)}
          alt=""
          draggable={false}
          onError={() => setFailed(true)}
          className="absolute inset-0 size-full object-cover"
        />
      ) : (
        <span className="absolute inset-0 grid place-items-center text-subtle">
          <Sparkles size={22} />
        </span>
      )}
    </span>
  )
}

/** Export settings → live progress (WebSocket-driven) → download / share. */
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

  // After picking or previewing a trending sound the creator adds it in Instagram: "No music" is the
  // default until they choose.
  const soundPicked = useSoundPreview((s) => s.soundPicked)
  const [musicChoice, setMusicChoice] = useState<Music>()
  const music = musicChoice ?? (soundPicked ? 'none' : 'keep')

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
      const created = await start.mutateAsync({ projectId, settings: { ...settings, music } })
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
            className="panels-cta"
            loading={preparing}
            disabled={duration === 0}
            onClick={() => void run()}
            data-testid="export-start"
          >
            Export
            <span className="font-normal opacity-80 tabular-nums">
              · {RESOLUTION_LABEL[settings.resolution]} · ~{formatBytes(estimate)}
            </span>
          </Button>
        ) : job.status === 'done' || job.status === 'failed' ? (
          <Button block variant="ghost" onClick={() => setJobId(null)}>
            New export
          </Button>
        ) : undefined
      }
    >
      {showSettings ? (
        <div className="flex flex-col gap-5">
          <div className="flex items-center gap-4">
            <Poster />
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="truncate text-[17px] font-bold">{projectName || 'Your reel'}</p>
              <p className="text-sm text-muted tabular-nums">
                {formatDuration(duration)} · {RESOLUTION_LABEL[settings.resolution]} · {fps} fps
              </p>
              <p className="text-sm text-muted tabular-nums">~{formatBytes(estimate)}</p>
            </div>
          </div>

          <Field label="Quality">
            <ChoiceTiles<Preset | ''>
              label="Quality preset"
              value={presetOf(settings)}
              onChange={(v) => {
                const p = PRESETS.find((x) => x.value === v)
                if (p) setSettings((s) => ({ ...s, resolution: p.resolution, quality: p.quality }))
              }}
              options={PRESETS.map((p) => ({
                value: p.value,
                label: p.label,
                icon: p.icon,
                meta: `${RESOLUTION_LABEL[p.resolution]} · ~${formatBytes(
                  estimateExportBytes(
                    { ...settings, resolution: p.resolution, quality: p.quality },
                    fps,
                    duration,
                  ),
                  0,
                )}`,
              }))}
            />
          </Field>

          <Field label="Music">
            <ChoiceTiles<Music>
              label="Music"
              value={music}
              onChange={setMusicChoice}
              options={[
                { value: 'keep', label: 'Free track baked in', icon: <Music size={20} /> },
                {
                  value: 'none',
                  label: 'Add trending sound in Instagram',
                  icon: <TrendingUp size={20} />,
                },
              ]}
            />
            <p className="mt-2 text-xs text-muted" data-testid="export-music-hint">
              {music === 'none'
                ? 'Exports without music (voice and effects stay): add the sound in Instagram when you post.'
                : 'Your royalty-free music is mixed into the video.'}
            </p>
          </Field>
          {music === 'none' && <TrendingSounds compact />}

          <MusicCredits />

          <Advanced id="export">
            <Field label="Resolution">
              <SegmentedControl<ExportSettings['resolution']>
                label="Resolution"
                size="sm"
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
            <Field label="Bitrate">
              <SegmentedControl<ExportSettings['quality']>
                label="Bitrate"
                size="sm"
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
            <Field label="Frame rate">
              <SegmentedControl<Fps>
                label="Frame rate"
                size="sm"
                value={fps}
                onChange={(v) => set('fps', v === projectFps ? undefined : v)}
                options={FPS_OPTIONS.map((f) => ({ value: f, label: String(f) }))}
              />
            </Field>
            <Field label="Codec">
              <SegmentedControl<ExportSettings['codec']>
                label="Codec"
                size="sm"
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
                size="sm"
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
                <span className="block text-[15px]">Normalize loudness</span>
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
          </Advanced>
        </div>
      ) : job.status === 'done' ? (
        <div className="flex flex-col items-center gap-4" data-testid="export-done">
          <ExportPlayer job={job} className="max-h-[42vh] w-auto" />
          <DoneActions job={job} projectName={projectName} />
          <MusicCredits />
        </div>
      ) : job.status === 'failed' ? (
        <p
          className="flex gap-2 rounded-2xl bg-danger/10 p-3 text-danger"
          data-testid="export-failed"
        >
          <CircleAlert size={18} className="mt-0.5 shrink-0" />
          {job.error ?? 'Export failed'}
        </p>
      ) : (
        <Progress job={job} />
      )}
    </AdaptiveModal>
  )
}

/** A big ring with the percentage, the time left and Cancel. */
function Progress({ job }: { job: Job }) {
  const cancel = useCancelJob()
  const queued = job.status === 'queued'
  const pct = Math.round(job.progress * 100)
  const eta = formatEta(job.eta)
  return (
    <div className="flex flex-col items-center gap-3 py-4 text-center">
      <span className="relative grid place-items-center">
        <ProgressRing
          value={queued ? undefined : job.progress}
          size={132}
          stroke={8}
          label="Export progress"
          className="text-accent"
        />
        {!queued && (
          <span className="absolute text-3xl font-bold tabular-nums" aria-hidden>
            {pct}%
          </span>
        )}
      </span>
      <div className="flex flex-col gap-0.5">
        <p className="text-[17px] font-semibold">{queued ? 'Waiting to start…' : 'Exporting…'}</p>
        <p className="min-h-5 text-sm text-muted tabular-nums">{eta || job.message || ' '}</p>
      </div>
      <Button
        variant="ghost"
        icon={<X size={16} />}
        loading={cancel.isPending}
        onClick={() => cancel.mutate(job.id)}
      >
        Cancel
      </Button>
      <p className="text-xs text-muted">You can close this. It keeps going and lands in Exports.</p>
    </div>
  )
}

/** Download and Share (or Save to device) as two big buttons. */
function DoneActions({ job, projectName }: { job: Job; projectName: string }) {
  const [busy, setBusy] = useState<'share' | 'save' | null>(null)
  const name = exportFileName(projectName, job.id)
  const share = canShareFiles()
  const save = !share && canStreamSave()
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
  const big = 'h-14 flex-1 rounded-2xl text-base'
  return (
    <div className="flex w-full gap-2">
      <a
        href={api.exportFileUrl(job.id, true)}
        download={name}
        data-testid="export-download"
        className={cn(
          'inline-flex items-center justify-center gap-2 font-semibold',
          big,
          share || save
            ? 'bg-surface-2 text-fg ring-1 ring-line'
            : 'panels-cta bg-accent text-accent-fg',
        )}
      >
        <Download size={20} />
        Download
      </a>
      {share && (
        <Button
          variant="primary"
          className={cn('panels-cta', big)}
          icon={<Share2 size={20} />}
          loading={busy === 'share'}
          onClick={() => void run('share')}
        >
          Share
        </Button>
      )}
      {save && (
        <Button
          variant="primary"
          className={cn('panels-cta', big)}
          icon={<HardDriveDownload size={20} />}
          loading={busy === 'save'}
          onClick={() => void run('save')}
        >
          Save
        </Button>
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-[13px] font-semibold tracking-wide text-muted uppercase">{label}</p>
      {children}
    </div>
  )
}
