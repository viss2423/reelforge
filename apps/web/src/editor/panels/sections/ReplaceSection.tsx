/** Replace a clip's media with another library asset (or a new upload), keeping its timing. */
import type { Asset, AudioClip, MediaClip } from '@reelforge/core'
import { Music, Upload } from 'lucide-react'
import { useState } from 'react'
import { api } from '@/api/index.ts'
import { FileButton } from '@/components/FileButton.tsx'
import { Spinner } from '@/components/Spinner.tsx'
import { toast } from '@/components/Toast.tsx'
import { formatDuration } from '@/lib/format.ts'
import { useAssetsMap } from '@/state/selectors.ts'
import { isAssetPlaceable } from '../../actions.ts'
import { edit } from '../model/commands.ts'
import { isAudioClip } from '../model/draft.ts'
import { replaceMedia } from '../model/edits.ts'
import { uploadAndWait } from '../upload.ts'
import { Gallery, Hint, Section, Tile } from '../ui.tsx'

export function ReplaceSection({ clip }: { clip: MediaClip | AudioClip }) {
  const assets = useAssetsMap()
  const audio = isAudioClip(clip)
  const [busy, setBusy] = useState(false)
  const candidates = Object.values(assets)
    .filter((a) => a.id !== clip.assetId && (a.kind === 'audio') === audio && isAssetPlaceable(a))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const replace = (a: Asset) => edit('Replace', (d) => replaceMedia(d, clip.id, a))
  const upload = async (files: File[]) => {
    const file = files[0]
    if (!file) return
    setBusy(true)
    try {
      replace(await uploadAndWait(file))
    } catch (err) {
      toast.error("Couldn't replace", err instanceof Error ? err.message : undefined)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section
      title="Replace with"
      action={
        <FileButton
          onFiles={(f) => void upload(f)}
          accept={audio ? 'audio/*' : 'video/*,image/*'}
          multiple={false}
          disabled={busy}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold hover:bg-surface-2"
        >
          {busy ? <Spinner /> : <Upload size={14} />} Upload
        </FileButton>
      }
    >
      {candidates.length === 0 ? (
        <Hint>Upload another {audio ? 'audio file' : 'video or photo'} to swap it in.</Hint>
      ) : (
        <Gallery label="Library">
          {candidates.map((a) => (
            <Tile
              key={a.id}
              label={a.name}
              onClick={() => replace(a)}
              aspect={audio ? 'square' : 'portrait'}
            >
              {a.kind === 'audio' ? (
                <Music size={22} className="text-muted" />
              ) : (
                <img
                  src={api.posterUrl(a.id)}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="absolute inset-0 size-full object-cover"
                />
              )}
              {a.duration !== undefined && (
                <span className="absolute right-1 bottom-1 rounded bg-black/60 px-1 text-[10px] text-white tabular-nums">
                  {formatDuration(a.duration)}
                </span>
              )}
            </Tile>
          ))}
        </Gallery>
      )}
    </Section>
  )
}
