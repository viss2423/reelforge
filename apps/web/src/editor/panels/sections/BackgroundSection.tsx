/**
 * AI background: remove, blur, or replace (colour / image) the background behind the
 * subject of a video or photo. The host separates the subject once per asset (`matte` job,
 * cached); the preview and the export then apply the chosen background live.
 */
import type { Asset, BackgroundMode, MediaClip } from '@reelforge/core'
import {
  AlertTriangle,
  Ban,
  Check,
  Droplet,
  Image as ImageIcon,
  Palette,
  RefreshCw,
  UserRoundX,
  X,
} from 'lucide-react'
import { api } from '@/api/index.ts'
import { Button } from '@/components/Button.tsx'
import { ProgressRing } from '@/components/ProgressRing.tsx'
import { Slider } from '@/components/Slider.tsx'
import { useAssetsMap, useEditor } from '@/state/selectors.ts'
import { edit, gesture } from '../model/commands.ts'
import { DEFAULT_BACKGROUND, setBackground } from '../model/edits.ts'
import { matteJobs, useMatteJob, type MatteModel } from '../model/matteJobs.ts'
import {
  Advanced,
  ChoiceTiles,
  Gallery,
  Hint,
  Section,
  SwatchPicker,
  Tile,
  type ChoiceOption,
} from '../ui.tsx'

const MODES: readonly ChoiceOption<BackgroundMode>[] = [
  { value: 'keep', label: 'Off', icon: <Ban size={22} /> },
  { value: 'blur', label: 'Blur', icon: <Droplet size={22} /> },
  { value: 'color', label: 'Colour', icon: <Palette size={22} /> },
  { value: 'image', label: 'Image', icon: <ImageIcon size={22} /> },
  { value: 'remove', label: 'Remove', icon: <UserRoundX size={22} /> },
]

/** Matte state of an asset for the UI. */
export const matteState = (
  asset: Asset | undefined,
  job: { status: 'running' | 'error' } | undefined,
): 'none' | 'running' | 'ready' | 'failed' => {
  if (job?.status === 'running' || asset?.matte?.status === 'processing') return 'running'
  if (job?.status === 'error') return 'failed'
  if (asset?.matte?.status === 'ready') return 'ready'
  if (asset?.matte?.status === 'failed') return 'failed'
  return 'none'
}

function MatteStatus({ clip, asset }: { clip: MediaClip; asset: Asset | undefined }) {
  const job = useMatteJob(clip.assetId)
  const projectId = useEditor((s) => s.project?.id)
  const state = matteState(asset, job)
  const model: MatteModel = 'modnet'
  const start = (m: MatteModel, force = false) =>
    matteJobs.start(clip.assetId, m, { ...(projectId ? { projectId } : {}), force })
  if (state === 'running') {
    return (
      <div
        className="flex items-center gap-3 rounded-2xl bg-surface-2 py-2 pr-2 pl-3"
        role="status"
      >
        <ProgressRing
          value={job?.progress}
          label="Separating subject"
          showLabel
          className="text-accent"
        />
        <p className="flex-1 text-sm">Finding the subject…</p>
        <Button
          size="sm"
          variant="secondary"
          icon={<X size={16} />}
          onClick={() => matteJobs.cancel(clip.assetId)}
        >
          Cancel
        </Button>
      </div>
    )
  }
  if (state === 'failed') {
    return (
      <div className="flex flex-col gap-2 rounded-2xl bg-danger/10 p-3" role="alert">
        <p className="flex items-start gap-2 text-sm text-danger">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          {job?.error ?? 'Subject separation failed.'}
        </p>
        <Button size="sm" icon={<RefreshCw size={16} />} onClick={() => start(model, true)}>
          Try again
        </Button>
      </div>
    )
  }
  return state === 'none' ? (
    <Button block onClick={() => start(model)}>
      Separate subject
    </Button>
  ) : (
    <p className="flex items-center gap-1.5 text-sm text-muted">
      <Check size={16} className="text-success" />
      Subject separated.
    </p>
  )
}

function ImagePicker({ clip, value }: { clip: MediaClip; value: string | undefined }) {
  const assets = useAssetsMap()
  const images = Object.values(assets).filter((a) => a.kind === 'image' && a.id !== clip.assetId)
  if (images.length === 0)
    return <Hint>Upload a photo to your media to use it as the background.</Hint>
  return (
    <Gallery label="Background image">
      {images.map((a) => (
        <Tile
          key={a.id}
          label={a.name}
          selected={a.id === value}
          aspect="portrait"
          onClick={() =>
            edit('Background image', (d) => setBackground(d, clip.id, { assetId: a.id }))
          }
        >
          <img
            src={api.posterUrl(a.id)}
            alt=""
            className="size-full object-cover"
            draggable={false}
          />
        </Tile>
      ))}
    </Gallery>
  )
}

export function BackgroundSection({ clip }: { clip: MediaClip }) {
  const assets = useAssetsMap()
  const asset = assets[clip.assetId]
  const bg = clip.background ?? DEFAULT_BACKGROUND
  const job = useMatteJob(clip.assetId)
  const projectId = useEditor((s) => s.project?.id)
  const setMode = (mode: BackgroundMode) => {
    edit('Background', (d) => setBackground(d, clip.id, { mode }))
    // First use: separate the subject right away with the fast model.
    if (mode !== 'keep' && matteState(asset, job) === 'none')
      matteJobs.start(clip.assetId, 'modnet', projectId ? { projectId } : {})
  }
  return (
    <Section title="Background">
      <ChoiceTiles
        label="Background"
        options={MODES}
        value={bg.mode}
        onChange={setMode}
        size="sm"
      />
      {bg.mode !== 'keep' && (
        <>
          <MatteStatus clip={clip} asset={asset} />
          {bg.mode === 'blur' && (
            <Slider
              label="Blur"
              value={bg.blur}
              min={0}
              max={100}
              step={1}
              defaultValue={DEFAULT_BACKGROUND.blur}
              {...gesture<number>('Background blur', (d, blur) =>
                setBackground(d, clip.id, { blur }),
              )}
            />
          )}
          {bg.mode === 'color' && (
            <SwatchPicker
              label="Background colour"
              value={bg.color}
              {...gesture<string>('Background colour', (d, color) =>
                setBackground(d, clip.id, { color }),
              )}
            />
          )}
          {bg.mode === 'image' && <ImagePicker clip={clip} value={bg.assetId} />}
          <Advanced id="background">
            <Slider
              label="Edge softness"
              value={bg.feather}
              min={0}
              max={100}
              step={1}
              defaultValue={DEFAULT_BACKGROUND.feather}
              {...gesture<number>('Edge softness', (d, feather) =>
                setBackground(d, clip.id, { feather }),
              )}
            />
          </Advanced>
        </>
      )}
    </Section>
  )
}
