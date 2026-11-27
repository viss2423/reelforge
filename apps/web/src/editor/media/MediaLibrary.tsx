import type { Asset } from '@reelforge/core'
import {
  CircleAlert,
  CircleCheck,
  Image as ImageIcon,
  Music,
  Plus,
  RotateCcw,
  X,
} from 'lucide-react'
import { useMemo, useState, type DragEvent } from 'react'
import { api } from '@/api/index.ts'
import { useAssets } from '@/api/queries.ts'
import { FileButton } from '@/components/FileButton.tsx'
import { IconButton } from '@/components/IconButton.tsx'
import { ProgressRing } from '@/components/ProgressRing.tsx'
import { SegmentedControl } from '@/components/SegmentedControl.tsx'
import { Skeleton } from '@/components/Skeleton.tsx'
import { Spinner } from '@/components/Spinner.tsx'
import { toast } from '@/components/Toast.tsx'
import { cn } from '@/lib/cn.ts'
import { formatDuration } from '@/lib/format.ts'
import { haptic } from '@/lib/haptics.ts'
import { editorStore } from '@/state/editorStore.ts'
import { useEditorShallow, useProjectId } from '@/state/selectors.ts'
import {
  cancelUpload,
  dismissUpload,
  enqueueUploads,
  retryUpload,
  useUploads,
  type UploadTask,
} from '@/state/uploads.ts'
import { addAssetToTimeline, isAssetPlaceable } from '../actions.ts'

/** MIME type carried by library drags; the timeline reads the asset id from it on drop. */
export const ASSET_DRAG_MIME = 'application/x-reelforge-asset'

type Filter = 'all' | 'video' | 'image' | 'audio'

const sortNewest = (list: Asset[]): Asset[] =>
  list.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))

/**
 * The project's media bin: every asset on the host, upload button, live upload/proxy
 * status. Tap (or drag on desktop) to put an asset on the timeline.
 */
export function MediaLibrary({ onAdded, className }: { onAdded?: () => void; className?: string }) {
  const projectId = useProjectId()
  const assets = useAssets(sortNewest)
  const [filter, setFilter] = useState<Filter>('all')
  const active = useUploads((s) => s.tasks).filter((t) => t.status !== 'done')
  // Assets already used in this project get a check mark.
  const used = useEditorShallow((s) =>
    (s.project?.tracks ?? []).flatMap((t) =>
      t.clips.flatMap((c) => ('assetId' in c && c.assetId ? [c.assetId] : [])),
    ),
  )
  const usedSet = useMemo(() => new Set(used), [used])
  const shown = (assets.data ?? []).filter((a) => filter === 'all' || a.kind === filter)

  const add = (asset: Asset) => {
    const r = addAssetToTimeline(editorStore, asset)
    if (r.ok) {
      haptic(8)
      onAdded?.()
    } else toast(r.reason)
  }

  return (
    <section aria-label="Media" className={cn('flex min-h-0 flex-col', className)}>
      <div className="px-3 pt-3">
        <SegmentedControl<Filter>
          size="sm"
          label="Media type"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'video', label: 'Video' },
            { value: 'image', label: 'Photo' },
            { value: 'audio', label: 'Audio' },
          ]}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {active.length > 0 && (
          <ul className="mb-3 flex flex-col gap-1.5" aria-label="Uploads">
            {active.map((t) => (
              <UploadRow key={t.id} task={t} />
            ))}
          </ul>
        )}
        {assets.isPending ? (
          <div className="grid grid-cols-3 gap-2">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="aspect-square" />
            ))}
          </div>
        ) : (
          <>
            <ul className="grid grid-cols-3 gap-2" data-testid="media-grid">
              <li>
                <FileButton
                  label="Upload media"
                  testId="library-upload"
                  onFiles={(files) => enqueueUploads(files, projectId ? { projectId } : {})}
                  className="aspect-square w-full flex-col gap-1.5 rounded-xl bg-accent/10 text-sm font-semibold text-accent ring-1 ring-accent/40 ring-inset transition-transform duration-150 hover:bg-accent/15 active:scale-95"
                >
                  <span className="panels-cta grid size-10 place-items-center rounded-full bg-accent text-accent-fg">
                    <Plus size={22} />
                  </span>
                  Upload
                </FileButton>
              </li>
              {shown.map((a) => (
                <AssetTile key={a.id} asset={a} used={usedSet.has(a.id)} onAdd={add} />
              ))}
            </ul>
            {shown.length === 0 && active.length === 0 && (
              <p className="mt-4 text-center text-sm text-muted">
                {filter === 'all'
                  ? 'Your videos, photos and music show up here.'
                  : 'Nothing of this type yet.'}
              </p>
            )}
          </>
        )}
      </div>
    </section>
  )
}

function UploadRow({ task }: { task: UploadTask }) {
  const failed = task.status === 'error'
  const cancelled = task.status === 'cancelled'
  return (
    <li className="flex items-center gap-2 rounded-xl bg-surface-2 px-2 py-1.5">
      {failed || cancelled ? (
        <CircleAlert size={20} className={cn('shrink-0', failed ? 'text-danger' : 'text-muted')} />
      ) : (
        <ProgressRing
          value={task.status === 'queued' || !task.size ? undefined : task.loaded / task.size}
          size={28}
          stroke={3}
          label={`Uploading ${task.name}`}
          className="text-accent"
        />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{task.name}</span>
        {failed && <span className="block truncate text-xs text-danger">{task.error}</span>}
      </span>
      {(failed || cancelled) && (
        <IconButton
          size="sm"
          label={`Retry ${task.name}`}
          icon={<RotateCcw size={16} />}
          onClick={() => retryUpload(task.id)}
        />
      )}
      <IconButton
        size="sm"
        label={failed || cancelled ? `Dismiss ${task.name}` : `Cancel ${task.name}`}
        icon={<X size={16} />}
        onClick={() => (failed || cancelled ? dismissUpload(task.id) : cancelUpload(task.id))}
      />
    </li>
  )
}

/** One library tile: poster (once the host has made it), duration, proxy state. */
export function AssetTile({
  asset,
  used,
  onAdd,
}: {
  asset: Asset
  used: boolean
  onAdd: (a: Asset) => void
}) {
  const [posterFailed, setPosterFailed] = useState(false)
  const ready = isAssetPlaceable(asset)
  const proxyBusy =
    asset.kind === 'video' && (asset.proxy === 'pending' || asset.proxy === 'processing')
  const onDragStart = (e: DragEvent) => {
    e.dataTransfer.setData(ASSET_DRAG_MIME, asset.id)
    e.dataTransfer.setData('text/plain', asset.name)
    e.dataTransfer.effectAllowed = 'copy'
  }
  return (
    <li className="[content-visibility:auto] [contain-intrinsic-size:auto_120px]">
      <button
        type="button"
        draggable={ready}
        onDragStart={onDragStart}
        onClick={() => onAdd(asset)}
        aria-label={`Add ${asset.name} to timeline`}
        data-testid="media-item"
        data-asset-id={asset.id}
        data-proxy={asset.proxy}
        data-ready={ready}
        className="relative block aspect-square w-full overflow-hidden rounded-xl bg-surface-2 active:scale-95"
      >
        {asset.kind === 'audio' ? (
          <span className="absolute inset-0 grid place-items-center bg-gradient-to-br from-violet/30 to-accent/30 text-fg">
            <Music size={26} />
          </span>
        ) : asset.thumbnails !== 'ready' || posterFailed ? (
          // The poster only exists once the host's thumbnails job is done; asking earlier
          // would 404 and leave the tile on the placeholder for good.
          <span className="absolute inset-0 grid place-items-center text-subtle">
            <ImageIcon size={24} />
          </span>
        ) : (
          <img
            src={api.posterUrl(asset.id)}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => setPosterFailed(true)}
            className="absolute inset-0 size-full object-cover"
          />
        )}
        {asset.duration !== undefined && asset.kind !== 'image' && (
          <span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 text-[11px] font-semibold text-white tabular-nums">
            {formatDuration(asset.duration)}
          </span>
        )}
        {used && (
          <CircleCheck
            size={18}
            className="absolute top-1 right-1 rounded-full bg-black/40 text-white"
            aria-label="In project"
          />
        )}
        {(proxyBusy || !ready) && asset.proxy !== 'failed' && (
          <span className="absolute top-1 left-1 flex items-center gap-1 rounded bg-black/70 px-1 py-0.5 text-[10px] font-semibold text-white">
            <Spinner size={10} /> {ready ? 'Optimizing' : 'Processing'}
          </span>
        )}
        {asset.proxy === 'failed' && (
          <span className="absolute top-1 left-1 flex items-center gap-1 rounded bg-danger/90 px-1 py-0.5 text-[10px] font-semibold text-white">
            <CircleAlert size={10} /> Failed
          </span>
        )}
        <span className="sr-only">{asset.name}</span>
      </button>
    </li>
  )
}
