/**
 * Text: inline content editing, the trending preset gallery and the full style editor.
 * Typing coalesces into one undo step per burst; sliders are one step per drag.
 */
import type { TextClip, TextPreset, TextStyle } from '@reelforge/core'
import { AlignCenter, AlignLeft, AlignRight } from 'lucide-react'
import { useEffect } from 'react'
import { ColorPicker } from '@/components/ColorPicker.tsx'
import { SegmentedControl } from '@/components/SegmentedControl.tsx'
import { Slider } from '@/components/Slider.tsx'
import type { Packs } from '@/api/schemas.ts'
import { usePacksData } from '../hooks.ts'
import { catalog, fontFamilies, type CatalogItem } from '../model/catalog.ts'
import { edit, gesture } from '../model/commands.ts'
import { applyTextPreset, setOverlayDuration, setText, setTextStyle } from '../model/edits.ts'
import { FALLBACK_FAMILIES, registerPackFonts, textPreviewStyle } from '../textPreview.ts'
import { Gallery, PackThumb, SecondsSlider, Section, Tile, Toggle } from '../ui.tsx'

/** Tile scale: canvas px → tile px for a ~96 px wide tile. */
const TILE_SCALE = 0.22

/** Registers pack fonts once packs are known (tiles render in the real typefaces). */
export const usePackFonts = (packs: Packs | undefined): void => {
  useEffect(() => registerPackFonts(packs), [packs])
}

/** Trending text presets; `onPick` either restyles a clip or inserts new text. */
export function TextPresetGallery({
  selectedRef,
  onPick,
}: {
  selectedRef?: string | undefined
  onPick: (preset: CatalogItem<TextPreset>) => void
}) {
  const packs = usePacksData()
  usePackFonts(packs)
  const presets = catalog(packs, 'textPresets')
  if (presets.length === 0) return null
  return (
    <Gallery label="Text styles">
      {presets.map((p) => (
        <Tile
          key={p.ref}
          label={p.item.name}
          selected={selectedRef === p.ref}
          onClick={() => onPick(p)}
          testId={`text-preset-${p.item.id}`}
        >
          {p.thumbPath ? (
            <PackThumb path={p.thumbPath} />
          ) : (
            <span
              className="max-w-full px-1 text-center"
              style={textPreviewStyle(p.item.style, TILE_SCALE)}
            >
              {p.item.sampleText}
            </span>
          )}
        </Tile>
      ))}
    </Gallery>
  )
}

const ALIGNS = [
  { value: 'left', label: <AlignLeft size={16} aria-label="Left" /> },
  { value: 'center', label: <AlignCenter size={16} aria-label="Centre" /> },
  { value: 'right', label: <AlignRight size={16} aria-label="Right" /> },
] as const

/** Font family list (pack fonts, each label drawn in its own typeface). */
function FontPicker({
  style,
  onPick,
}: {
  style: TextStyle
  onPick: (family: string, weights: number[]) => void
}) {
  const packs = usePacksData()
  usePackFonts(packs)
  const families = fontFamilies(packs)
  const list = families.length
    ? families
    : FALLBACK_FAMILIES.map((family) => ({ family, weights: [] as number[] }))
  return (
    <div role="radiogroup" aria-label="Font" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
      {list.map((f) => (
        <button
          key={f.family}
          type="button"
          role="radio"
          aria-checked={style.fontFamily === f.family}
          onClick={() => onPick(f.family, f.weights)}
          className={
            style.fontFamily === f.family
              ? 'h-11 shrink-0 rounded-xl border-2 border-accent bg-surface-2 px-3 text-base whitespace-nowrap'
              : 'h-11 shrink-0 rounded-xl border-2 border-transparent bg-surface-2 px-3 text-base whitespace-nowrap'
          }
          style={{ fontFamily: `"${f.family}", system-ui, sans-serif` }}
        >
          {f.family}
        </button>
      ))}
    </div>
  )
}

/** Nearest available weight (fonts ship a few static weights). */
export const nearestWeight = (weights: readonly number[], want: number): number =>
  weights.length === 0
    ? want
    : weights.reduce((best, w) => (Math.abs(w - want) < Math.abs(best - want) ? w : best))

export function TextStyleEditor({ clip }: { clip: TextClip }) {
  const s = clip.style
  const id = clip.id
  const style = (label: string, patch: Partial<TextStyle>) =>
    edit(label, (d) => setTextStyle(d, id, patch))
  const styleGesture = <K extends keyof TextStyle>(
    label: string,
    key: K,
    map?: (v: number) => TextStyle[K],
  ) =>
    gesture<number>(label, (d, v) =>
      setTextStyle(d, id, { [key]: map ? map(v) : v } as Partial<TextStyle>),
    )
  return (
    <>
      <Section title="Font">
        <FontPicker
          style={s}
          onPick={(fontFamily, weights) =>
            style('Font', { fontFamily, fontWeight: nearestWeight(weights, s.fontWeight) })
          }
        />
        <Slider
          label="Size"
          value={s.fontSize}
          min={8}
          max={400}
          step={1}
          defaultValue={72}
          unit=" px"
          {...styleGesture('Text size', 'fontSize')}
        />
        <Slider
          label="Weight"
          value={s.fontWeight}
          min={100}
          max={900}
          step={100}
          defaultValue={800}
          {...styleGesture('Font weight', 'fontWeight')}
        />
        <SegmentedControl
          label="Align"
          options={ALIGNS}
          value={s.align}
          onChange={(align) => style('Align', { align })}
        />
        <Toggle
          label="All caps"
          checked={s.uppercase}
          onChange={(uppercase) => style('All caps', { uppercase })}
        />
        <Toggle
          label="Italic"
          checked={s.italic}
          onChange={(italic) => style('Italic', { italic })}
        />
      </Section>
      <Section title="Colour">
        <ColorPicker
          label="Text colour"
          value={s.color}
          {...gesture<string>('Text colour', (d, color) => setTextStyle(d, id, { color }))}
        />
      </Section>
      <Section title="Outline" collapsible>
        <Slider
          label="Outline width"
          value={s.strokeWidth}
          min={0}
          max={40}
          step={1}
          defaultValue={6}
          {...styleGesture('Outline width', 'strokeWidth')}
        />
        {s.strokeWidth > 0 && (
          <ColorPicker
            label="Outline colour"
            value={s.strokeColor}
            {...gesture<string>('Outline colour', (d, strokeColor) =>
              setTextStyle(d, id, { strokeColor }),
            )}
          />
        )}
      </Section>
      <Section title="Shadow" collapsible defaultOpen={false}>
        <Slider
          label="Shadow blur"
          value={s.shadowBlur}
          min={0}
          max={40}
          step={1}
          defaultValue={0}
          {...styleGesture('Shadow blur', 'shadowBlur')}
        />
        <Slider
          label="Shadow X"
          value={s.shadowX}
          min={-50}
          max={50}
          step={1}
          defaultValue={0}
          {...styleGesture('Shadow offset', 'shadowX')}
        />
        <Slider
          label="Shadow Y"
          value={s.shadowY}
          min={-50}
          max={50}
          step={1}
          defaultValue={4}
          {...styleGesture('Shadow offset', 'shadowY')}
        />
        <ColorPicker
          label="Shadow colour"
          alpha
          value={s.shadowColor}
          {...gesture<string>('Shadow colour', (d, shadowColor) =>
            setTextStyle(d, id, { shadowColor }),
          )}
        />
      </Section>
      <Section title="Background" collapsible defaultOpen={false}>
        <Toggle
          label="Background box"
          checked={s.backgroundColor !== undefined}
          onChange={(on) =>
            style('Background box', { backgroundColor: on ? '#000000B3' : undefined })
          }
        />
        {s.backgroundColor !== undefined && (
          <>
            <ColorPicker
              label="Box colour"
              alpha
              value={s.backgroundColor}
              {...gesture<string>('Box colour', (d, backgroundColor) =>
                setTextStyle(d, id, { backgroundColor }),
              )}
            />
            <Slider
              label="Box padding"
              value={s.backgroundPadding}
              min={0}
              max={80}
              step={1}
              defaultValue={16}
              {...styleGesture('Box padding', 'backgroundPadding')}
            />
            <Slider
              label="Corner radius"
              value={s.backgroundRadius}
              min={0}
              max={80}
              step={1}
              defaultValue={12}
              {...styleGesture('Corner radius', 'backgroundRadius')}
            />
          </>
        )}
      </Section>
      <Section title="Spacing" collapsible defaultOpen={false}>
        <Slider
          label="Letter spacing"
          value={s.letterSpacing}
          min={-20}
          max={60}
          step={1}
          defaultValue={0}
          {...styleGesture('Letter spacing', 'letterSpacing')}
        />
        <Slider
          label="Line height"
          value={s.lineHeight}
          min={0.6}
          max={3}
          step={0.05}
          defaultValue={1.1}
          {...styleGesture('Line height', 'lineHeight')}
        />
        <Slider
          label="Max width"
          value={s.maxWidth}
          min={100}
          max={1080}
          step={10}
          defaultValue={900}
          unit=" px"
          {...styleGesture('Text box width', 'maxWidth')}
        />
      </Section>
    </>
  )
}

export function TextContent({ clip }: { clip: TextClip }) {
  return (
    <Section title="Text">
      <textarea
        aria-label="Text"
        value={clip.text}
        rows={3}
        maxLength={2000}
        // One undo step per typing burst, not per keystroke.
        onChange={(e) =>
          edit('Edit text', (d) => setText(d, clip.id, e.target.value), {
            coalesce: `text:${clip.id}`,
          })
        }
        className="w-full resize-none rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-base outline-none focus:border-accent"
        style={{ fontFamily: `"${clip.style.fontFamily}", system-ui, sans-serif` }}
      />
      <SecondsSlider
        label="Duration"
        value={clip.duration}
        min={100_000}
        max={Math.max(clip.duration, 30_000_000)}
        step={0.1}
        handlers={gesture<number>('Text duration', (d, v) => setOverlayDuration(d, clip.id, v))}
      />
    </Section>
  )
}

/** Everything for one text clip. */
export function TextSection({ clip }: { clip: TextClip }) {
  return (
    <>
      <TextContent clip={clip} />
      <Section title="Presets">
        <TextPresetGallery
          selectedRef={clip.presetRef}
          onPick={(p) =>
            edit(`Style: ${p.item.name}`, (d) => applyTextPreset(d, clip.id, p.item, p.ref))
          }
        />
      </Section>
      <TextStyleEditor clip={clip} />
    </>
  )
}
