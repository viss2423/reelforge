import type { Asset } from '@reelforge/core'
import { Check, Flame, ImagePlus, Music } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { api } from '@/api/index.ts'
import { useAssets, useCreateProject, usePacks, useTrends } from '@/api/queries.ts'
import { Button } from '@/components/Button.tsx'
import { AdaptiveModal } from '@/components/Dialog.tsx'
import { FileButton } from '@/components/FileButton.tsx'
import { ProgressRing } from '@/components/ProgressRing.tsx'
import { Skeleton } from '@/components/Skeleton.tsx'
import { toast } from '@/components/Toast.tsx'
import { registerPackFonts, textPreviewStyle } from '@/editor/panels/textPreview.ts'
import { cn } from '@/lib/cn.ts'
import { formatDuration } from '@/lib/format.ts'
import { listTemplates, type TemplateEntry } from '@/lib/packs.ts'
import { enqueueUploads, useUploads } from '@/state/uploads.ts'
import { SectionTitle } from '../AppFrame.tsx'
import { templateLook } from './templateLook.ts'

/** Canvas px → card px for hook text (cards are ~150 px wide; the canvas is 1080). */
const CARD_SCALE = 0.17
const FALLBACK_HOOK = {
  color: '#fff',
  fontWeight: 800,
  fontSize: 14,
  lineHeight: 1.1,
  textAlign: 'center',
  textShadow: '0 1px 6px rgb(0 0 0 / 0.5)',
} as const

/** 9:16 preview of a template's own look: its hook in its style over its colours. */
export function TemplatePoster({
  entry,
  scale = CARD_SCALE,
  className,
  children,
}: {
  entry: TemplateEntry
  scale?: number
  className?: string
  children?: ReactNode
}) {
  const packs = usePacks()
  useEffect(() => registerPackFonts(packs.data), [packs.data])
  const { template } = entry
  const look = useMemo(
    () => templateLook(template, packs.data, entry.trend),
    [template, packs.data, entry.trend],
  )
  return (
    <div
      className={cn('relative aspect-[9/16] overflow-hidden rounded-2xl', className)}
      style={{ backgroundImage: look.background }}
    >
      <div className="absolute inset-x-2 top-[40%] flex -translate-y-1/2 justify-center">
        <span
          aria-hidden
          className="line-clamp-4 max-w-full"
          style={look.style ? textPreviewStyle(look.style, scale) : FALLBACK_HOOK}
        >
          {look.hook}
        </span>
      </div>
      {children}
    </div>
  )
}

/** A template tile: poster, "New today"/"Hot" pill, clip count and length as glass chips. */
export function TemplateCard({ entry, onClick }: { entry: TemplateEntry; onClick: () => void }) {
  const { template } = entry
  return (
    <button
      type="button"
      onClick={onClick}
      className="group block w-full rounded-2xl text-left"
      aria-label={`Use template ${template.name}`}
    >
      <TemplatePoster
        entry={entry}
        className="shadow-[0_6px_20px_rgb(0_0_0/0.25)] transition-transform duration-200 ease-[var(--ease-spring)] group-active:scale-[0.97]"
      >
        {entry.fresh ? (
          <span className="glass absolute top-2 left-2 flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold">
            <span aria-hidden className="size-1.5 rounded-full bg-accent" />
            New today
          </span>
        ) : (
          template.trendScore >= 80 && (
            <span className="glass absolute top-2 left-2 flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold">
              <Flame size={11} className="text-warning" aria-hidden /> Hot
            </span>
          )
        )}
        <span className="absolute inset-x-2 bottom-2 flex gap-1 text-[11px] font-semibold tabular-nums">
          <span className="glass rounded-full px-2 py-0.5">{template.slots.length} clips</span>
          <span className="glass rounded-full px-2 py-0.5">{formatDuration(entry.duration)}</span>
        </span>
      </TemplatePoster>
      <p className="mt-2 truncate text-sm font-semibold">{template.name}</p>
      {entry.trend && <p className="truncate text-xs text-muted">from “{entry.trend}”</p>}
    </button>
  )
}

/** Horizontal rail of template cards (snap scrolling, bleeds to the screen edge). */
export function TemplateRail({
  entries,
  onPick,
  testId,
}: {
  entries: readonly TemplateEntry[]
  onPick: (entry: TemplateEntry) => void
  testId?: string
}) {
  return (
    <ul
      className="no-scrollbar -mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pt-1 pb-2 md:-mx-6 md:scroll-px-6 md:px-6"
      data-testid={testId}
    >
      {entries.map((t) => (
        <li key={t.ref} className="w-36 shrink-0 snap-start sm:w-40">
          <TemplateCard entry={t} onClick={() => onPick(t)} />
        </li>
      ))}
    </ul>
  )
}

/** Trend-sorted template rail for Home. Hidden when no pack has templates. */
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
            <Skeleton key={i} className="aspect-[9/16] w-36 shrink-0 rounded-2xl" />
          ))}
        </div>
      </>
    )
  }
  if (templates.length === 0) return null

  return (
    <>
      <SectionTitle>Trending templates</SectionTitle>
      <TemplateRail entries={templates} onPick={setChosen} testId="template-carousel" />
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
      locked={create.isPending}
      footer={
        <Button
          block
          variant="primary"
          size="lg"
          className="bg-magic"
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
        <div className="flex items-center gap-4">
          <TemplatePoster entry={entry} scale={0.09} className="w-20 shrink-0 rounded-xl" />
          <div className="flex min-w-0 flex-col gap-2">
            {template.description && (
              <p className="line-clamp-2 text-sm text-muted">{template.description}</p>
            )}
            <div className="flex flex-wrap gap-1.5 text-xs font-medium text-muted">
              <span className="rounded-full bg-surface-2 px-2.5 py-1 tabular-nums">
                {slots} clips · {formatDuration(entry.duration)}
              </span>
              {template.musicHint && (
                <span className="flex min-w-0 items-center gap-1 rounded-full bg-surface-2 px-2.5 py-1">
                  <Music size={12} aria-hidden />
                  <span className="truncate">
                    {template.musicHint.title}
                    {template.musicHint.bpm ? ` · ${template.musicHint.bpm} BPM` : ''}
                  </span>
                </span>
              )}
            </div>
          </div>
        </div>
        <p className="text-sm font-semibold">
          Pick up to {slots}, in order{' '}
          <span className="font-normal text-muted">· fewer is fine</span>
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
