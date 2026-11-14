/** Stickers: trending pack stickers and the user's own images, dropped at the playhead. */
import { ImagePlus } from 'lucide-react'
import { useState } from 'react'
import { api } from '@/api/index.ts'
import { FileButton } from '@/components/FileButton.tsx'
import { Spinner } from '@/components/Spinner.tsx'
import { toast } from '@/components/Toast.tsx'
import { editorStore } from '@/state/editorStore.ts'
import { useAssetsMap } from '@/state/selectors.ts'
import { usePacksData } from '../hooks.ts'
import { catalog, stickerPath } from '../model/catalog.ts'
import { describeError, edit } from '../model/commands.ts'
import { addSticker } from '../model/edits.ts'
import { uploadAndWait } from '../upload.ts'
import { Gallery, Hint, PanelBody, Section, Tile } from '../ui.tsx'

const insert = (source: { ref: string } | { assetId: string }, name: string) => {
  const s = editorStore.getState()
  const clip = edit(`Add sticker: ${name}`, (d) => addSticker(d, s.playhead, source))
  if (clip) s.select([clip.id])
}

export function StickersPanel() {
  const packs = usePacksData()
  const stickers = catalog(packs, 'stickers')
  const assets = useAssetsMap()
  const images = Object.values(assets).filter((a) => a.kind === 'image')
  const [busy, setBusy] = useState(false)
  const upload = async (files: File[]) => {
    const file = files[0]
    if (!file) return
    setBusy(true)
    try {
      const asset = await uploadAndWait(file)
      insert({ assetId: asset.id }, asset.name)
    } catch (err) {
      toast.error("Couldn't add the image", describeError(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <PanelBody>
      <Section title="Trending">
        {stickers.length === 0 ? (
          <Hint>Stickers arrive with trend packs — sync packs in Settings.</Hint>
        ) : (
          <Gallery label="Stickers">
            {stickers.map((s) => (
              <Tile
                key={s.ref}
                label={s.item.name}
                onClick={() => insert({ ref: s.ref }, s.item.name)}
              >
                <img
                  src={api.packFileUrl(s.thumbPath ?? stickerPath(s))}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                  className="size-4/5 object-contain"
                />
              </Tile>
            ))}
          </Gallery>
        )}
      </Section>
      <Section
        title="Your images"
        action={
          <FileButton
            onFiles={(f) => void upload(f)}
            accept="image/*"
            multiple={false}
            disabled={busy}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold hover:bg-surface-2"
          >
            {busy ? <Spinner /> : <ImagePlus size={14} />} Upload
          </FileButton>
        }
      >
        {images.length > 0 ? (
          <Gallery label="Your images">
            {images.map((a) => (
              <Tile key={a.id} label={a.name} onClick={() => insert({ assetId: a.id }, a.name)}>
                <img
                  src={api.posterUrl(a.id)}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="size-4/5 object-contain"
                />
              </Tile>
            ))}
          </Gallery>
        ) : (
          <Hint>PNG logos and cut-outs work great as stickers.</Hint>
        )}
      </Section>
    </PanelBody>
  )
}
