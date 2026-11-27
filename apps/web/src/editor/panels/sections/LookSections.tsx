/**
 * Look of media clips: colour adjustments, LUT filters and pack effects. Each section edits
 * a list of clips at once (the selection, or "all clips" from the root tool bar) and shows
 * the first clip's values.
 */
import type { Adjustments, MediaClip } from '@reelforge/core'
import { Ban, Sparkles, Trash2 } from 'lucide-react'
import { Button } from '@/components/Button.tsx'
import { IconButton } from '@/components/IconButton.tsx'
import { Slider } from '@/components/Slider.tsx'
import { cn } from '@/lib/cn.ts'
import { usePacksData } from '../hooks.ts'
import { catalog, findRef } from '../model/catalog.ts'
import { edit, gesture } from '../model/commands.ts'
import {
  addEffect,
  removeEffect,
  removeEffectRef,
  resetAdjustments,
  setAdjustment,
  setFilter,
  setFilterIntensity,
  updateEffect,
  NEUTRAL_ADJUSTMENTS,
} from '../model/edits.ts'
import { useContext, useState } from 'react'
import {
  Gallery,
  HeroSlider,
  Hint,
  PackThumb,
  SecondsSlider,
  Section,
  SectionsCollapsible,
  Tile,
} from '../ui.tsx'

export const ADJUSTMENTS: readonly { key: keyof Adjustments; label: string; min: number }[] = [
  { key: 'brightness', label: 'Brightness', min: -100 },
  { key: 'contrast', label: 'Contrast', min: -100 },
  { key: 'saturation', label: 'Saturation', min: -100 },
  { key: 'exposure', label: 'Exposure', min: -100 },
  { key: 'temperature', label: 'Temperature', min: -100 },
  { key: 'tint', label: 'Tint', min: -100 },
  { key: 'highlights', label: 'Highlights', min: -100 },
  { key: 'shadows', label: 'Shadows', min: -100 },
  { key: 'vibrance', label: 'Vibrance', min: -100 },
  { key: 'sharpen', label: 'Sharpen', min: 0 },
  { key: 'vignette', label: 'Vignette', min: 0 },
  { key: 'grain', label: 'Grain', min: 0 },
  { key: 'blur', label: 'Blur', min: 0 },
]

const isNeutral = (a: Adjustments) =>
  (Object.keys(NEUTRAL_ADJUSTMENTS) as (keyof Adjustments)[]).every((k) => a[k] === 0)

export function AdjustSection({ clips }: { clips: readonly MediaClip[] }) {
  // The inspector has room for every slider; a sheet shows one at a time, picked by chip.
  const stacked = useContext(SectionsCollapsible)
  const [picked, setPicked] = useState<keyof Adjustments>('brightness')
  const first = clips[0]
  if (!first) return null
  const ids = clips.map((c) => c.id)
  const current = ADJUSTMENTS.find((a) => a.key === picked) ?? ADJUSTMENTS[0]!
  const value = first.adjustments[current.key]
  return (
    <Section
      title="Adjust"
      action={
        <Button
          size="sm"
          variant="ghost"
          disabled={isNeutral(first.adjustments)}
          onClick={() => edit('Reset adjustments', (d) => resetAdjustments(d, ids))}
        >
          Reset
        </Button>
      }
    >
      {stacked ? (
        ADJUSTMENTS.map((a) => (
          <Slider
            key={a.key}
            label={a.label}
            value={first.adjustments[a.key]}
            min={a.min}
            max={100}
            step={1}
            defaultValue={0}
            {...gesture<number>(a.label, (d, v) => setAdjustment(d, ids, a.key, v))}
          />
        ))
      ) : (
        <>
          <HeroSlider
            key={current.key}
            label={current.label}
            display={`${value > 0 ? '+' : ''}${value}`}
            value={value}
            min={current.min}
            max={100}
            step={1}
            defaultValue={0}
            {...gesture<number>(current.label, (d, v) => setAdjustment(d, ids, current.key, v))}
          />
          <div
            role="radiogroup"
            aria-label="Adjustment"
            className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1"
          >
            {ADJUSTMENTS.map((a) => {
              const on = a.key === current.key
              const changed = first.adjustments[a.key] !== 0
              return (
                <button
                  key={a.key}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setPicked(a.key)}
                  className={cn(
                    'relative flex h-10 shrink-0 items-center rounded-full px-3.5 text-sm font-semibold whitespace-nowrap transition-colors',
                    on ? 'bg-fg text-canvas' : 'bg-surface-2 text-muted hover:text-fg',
                  )}
                >
                  {a.label}
                  {changed && (
                    <>
                      <span aria-hidden className="ml-1.5 size-1.5 rounded-full bg-accent" />
                      <span className="sr-only"> (changed)</span>
                    </>
                  )}
                </button>
              )
            })}
          </div>
        </>
      )}
    </Section>
  )
}

export function FilterSection({ clips }: { clips: readonly MediaClip[] }) {
  const packs = usePacksData()
  const filters = catalog(packs, 'filters')
  const first = clips[0]
  if (!first) return null
  const ids = clips.map((c) => c.id)
  const current = first.filter
  return (
    <Section title="Filters">
      <Gallery label="Filters">
        <Tile
          label="None"
          selected={!current}
          onClick={() => edit('Remove filter', (d) => setFilter(d, ids, undefined))}
        >
          <Ban size={22} className="text-muted" />
        </Tile>
        {filters.map((f) => (
          <Tile
            key={f.ref}
            label={f.item.name}
            selected={current?.ref === f.ref}
            onClick={() =>
              edit(`Filter: ${f.item.name}`, (d) =>
                setFilter(d, ids, f.ref, f.item.defaultIntensity),
              )
            }
          >
            {f.thumbPath ? (
              <PackThumb path={f.thumbPath} />
            ) : (
              <span className="text-xs font-bold text-muted">{f.item.name.slice(0, 2)}</span>
            )}
          </Tile>
        ))}
      </Gallery>
      {filters.length === 0 && (
        <Hint>Filters arrive with trend packs — sync packs in Settings.</Hint>
      )}
      {current && (
        <Slider
          label="Intensity"
          value={Math.round(current.intensity * 100)}
          min={0}
          max={100}
          step={1}
          defaultValue={100}
          unit="%"
          {...gesture<number>('Filter intensity', (d, v) => setFilterIntensity(d, ids, v / 100))}
        />
      )}
    </Section>
  )
}

export function EffectsSection({ clips }: { clips: readonly MediaClip[] }) {
  const packs = usePacksData()
  const effects = catalog(packs, 'effects')
  const first = clips[0]
  if (!first) return null
  const ids = clips.map((c) => c.id)
  // Only a single clip can have its applied effects listed and tuned individually.
  const single = clips.length === 1 ? first : undefined
  return (
    <Section title="Effects">
      <Gallery label="Effects">
        {effects.map((e) => (
          <Tile
            key={e.ref}
            label={e.item.name}
            selected={!!single?.effects.some((x) => x.ref === e.ref)}
            onClick={() =>
              single?.effects.some((x) => x.ref === e.ref)
                ? edit('Remove effect', (d) => removeEffectRef(d, ids, e.ref))
                : edit(`Effect: ${e.item.name}`, (d) => addEffect(d, ids, e.ref))
            }
          >
            {e.thumbPath ? (
              <PackThumb path={e.thumbPath} />
            ) : (
              <Sparkles size={22} className="text-muted" />
            )}
          </Tile>
        ))}
      </Gallery>
      {effects.length === 0 && (
        <Hint>Effects arrive with trend packs — sync packs in Settings.</Hint>
      )}
      {single && single.effects.length > 0 && (
        <ul className="flex flex-col gap-4" aria-label="Applied effects">
          {single.effects.map((fx) => {
            const name = findRef(packs, 'effects', fx.ref)?.item.name ?? fx.ref
            const end = fx.duration === undefined ? single.duration : fx.start + fx.duration
            return (
              <li key={fx.id} className={cn('flex flex-col gap-2 rounded-xl bg-surface-2 p-3')}>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold">{name}</span>
                  <IconButton
                    size="sm"
                    label={`Remove ${name}`}
                    icon={<Trash2 size={16} />}
                    onClick={() => edit('Remove effect', (d) => removeEffect(d, single.id, fx.id))}
                  />
                </div>
                <Slider
                  label="Intensity"
                  value={Math.round(fx.intensity * 100)}
                  min={0}
                  max={100}
                  step={1}
                  defaultValue={100}
                  unit="%"
                  {...gesture<number>('Effect intensity', (d, v) =>
                    updateEffect(d, single.id, fx.id, { intensity: v / 100 }),
                  )}
                />
                <SecondsSlider
                  label="Starts at"
                  value={fx.start}
                  max={single.duration - 1}
                  defaultValue={0}
                  handlers={gesture<number>('Effect start', (d, v) =>
                    updateEffect(d, single.id, fx.id, { start: v }),
                  )}
                />
                <SecondsSlider
                  label="Ends at"
                  value={end}
                  min={fx.start + 1}
                  max={single.duration}
                  defaultValue={single.duration}
                  handlers={gesture<number>('Effect end', (d, v) =>
                    updateEffect(d, single.id, fx.id, {
                      duration: v >= single.duration ? undefined : v - fx.start,
                    }),
                  )}
                />
              </li>
            )
          })}
        </ul>
      )}
    </Section>
  )
}
