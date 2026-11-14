/**
 * Chroma key with an eyedropper. The key colour can be sampled from the clip's poster
 * frame (works on every device: the host serves it same-origin, so the canvas is not
 * tainted) or, where the browser supports it, from anywhere on screen with the native
 * EyeDropper — including the live preview.
 */
import type { MediaClip } from '@reelforge/core'
import { Pipette } from 'lucide-react'
import { useState, type MouseEvent } from 'react'
import { api } from '@/api/index.ts'
import { Button } from '@/components/Button.tsx'
import { ColorPicker } from '@/components/ColorPicker.tsx'
import { Slider } from '@/components/Slider.tsx'
import { toast } from '@/components/Toast.tsx'
import { rgbaToHex } from '@/lib/color.ts'
import { edit, gesture } from '../model/commands.ts'
import { DEFAULT_CHROMA, setChroma } from '../model/edits.ts'
import { Section, Toggle } from '../ui.tsx'

interface EyeDropperResult {
  sRGBHex: string
}
interface EyeDropperCtor {
  new (): { open(): Promise<EyeDropperResult> }
}

const nativeEyeDropper = (): EyeDropperCtor | undefined =>
  (globalThis as { EyeDropper?: EyeDropperCtor }).EyeDropper

/** Reads the pixel under a click on an <img>, in the image's natural resolution. */
export const samplePixel = (img: HTMLImageElement, clientX: number, clientY: number): string => {
  const rect = img.getBoundingClientRect()
  const x = Math.floor(((clientX - rect.left) / Math.max(1, rect.width)) * img.naturalWidth)
  const y = Math.floor(((clientY - rect.top) / Math.max(1, rect.height)) * img.naturalHeight)
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Canvas is not available')
  ctx.drawImage(img, x, y, 1, 1, 0, 0, 1, 1)
  const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data
  return rgbaToHex({ r, g, b, a: 1 })
}

function PosterSampler({ clip, onPick }: { clip: MediaClip; onPick: (hex: string) => void }) {
  const pick = (e: MouseEvent<HTMLImageElement>) => {
    try {
      onPick(samplePixel(e.currentTarget, e.clientX, e.clientY))
    } catch (err) {
      toast.error("Couldn't read the colour", err instanceof Error ? err.message : undefined)
    }
  }
  return (
    <figure className="flex flex-col gap-1.5">
      <img
        src={api.posterUrl(clip.assetId)}
        alt="Tap the colour to remove"
        className="max-h-56 w-full cursor-crosshair rounded-xl bg-surface-2 object-contain"
        onClick={pick}
        draggable={false}
      />
      <figcaption className="text-xs text-muted">Tap the background colour to remove.</figcaption>
    </figure>
  )
}

export function ChromaSection({ clip }: { clip: MediaClip }) {
  const key = clip.chromaKey ?? { ...DEFAULT_CHROMA, enabled: false }
  const [sampling, setSampling] = useState(false)
  const EyeDropper = nativeEyeDropper()
  const pickColor = (color: string) => {
    setSampling(false)
    edit('Key colour', (d) => setChroma(d, clip.id, { color, enabled: true }))
  }
  const pickFromScreen = async () => {
    if (!EyeDropper) return
    try {
      pickColor((await new EyeDropper().open()).sRGBHex)
    } catch {
      // Dismissed with Escape: nothing to do.
    }
  }
  return (
    <Section title="Chroma key">
      <Toggle
        label="Remove background colour"
        checked={key.enabled}
        onChange={(on) => edit('Chroma key', (d) => setChroma(d, clip.id, { enabled: on }))}
      />
      {key.enabled && (
        <>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              icon={<Pipette size={16} />}
              variant={sampling ? 'primary' : 'secondary'}
              aria-pressed={sampling}
              onClick={() => setSampling((v) => !v)}
            >
              Pick from frame
            </Button>
            {EyeDropper && (
              <Button size="sm" icon={<Pipette size={16} />} onClick={() => void pickFromScreen()}>
                Pick from screen
              </Button>
            )}
          </div>
          {sampling && <PosterSampler clip={clip} onPick={pickColor} />}
          <ColorPicker
            label="Key colour"
            value={key.color}
            {...gesture<string>('Key colour', (d, color) => setChroma(d, clip.id, { color }))}
          />
          <Slider
            label="Strength"
            value={Math.round(key.similarity * 100)}
            min={0}
            max={100}
            step={1}
            defaultValue={30}
            unit="%"
            {...gesture<number>('Chroma strength', (d, v) =>
              setChroma(d, clip.id, { similarity: v / 100 }),
            )}
          />
          <Slider
            label="Edge softness"
            value={Math.round(key.blend * 100)}
            min={0}
            max={100}
            step={1}
            defaultValue={10}
            unit="%"
            {...gesture<number>('Chroma softness', (d, v) =>
              setChroma(d, clip.id, { blend: v / 100 }),
            )}
          />
        </>
      )}
    </Section>
  )
}
