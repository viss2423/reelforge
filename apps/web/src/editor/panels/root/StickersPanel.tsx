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
      <Section title="Your images">
        <Gallery label="Your images">
          <FileButton
            onFiles={(f) => void upload(f)}
            accept="image/*"
            multiple={false}
            disabled={busy}
            label="Upload an image"
            className="aspect-square w-full flex-col gap-1 self-start rounded-xl bg-accent/10 text-xs font-semibold text-accent ring-1 ring-accent/40 ring-inset hover:bg-accent/15"
          >
            {busy ? <Spinner /> : <ImagePlus size={22} />}
            Upload
          </FileButton>
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
        {images.length === 0 && (
          <p className="text-xs text-muted">PNG logos and cut-outs work great as stickers.</p>
        )}
      </Section>
    </PanelBody>
  )
}
