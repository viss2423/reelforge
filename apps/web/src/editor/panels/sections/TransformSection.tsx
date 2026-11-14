/**
 * Transform & crop with per-property keyframe diamonds. Values shown are the values at the
 * playhead; editing a keyframed property keys it at the playhead (CapCut behaviour).
 */
import type { Clip, MediaClip } from '@reelforge/core'
import { FlipHorizontal2, FlipVertical2, RotateCcw } from 'lucide-react'
import { Button } from '@/components/Button.tsx'
import { SegmentedControl } from '@/components/SegmentedControl.tsx'
import { Slider } from '@/components/Slider.tsx'
import { useFps } from '@/state/selectors.ts'
import { keyframeTimeNow, useKeyframeTime } from '../hooks.ts'
import { edit, gesture } from '../model/commands.ts'
import { isMedia, type VisualClip } from '../model/draft.ts'
import {
  resetTransform,
  setCrop,
  setFlip,
  setMediaProps,
  setTransformProp,
  toggleTransformKeyframe,
} from '../model/edits.ts'
import { hasKeyframeAt, valueAt, type AnimatableProp } from '../model/keyframes.ts'
import { KeyframeButton, Section, Toggle } from '../ui.tsx'

interface PropSpec {
  prop: AnimatableProp
  label: string
  min: number
  max: number
  step: number
  /** Model value → displayed value. */
  scale: number
  unit: string
  def: number
}

const PROPS: readonly PropSpec[] = [
  {
    prop: 'x',
    label: 'Position X',
    min: -1080,
    max: 2160,
    step: 1,
    scale: 1,
    unit: ' px',
    def: 540,
  },
  {
    prop: 'y',
    label: 'Position Y',
    min: -1920,
    max: 3840,
    step: 1,
    scale: 1,
    unit: ' px',
    def: 960,
  },
  { prop: 'scale', label: 'Scale', min: 1, max: 500, step: 1, scale: 100, unit: '%', def: 100 },
  {
    prop: 'rotation',
    label: 'Rotation',
    min: -180,
    max: 180,
    step: 1,
    scale: 1,
    unit: '°',
    def: 0,
  },
  { prop: 'opacity', label: 'Opacity', min: 0, max: 100, step: 1, scale: 100, unit: '%', def: 100 },
]

/** One animatable property: slider + keyframe diamond. */
export function AnimatableRow({ clip, spec }: { clip: VisualClip; spec: PropSpec }) {
  const fps = useFps()
  const a = clip.transform[spec.prop]
  const animated = a.keyframes.length > 0
  const t = useKeyframeTime(clip, animated)
  const value = valueAt(a, t) * spec.scale
  return (
    <div className="flex items-end gap-1">
      <Slider
        className="min-w-0 flex-1"
        label={spec.label}
        value={Math.round(value * 100) / 100}
        min={spec.min}
        max={spec.max}
        step={spec.step}
        defaultValue={spec.def}
        unit={spec.unit}
        {...gesture<number>(spec.label, (d, v) =>
          setTransformProp(d, clip.id, spec.prop, v / spec.scale, keyframeTimeNow(clip), fps),
        )}
      />
      <KeyframeButton
        label={spec.label}
        active={animated && hasKeyframeAt(a, t, fps)}
        animated={animated}
        onToggle={() =>
          edit('Keyframe', (d) =>
            toggleTransformKeyframe(d, clip.id, spec.prop, keyframeTimeNow(clip), fps),
          )
        }
      />
    </div>
  )
}

const FITS = [
  { value: 'cover', label: 'Fill' },
  { value: 'contain', label: 'Fit' },
  { value: 'fill', label: 'Stretch' },
] as const

const BLENDS = [
  'normal',
  'screen',
  'multiply',
  'overlay',
  'lighten',
  'darken',
  'add',
] as const satisfies readonly MediaClip['blendMode'][]

const MOTIONS = [
  { value: 'none', label: 'None' },
  { value: 'zoomIn', label: 'Zoom in' },
  { value: 'zoomOut', label: 'Zoom out' },
  { value: 'panLeft', label: 'Pan left' },
  { value: 'panRight', label: 'Pan right' },
] as const

function CropControls({ clip }: { clip: MediaClip }) {
  const sides = [
    ['left', 'Crop left'],
    ['right', 'Crop right'],
    ['top', 'Crop top'],
    ['bottom', 'Crop bottom'],
  ] as const
  return (
    <Section title="Crop" collapsible defaultOpen={false}>
      {sides.map(([side, label]) => (
        <Slider
          key={side}
          label={label}
          value={Math.round(clip.crop[side] * 100)}
          min={0}
          max={95}
          step={1}
          defaultValue={0}
          unit="%"
          {...gesture<number>('Crop', (d, v) => setCrop(d, clip.id, { [side]: v / 100 }))}
        />
      ))}
    </Section>
  )
}

export function TransformSection({ clip, onOverlay }: { clip: VisualClip; onOverlay?: boolean }) {
  const media = isMedia(clip as Clip) ? (clip as MediaClip) : undefined
  return (
    <>
      <Section
        title="Transform"
        action={
          <Button
            size="sm"
            variant="ghost"
            icon={<RotateCcw size={14} />}
            onClick={() => edit('Reset transform', (d) => resetTransform(d, clip.id))}
          >
            Reset
          </Button>
        }
      >
        {media && (
          <SegmentedControl
            label="Fit"
            options={FITS}
            value={media.fit}
            onChange={(fit) => edit('Fit', (d) => setMediaProps(d, media.id, { fit }))}
          />
        )}
        {PROPS.map((spec) => (
          <AnimatableRow key={spec.prop} clip={clip} spec={spec} />
        ))}
        <div className="flex gap-2">
          <Button
            size="sm"
            icon={<FlipHorizontal2 size={16} />}
            aria-pressed={clip.transform.flipH}
            variant={clip.transform.flipH ? 'primary' : 'secondary'}
            onClick={() => edit('Flip', (d) => setFlip(d, clip.id, 'flipH', !clip.transform.flipH))}
          >
            Flip H
          </Button>
          <Button
            size="sm"
            icon={<FlipVertical2 size={16} />}
            aria-pressed={clip.transform.flipV}
            variant={clip.transform.flipV ? 'primary' : 'secondary'}
            onClick={() => edit('Flip', (d) => setFlip(d, clip.id, 'flipV', !clip.transform.flipV))}
          >
            Flip V
          </Button>
        </div>
      </Section>
      {media && <CropControls clip={media} />}
      {media && onOverlay && (
        <Section title="Blend" collapsible defaultOpen={false}>
          <label className="flex items-center justify-between gap-3 text-[15px]">
            Blend mode
            <select
              className="h-10 rounded-lg border border-line bg-surface-2 px-2 text-sm capitalize"
              value={media.blendMode}
              onChange={(e) =>
                edit('Blend mode', (d) =>
                  setMediaProps(d, media.id, {
                    blendMode: e.target.value as MediaClip['blendMode'],
                  }),
                )
              }
            >
              {BLENDS.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>
        </Section>
      )}
      {media?.type === 'image' && (
        <Section title="Photo motion" collapsible>
          <SegmentedControl
            label="Auto motion"
            size="sm"
            options={MOTIONS}
            value={media.autoMotion}
            onChange={(autoMotion) =>
              edit('Photo motion', (d) => setMediaProps(d, media.id, { autoMotion }))
            }
          />
        </Section>
      )}
      {media?.type === 'video' && (
        <Toggle
          label="Reverse"
          checked={media.reverse}
          onChange={(on) => edit('Reverse', (d) => setMediaProps(d, media.id, { reverse: on }))}
        />
      )}
    </>
  )
}
