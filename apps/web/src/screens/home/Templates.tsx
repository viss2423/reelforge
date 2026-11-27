import type { Asset } from '@reelforge/core'
import { Check, Flame, ImagePlus, LayoutTemplate, Music, Sparkles } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { api } from '@/api/index.ts'
import { useAssets, useCreateProject, usePacks, useTrends } from '@/api/queries.ts'
import { Button } from '@/components/Button.tsx'
import { AdaptiveModal } from '@/components/Dialog.tsx'
import { FileButton } from '@/components/FileButton.tsx'
import { ProgressRing } from '@/components/ProgressRing.tsx'
import { Skeleton } from '@/components/Skeleton.tsx'
import { toast } from '@/components/Toast.tsx'
import { cn } from '@/lib/cn.ts'
import { formatDuration } from '@/lib/format.ts'
import { listTemplates, type TemplateEntry } from '@/lib/packs.ts'
import { enqueueUploads, useUploads } from '@/state/uploads.ts'
import { SectionTitle } from '../AppFrame.tsx'

/** Horizontally scrolling, trend-sorted template cards. Hidden when no pack has templates. */
export function TemplateCarousel() {
  const packs = usePacks()
  const trends = useTrends()
  const templates = useMemo(() => listTemplates(packs.data, trends.data), [packs.data, trends.data])
  const [chosen, setChosen] = useState<TemplateEntry | null>(null)

  if (packs.isPending) {
    return (
      <>
        <SectionTitle>Trending templates</SectionTitle>
        <div className="flex gap-3 overflow-hidden">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="aspect-[9/16] w-32 shrink-0" />
          ))}
        </div>
      </>
    )
  }
  if (templates.length === 0) return null

  return (
    <>
      <SectionTitle>Trending templates</SectionTitle>
      <ul
        className="-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-1"
        data-testid="template-carousel"
      >
        {templates.map((t) => (
          <li key={t.ref} className="w-32 shrink-0 snap-start sm:w-36">
            <button
              type="button"
              onClick={() => setChosen(t)}
              className="block w-full text-left"
              aria-label={`Use template ${t.template.name}`}
            >
              <div className="relative aspect-[9/16] overflow-hidden rounded-card border border-line bg-gradient-to-br from-violet/40 to-accent/40">
                {t.thumbPath ? (
                  <img
                    src={api.packFileUrl(t.thumbPath)}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="absolute inset-0 size-full object-cover"
                  />
                ) : (
                  <LayoutTemplate className="absolute inset-0 m-auto text-white/80" size={32} />
                )}
                {t.fresh ? (
                  <span className="absolute top-2 left-2 flex items-center gap-1 rounded-md bg-accent px-1.5 py-0.5 text-[11px] font-semibold text-accent-fg">
                    <Sparkles size={12} /> New today
                  </span>
                ) : (
                  t.template.trendScore >= 80 && (
                    <span className="absolute top-2 left-2 flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] font-semibold text-white">
                      <Flame size={12} className="text-warning" /> Hot
                    </span>
                  )
                )}
                <span className="absolute right-2 bottom-2 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] font-semibold text-white tabular-nums">
                  {t.template.slots.length} clips · {formatDuration(t.duration)}
                </span>
              </div>
              <p className="mt-1.5 truncate text-sm font-semibold">{t.template.name}</p>
              {t.trend && <p className="truncate text-xs text-muted">from “{t.trend}”</p>}
            </button>
          </li>
        ))}
      </ul>
      {chosen && <TemplateSheet entry={chosen} onClose={() => setChosen(null)} />}
    </>
  )
}

const isVisual = (a: Asset) => a.kind === 'video' || a.kind === 'image'

/**
 * "Use template": pick media for the template's slots (from the library or freshly
 * uploaded), then the host builds the project (`POST /api/projects` with templateRef).
 */
export function TemplateSheet({ entry, onClose }: { entry: TemplateEntry; onClose: () => void }) {
  const { template } = entry
  const slots = template.slots.length
  const assets = useAssets((l) => l.filter(isVisual))
  const create = useCreateProject()
  const navigate = useNavigate()
  const [picked, setPicked] = useState<readonly string[]>([])
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set())
  const [uploadIds, setUploadIds] = useState<readonly string[]>([])
  const uploads = useUploads((s) => s.tasks).filter((t) => uploadIds.includes(t.id))

  // Fresh uploads join the end of the selection as they complete (unless deselected).
  const uploadedAssetIds = uploads.flatMap((t) =>
    t.status === 'done' && t.asset ? [t.asset.id] : [],
  )
  const selection = [
    ...picked,
    ...uploadedAssetIds.filter((id) => !picked.includes(id) && !excluded.has(id)),
  ]
  const uploading = uploads.filter((t) => t.status === 'queued' || t.status === 'uploading')

  const toggle = (id: string) => {
    if (selection.includes(id)) {
      setPicked(selection.filter((x) => x !== id))
      setExcluded((s) => new Set(s).add(id))
    } else {
      setPicked([...selection, id])
    }
  }

  const submit = () =>
    create.mutate(
      { name: template.name, templateRef: entry.ref, assetIds: selection.slice(0, slots) },
      {
        onSuccess: (p) => void navigate(`/p/${p.id}`),
        onError: (e) => toast.error('Could not apply the template', e.message),
      },
    )

  return (
    <AdaptiveModal
      open
      onClose={onClose}
      title={template.name}
      description={template.description || undefined}
      locked={create.isPending}
      footer={
        <Button
          block
          variant="primary"
          size="lg"
          loading={create.isPending}
          disabled={selection.length === 0 || uploading.length > 0}
          onClick={submit}
        >
          {uploading.length > 0
            ? `Uploading ${uploading.length}…`
            : `Use template (${Math.min(selection.length, slots)}/${slots})`}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2 text-sm text-muted">
          <span className="rounded-lg bg-surface-2 px-2 py-1">{slots} clips</span>
          <span className="rounded-lg bg-surface-2 px-2 py-1">
            {formatDuration(entry.duration)}
          </span>
          {template.musicHint && (
            <span className="flex items-center gap-1 rounded-lg bg-surface-2 px-2 py-1">
              <Music size={14} /> {template.musicHint.title}
              {template.musicHint.bpm ? ` · ${template.musicHint.bpm} BPM` : ''}
            </span>
          )}
        </div>
        <p className="text-sm">
          Pick up to {slots} photos or videos, in order. Fewer is fine — slots repeat your media.
        </p>
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          <li>
            <FileButton
              accept="video/*,image/*"
              onFiles={(files) => setUploadIds((ids) => [...ids, ...enqueueUploads(files)])}
              className="aspect-[9/16] w-full flex-col gap-1 rounded-xl border border-dashed border-line text-sm text-muted"
            >
              <ImagePlus size={24} />
              From device
            </FileButton>
          </li>
          {uploading.map((t) => (
            <li
              key={t.id}
              className="grid aspect-[9/16] place-items-center rounded-xl bg-surface-2"
            >
              <ProgressRing
                value={t.size ? t.loaded / t.size : undefined}
                label={`Uploading ${t.name}`}
                showLabel
              />
            </li>
          ))}
          {(assets.data ?? []).map((a) => {
            const n = selection.indexOf(a.id)
            return (
              <li key={a.id}>
                <button
                  type="button"
                  aria-pressed={n !== -1}
                  aria-label={`${n !== -1 ? 'Deselect' : 'Select'} ${a.name}`}
                  onClick={() => toggle(a.id)}
                  className={cn(
                    'relative block aspect-[9/16] w-full overflow-hidden rounded-xl bg-surface-2',
                    n !== -1 && 'ring-3 ring-accent',
                  )}
                >
                  <img
                    src={api.posterUrl(a.id)}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="absolute inset-0 size-full object-cover"
                  />
                  {n !== -1 && (
                    <span className="absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-full bg-accent text-xs font-bold text-white">
                      {n < slots ? n + 1 : <Check size={14} />}
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </AdaptiveModal>
  )
}
