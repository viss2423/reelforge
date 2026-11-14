/** In / out / loop animation pickers for text and sticker clips (packs + builtins). */
import type { StickerClip, TextClip } from '@reelforge/core'
import { Ban, Wand2 } from 'lucide-react'
import { useState } from 'react'
import { Tabs } from '@/components/Tabs.tsx'
import { usePacksData } from '../hooks.ts'
import { animationChoices, type AnimationSlot } from '../model/catalog.ts'
import { edit, gesture } from '../model/commands.ts'
import { isText } from '../model/draft.ts'
import { DEFAULT_ANIMATION_DURATION, setAnimation } from '../model/edits.ts'
import { Gallery, PackThumb, SecondsSlider, Section, Tile } from '../ui.tsx'

const KEY = { in: 'animationIn', out: 'animationOut', loop: 'animationLoop' } as const
const SLOT_LABEL: Record<AnimationSlot, string> = { in: 'In', out: 'Out', loop: 'Loop' }

export function AnimationSection({ clip }: { clip: TextClip | StickerClip }) {
  const packs = usePacksData()
  const slots: AnimationSlot[] = isText(clip) ? ['in', 'out', 'loop'] : ['in', 'out']
  const [slot, setSlot] = useState<AnimationSlot>('in')
  const current = (clip as TextClip)[KEY[slot]]
  const choices = animationChoices(packs, slot)
  const limit = slot === 'loop' ? clip.duration : Math.max(1, Math.floor(clip.duration / 2))
  return (
    <Section title="Animations">
      <Tabs
        label="Animation slot"
        items={slots.map((s) => ({ id: s, label: SLOT_LABEL[s] }))}
        value={slot}
        onChange={setSlot}
      />
      <Gallery label={`${SLOT_LABEL[slot]} animations`}>
        <Tile
          label="None"
          selected={!current}
          onClick={() => edit('Remove animation', (d) => setAnimation(d, clip.id, slot, undefined))}
        >
          <Ban size={22} className="text-muted" />
        </Tile>
        {choices.map((c) => (
          <Tile
            key={c.ref}
            label={c.name}
            selected={current?.ref === c.ref}
            onClick={() =>
              edit(`Animation: ${c.name}`, (d) => setAnimation(d, clip.id, slot, c.ref))
            }
          >
            {c.thumbPath ? (
              <PackThumb path={c.thumbPath} />
            ) : (
              <Wand2 size={20} className="text-muted" />
            )}
          </Tile>
        ))}
      </Gallery>
      {current && (
        <SecondsSlider
          label={slot === 'loop' ? 'Loop length' : 'Duration'}
          value={Math.min(current.duration, limit)}
          min={Math.min(100_000, limit)}
          max={limit}
          defaultValue={Math.min(DEFAULT_ANIMATION_DURATION, limit)}
          handlers={gesture<number>('Animation duration', (d, v) =>
            setAnimation(d, clip.id, slot, current.ref, v),
          )}
        />
      )}
    </Section>
  )
}
