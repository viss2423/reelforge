/**
 * Captions: one-tap auto captions, the trending style gallery (applies instantly), caption
 * options, the transcript editor and filler-word removal.
 */
import type { CaptionStyle, Captions } from '@reelforge/core'
import { Captions as CaptionsIcon, Eraser, Languages } from 'lucide-react'
import { useRef, useState, type PointerEvent } from 'react'
import { Button } from '@/components/Button.tsx'
import { SegmentedControl } from '@/components/SegmentedControl.tsx'
import { Slider } from '@/components/Slider.tsx'
import { Tabs } from '@/components/Tabs.tsx'
import { useEditor } from '@/state/selectors.ts'
import { captionStyleFor, startCaptions, startFillers } from '../ai/launch.ts'
import { TaskCard } from '../ai/TaskCard.tsx'
import { usePacksData } from '../hooks.ts'
import { catalog } from '../model/catalog.ts'
import { edit, gesture, type GestureHandlers } from '../model/commands.ts'
import { clamp } from '../model/draft.ts'
import { applyCaptionStyle, setCaptionStyle, setCaptionsProps } from '../model/transcript.ts'
import { usePackFonts } from '../sections/TextSection.tsx'
import { textPreviewStyle } from '../textPreview.ts'
import {
  Advanced,
  Chips,
  Gallery,
  PackThumb,
  PanelBody,
  Section,
  SwatchPicker,
  Tile,
  Toggle,
} from '../ui.tsx'
import { TranscriptEditor } from './TranscriptEditor.tsx'

/** Languages offered for transcription (whisper supports ~100; these cover most creators). */
export const LANGUAGES = [
  ['auto', 'Auto-detect'],
  ['en', 'English'],
  ['es', 'Spanish'],
  ['pt', 'Portuguese'],
  ['fr', 'French'],
  ['de', 'German'],
  ['it', 'Italian'],
  ['nl', 'Dutch'],
  ['hi', 'Hindi'],
  ['ar', 'Arabic'],
  ['tr', 'Turkish'],
  ['ru', 'Russian'],
  ['pl', 'Polish'],
  ['id', 'Indonesian'],
  ['vi', 'Vietnamese'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['zh', 'Chinese'],
] as const

const MODES = [
  { value: 'karaoke', label: 'Karaoke' },
  { value: 'word-by-word', label: 'Word by word' },
  { value: 'pop', label: 'Pop' },
  { value: 'bounce', label: 'Bounce' },
  { value: 'typewriter', label: 'Typewriter' },
  { value: 'line', label: 'Line' },
] as const

const LINES = [
  { value: 1, label: '1 line' },
  { value: 2, label: '2 lines' },
  { value: 3, label: '3 lines' },
] as const

export function LanguageSelect({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  return (
    <label className="flex min-h-11 items-center gap-2 text-sm text-muted">
      <Languages size={16} aria-hidden />
      <span className="sr-only">Language</span>
      <select
        className="h-9 rounded-lg bg-surface-2 px-2 text-sm font-semibold text-fg"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {LANGUAGES.map(([code, name]) => (
          <option key={code} value={code}>
            {name}
          </option>
        ))}
      </select>
    </label>
  )
}

/** Preview of a caption style: three words, the middle one "spoken". */
function CaptionSample({ style }: { style: CaptionStyle }) {
  const base = textPreviewStyle(style.base, 0.2)
  return (
    <span className="px-1 text-center" style={base}>
      <span>THE </span>
      <span style={{ color: style.activeColor, backgroundColor: style.activeBackgroundColor }}>
        BEST
      </span>
      <span> PART</span>
    </span>
  )
}

function StyleGallery({
  selectedRef,
  onPick,
}: {
  selectedRef: string | undefined
  onPick: (style: CaptionStyle, ref: string) => void
}) {
  const packs = usePacksData()
  usePackFonts(packs)
  const styles = catalog(packs, 'captionStyles')
  if (styles.length === 0) return null
  return (
    <Gallery label="Caption styles">
      {styles.map((s) => (
        <Tile
          key={s.ref}
          label={s.item.name}
          selected={selectedRef === s.ref}
          onClick={() => onPick(s.item.style, s.ref)}
          testId={`caption-style-${s.item.id}`}
        >
          {s.thumbPath ? <PackThumb path={s.thumbPath} /> : <CaptionSample style={s.item.style} />}
        </Tile>
      ))}
    </Gallery>
  )
}

/** Drag the caption block up and down a miniature 9:16 frame. */
function PositionPad({ y, handlers }: { y: number; handlers: GestureHandlers<number> }) {
  const ref = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const toY = (e: PointerEvent) => {
    const r = ref.current?.getBoundingClientRect()
    if (!r || r.height === 0) return y
    return Math.round(clamp(((e.clientY - r.top) / r.height) * 1920, 0, 1920))
  }
  return (
    <div
      ref={ref}
      role="presentation"
      className="relative aspect-[9/16] w-20 shrink-0 touch-none rounded-lg border border-line bg-surface-2"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        dragging.current = true
        handlers.onChangeStart()
        handlers.onChange(toY(e))
      }}
      onPointerMove={(e) => {
        if (dragging.current) handlers.onChange(toY(e))
      }}
      onPointerUp={() => {
        if (!dragging.current) return
        dragging.current = false
        handlers.onChangeEnd()
      }}
      onPointerCancel={() => {
        dragging.current = false
        handlers.onChangeEnd()
      }}
    >
      <div
        className="absolute inset-x-1.5 h-2.5 -translate-y-1/2 rounded bg-accent"
        style={{ top: `${(y / 1920) * 100}%` }}
      />
    </div>
  )
}

function CaptionOptions({ captions }: { captions: Captions }) {
  const st = captions.style
  const set = (label: string, patch: Parameters<typeof setCaptionStyle>[1]) =>
    edit(label, (d) => setCaptionStyle(d, patch))
  const yHandlers = gesture<number>('Caption position', (d, y) => setCaptionStyle(d, { y }))
  return (
    <>
      <Section title="Layout">
        <Toggle
          label="Show captions"
          checked={captions.enabled}
          onChange={(enabled) => edit('Show captions', (d) => setCaptionsProps(d, { enabled }))}
        />
        <Chips
          label="Animation"
          options={MODES}
          value={st.mode}
          onChange={(mode) => set('Caption animation', { mode })}
        />
        <div className="flex items-center gap-4">
          <PositionPad y={st.y} handlers={yHandlers} />
          <Slider
            className="flex-1"
            label="Position"
            value={st.y}
            min={0}
            max={1920}
            step={10}
            defaultValue={1300}
            unit=" px"
            {...yHandlers}
          />
        </div>
        <Slider
          label="Size"
          value={st.base.fontSize}
          min={24}
          max={200}
          step={1}
          defaultValue={72}
          unit=" px"
          {...gesture<number>('Caption size', (d, fontSize) =>
            setCaptionStyle(d, { base: { fontSize } }),
          )}
        />
        <Toggle
          label="All caps"
          checked={st.base.uppercase}
          onChange={(uppercase) => set('Caption caps', { base: { uppercase } })}
        />
      </Section>
      <Section title="Highlight">
        <SwatchPicker
          label="Spoken word colour"
          value={st.activeColor}
          {...gesture<string>('Highlight colour', (d, activeColor) =>
            setCaptionStyle(d, { activeColor }),
          )}
        />
      </Section>
      <Advanced id="captions">
        <Slider
          label="Words per line"
          value={st.maxWordsPerLine}
          min={1}
          max={12}
          step={1}
          defaultValue={3}
          {...gesture<number>('Words per line', (d, v) =>
            setCaptionStyle(d, { maxWordsPerLine: v }),
          )}
        />
        <SegmentedControl
          label="Lines"
          options={LINES}
          value={st.maxLines}
          onChange={(maxLines) => set('Caption lines', { maxLines })}
        />
        <Toggle
          label="Emphasise keywords"
          description="Numbers, power words and shouted words stand out"
          checked={st.emphasizeKeywords}
          onChange={(emphasizeKeywords) => set('Keyword emphasis', { emphasizeKeywords })}
        />
        {st.emphasizeKeywords && (
          <SwatchPicker
            label="Keyword colour"
            value={st.keywordColor}
            {...gesture<string>('Keyword colour', (d, keywordColor) =>
              setCaptionStyle(d, { keywordColor }),
            )}
          />
        )}
      </Advanced>
    </>
  )
}

type Tab = 'style' | 'options' | 'transcript'

export function CaptionsPanel() {
  const packs = usePacksData()
  const captions = useEditor((s) => s.project?.captions)
  const [language, setLanguage] = useState(captions?.language ?? 'auto')
  const [pending, setPending] = useState<{ style: CaptionStyle; ref: string } | null>(null)
  const [tab, setTab] = useState<Tab>('style')

  const generate = () => {
    const fallback = captionStyleFor(packs)
    const style = pending?.style ?? fallback.style
    const ref = pending?.ref ?? fallback.ref
    startCaptions({ style, language, ...(ref ? { styleRef: ref } : {}) })
  }
  const pickStyle = (style: CaptionStyle, ref: string) => {
    if (captions) edit('Caption style', (d) => applyCaptionStyle(d, style, ref))
    else setPending({ style, ref })
  }
  const hasWords = (captions?.words.length ?? 0) > 0

  return (
    <PanelBody>
      <section aria-label="Auto captions" className="flex flex-col gap-1">
        <TaskCard id="captions">
          <Button
            variant="primary"
            size="lg"
            block
            className="panels-cta"
            icon={<CaptionsIcon size={18} />}
            onClick={generate}
          >
            {hasWords ? 'Regenerate captions' : 'Generate captions'}
          </Button>
        </TaskCard>
        <div className="flex flex-wrap items-center justify-between gap-x-2">
          <LanguageSelect
            value={language}
            onChange={(v) => {
              setLanguage(v)
              if (captions) edit('Caption language', (d) => setCaptionsProps(d, { language: v }))
            }}
          />
          <TaskCard id="fillers">
            {hasWords && (
              <Button
                size="sm"
                variant="ghost"
                icon={<Eraser size={16} />}
                onClick={() => startFillers(language)}
              >
                Remove filler words
              </Button>
            )}
          </TaskCard>
        </div>
      </section>
      <Tabs
        label="Caption settings"
        items={[
          { id: 'style', label: 'Style' },
          { id: 'options', label: 'Options' },
          { id: 'transcript', label: 'Transcript' },
        ]}
        value={tab}
        onChange={setTab}
      >
        {(active) =>
          active === 'style' ? (
            <StyleGallery
              selectedRef={captions ? captions.styleRef : pending?.ref}
              onPick={pickStyle}
            />
          ) : active === 'options' ? (
            captions ? (
              <CaptionOptions captions={captions} />
            ) : (
              <p className="text-sm text-muted">Generate captions to adjust their layout.</p>
            )
          ) : (
            <TranscriptEditor />
          )
        }
      </Tabs>
    </PanelBody>
  )
}
