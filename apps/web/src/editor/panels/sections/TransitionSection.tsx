/** Transition into a main-track clip (or every boundary), from pack presets. */
import type { MediaClip, TransitionType } from '@reelforge/core'
import { Ban, Shuffle } from 'lucide-react'
import { Button } from '@/components/Button.tsx'
import { toast } from '@/components/Toast.tsx'
import { locateClip, useEditor } from '@/state/selectors.ts'
import { usePacksData } from '../hooks.ts'
import { catalog } from '../model/catalog.ts'
import { edit, gesture } from '../model/commands.ts'
import { maxTransition, setTransition, setTransitionAll, TRANSITION_MIN } from '../model/edits.ts'
import { Gallery, Hint, PackThumb, SecondsSlider, Section, Tile } from '../ui.tsx'

interface Choice {
  key: string
  name: string
  type: TransitionType
  duration: number
  thumbPath?: string
}

/** Offered when no pack is synced yet. */
const BASIC: readonly Choice[] = (
  [
    ['fade', 'Fade'],
    ['dissolve', 'Dissolve'],
    ['fadeblack', 'Dip to black'],
    ['slideleft', 'Slide'],
    ['wipeleft', 'Wipe'],
    ['zoomin', 'Zoom'],
    ['whip', 'Whip'],
    ['flash', 'Flash'],
    ['glitch', 'Glitch'],
  ] as const
).map(([type, name]) => ({ key: type, name, type, duration: 400_000 }))

export function TransitionSection({ clip }: { clip: MediaClip }) {
  const packs = usePacksData()
  const presets = catalog(packs, 'transitions')
  const choices: readonly Choice[] = presets.length
    ? presets.map((p) => ({
        key: p.ref,
        name: p.item.name,
        type: p.item.type,
        duration: p.item.duration,
        ...(p.thumbPath ? { thumbPath: p.thumbPath } : {}),
      }))
    : BASIC
  const max = useEditor((s) => {
    const loc = locateClip(s.project, clip.id)
    return loc?.track.kind === 'main' ? maxTransition(loc.track, loc.index) : 0
  })
  const current = clip.transitionIn
  if (max < TRANSITION_MIN)
    return (
      <Section title="Transition">
        <Hint>These clips are too short for a transition — lengthen them first.</Hint>
      </Section>
    )
  const apply = (c: Choice) =>
    edit(`Transition: ${c.name}`, (d) =>
      setTransition(d, clip.id, c.type, current?.duration ?? c.duration),
    )
  const applyAll = () => {
    const type = current?.type
    const n = edit('Transition to all', (d) =>
      setTransitionAll(d, type, current?.duration ?? 400_000),
    )
    if (n !== undefined) toast(type ? `Applied to ${n} cuts` : 'Removed all transitions')
  }
  return (
    <Section
      title="Transition"
      action={
        <Button size="sm" variant="ghost" icon={<Shuffle size={14} />} onClick={applyAll}>
          Apply to all
        </Button>
      }
    >
      <Gallery label="Transitions">
        <Tile
          label="None"
          selected={!current}
          onClick={() => edit('Remove transition', (d) => setTransition(d, clip.id, undefined, 0))}
        >
          <Ban size={22} className="text-muted" />
        </Tile>
        {choices.map((c) => (
          <Tile
            key={c.key}
            label={c.name}
            selected={current?.type === c.type}
            onClick={() => apply(c)}
          >
            {c.thumbPath ? (
              <PackThumb path={c.thumbPath} />
            ) : (
              <span className="text-xs font-bold text-muted">{c.name}</span>
            )}
          </Tile>
        ))}
      </Gallery>
      {current && (
        <SecondsSlider
          label="Duration"
          value={Math.min(current.duration, max)}
          min={TRANSITION_MIN}
          max={max}
          step={0.05}
          defaultValue={400_000}
          handlers={gesture<number>('Transition duration', (d, v) =>
            setTransition(d, clip.id, current.type, v),
          )}
        />
      )}
    </Section>
  )
}
