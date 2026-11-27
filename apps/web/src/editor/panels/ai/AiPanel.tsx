/**
 * Magic: the Auto edit hero, then a grid of one-word tools. A tile opens its options in a
 * nested view; running tasks show as slim rows pinned on top; "Ask Magic…" finds the tool
 * for a short request. Every tool runs on the host, can be cancelled or retried, and lands
 * as a single undo step.
 */
import type { AudioClip, MediaClip } from '@reelforge/core'
import {
  ArrowUp,
  AudioWaveform,
  Captions,
  ChevronDown,
  ChevronLeft,
  Crop,
  Eraser,
  Highlighter,
  Mic,
  Music,
  Scissors,
  ScissorsLineDashed,
  Sparkles,
  Type,
  UserRoundX,
  Wand2,
} from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { Button } from '@/components/Button.tsx'
import { ProgressRing } from '@/components/ProgressRing.tsx'
import { SegmentedControl } from '@/components/SegmentedControl.tsx'
import { toast } from '@/components/Toast.tsx'
import { cn } from '@/lib/cn.ts'
import { haptic } from '@/lib/haptics.ts'
import { editorStore } from '@/state/editorStore.ts'
import { useEditor, useEditorShallow } from '@/state/selectors.ts'
import { usePacksData } from '../hooks.ts'
import { edit } from '../model/commands.ts'
import { hasAudio, isAudioClip, isVideo, mainClipAt, mainMediaClips } from '../model/draft.ts'
import { setAudio } from '../model/edits.ts'
import { CLIP_PANEL, ROOT_PANEL } from '../panelIds.ts'
import { Chips, Hint, PanelBody, Toggle } from '../ui.tsx'
import { AutoEditHero, CopyResult, NeedsModel, useLlmInstalled } from './AiAssistant.tsx'
import { routeAsk, type MagicToolId } from './ask.ts'
import { TARGETS } from './autoedit/flow.ts'
import { landscapeClips, musicClips, type BeatCut } from './flows.ts'
import {
  captionStyleFor,
  startBeatSync,
  startCaptions,
  startFillers,
  startMagic,
  startReframe,
  startScenes,
  startSilence,
} from './launch.ts'
import { startBestMoments, startCopywriter, startImproveCaptions } from './llmtools.ts'
import { useAiTask, type AiTaskId } from './tasks.ts'
import { TaskStrip } from './TaskStrip.tsx'

/** Pause lengths offered for silence removal (µs). */
const PACES = [
  { value: 'natural', label: 'Natural', minSilence: 700_000 },
  { value: 'tight', label: 'Tight', minSilence: 400_000 },
  { value: 'fast', label: 'Fast', minSilence: 200_000 },
] as const
type Pace = (typeof PACES)[number]['value']

/** Camera tracking strength for auto reframe. */
const TRACKING = [
  { value: 'calm', label: 'Calm', strength: 0.15 },
  { value: 'balanced', label: 'Balanced', strength: 0.5 },
  { value: 'tight', label: 'Tight', strength: 0.85 },
] as const
type Tracking = (typeof TRACKING)[number]['value']

const CUTS: ReadonlyArray<{ value: BeatCut; label: string }> = [
  { value: 'beat', label: 'Beat' },
  { value: 'beat2', label: '2 beats' },
  { value: 'bar', label: 'Bar' },
  { value: 'bar2', label: '2 bars' },
]

const TARGET_OPTIONS = TARGETS.map((t) => ({ value: String(t), label: `${t} s` }))

interface ToolDef {
  id: MagicToolId
  label: string
  /** One line in the tool's view. */
  blurb: string
  icon: ReactNode
  /** The AI task the tool runs (drives the tile's status dot). */
  task?: AiTaskId
  needsModel?: boolean
}

const TOOLS: readonly ToolDef[] = [
  {
    id: 'captions',
    label: 'Captions',
    blurb: 'Word-by-word captions in the trending style.',
    icon: <Captions size={22} />,
    task: 'captions',
  },
  {
    id: 'silence',
    label: 'Silences',
    blurb: 'Cut the pauses. You see what it saves first.',
    icon: <AudioWaveform size={22} />,
    task: 'silence',
  },
  {
    id: 'copy',
    label: 'Hook',
    blurb: 'Hook titles, a post caption and hashtags.',
    icon: <Type size={22} />,
    task: 'copy',
    needsModel: true,
  },
  {
    id: 'beats',
    label: 'Beat sync',
    blurb: 'Cut your clips on the beat of the music.',
    icon: <Music size={22} />,
    task: 'beats',
  },
  {
    id: 'reframe',
    label: 'Reframe',
    blurb: 'Follow the subject when landscape goes 9:16.',
    icon: <Crop size={22} />,
    task: 'reframe',
  },
  {
    id: 'removebg',
    label: 'Remove BG',
    blurb: 'Cut the subject out of the clip.',
    icon: <UserRoundX size={22} />,
  },
  // Behind "More tools".
  {
    id: 'voice',
    label: 'Clean audio',
    blurb: 'Clearer voices, less background noise.',
    icon: <Mic size={22} />,
  },
  {
    id: 'highlights',
    label: 'Highlights',
    blurb: 'Keep the hook and the strongest moments.',
    icon: <Scissors size={22} />,
    task: 'highlights',
  },
  {
    id: 'fillers',
    label: 'Fillers',
    blurb: 'Cut the “um”s and “uh”s.',
    icon: <Eraser size={22} />,
    task: 'fillers',
  },
  {
    id: 'scenes',
    label: 'Scenes',
    blurb: 'Split long takes into shots.',
    icon: <ScissorsLineDashed size={22} />,
    task: 'scenes',
  },
  {
    id: 'emphasis',
    label: 'Caption pop',
    blurb: 'Highlight key words, add emoji and chapters.',
    icon: <Highlighter size={22} />,
    task: 'emphasis',
    needsModel: true,
  },
  {
    id: 'magic',
    label: 'Quick clean',
    blurb: 'Silences, fillers, beat sync and captions in one tap.',
    icon: <Wand2 size={22} />,
    task: 'magic',
  },
]

/** Tiles shown before "More tools". */
const FIRST = 6

const toolById = (id: MagicToolId): ToolDef => TOOLS.find((t) => t.id === id)!

/* ------------------------------------------------------------------ shared bits */

/** The tool's one action: the gradient button, busy while its task runs. */
function Action({
  task,
  icon,
  children,
  disabled,
  onClick,
}: {
  task?: AiTaskId | undefined
  icon?: ReactNode
  children: string
  disabled?: boolean
  onClick: () => void
}) {
  const state = useAiTask(task ?? 'magic')
  const running = !!task && state?.status === 'running'
  return (
    <Button
      variant="primary"
      size="lg"
      block
      className="panels-cta"
      icon={icon ?? <Sparkles size={18} />}
      loading={running}
      disabled={disabled}
      onClick={() => {
        haptic(8)
        onClick()
      }}
    >
      {children}
    </Button>
  )
}

const NO_CLIPS: readonly (MediaClip | AudioClip)[] = []

/** Speech-carrying clips the voice toggles apply to (main/overlay video and voiceovers). */
const useVoiceClips = () =>
  useEditorShallow((s) => {
    if (!s.project) return NO_CLIPS
    const out: (MediaClip | AudioClip)[] = []
    for (const t of s.project.tracks)
      for (const c of t.clips) {
        if (isVideo(c) && t.kind !== 'audio') out.push(c)
        else if (isAudioClip(c) && c.role === 'voiceover') out.push(c)
      }
    return out
  })

/* ------------------------------------------------------------------ tool views */

function VoiceTool() {
  const clips = useVoiceClips()
  const ids = clips.map((c) => c.id)
  const all = (k: 'enhanceVoice' | 'denoise') =>
    clips.length > 0 && clips.every((c) => hasAudio(c) && c.audio[k])
  return (
    <div className="flex flex-col gap-1">
      <Toggle
        label="Enhance voice"
        description="Studio EQ and compression"
        disabled={clips.length === 0}
        checked={all('enhanceVoice')}
        onChange={(on) => edit('Enhance voice', (d) => setAudio(d, ids, { enhanceVoice: on }))}
      />
      <Toggle
        label="Reduce noise"
        description="Removes hum, wind and room noise"
        disabled={clips.length === 0}
        checked={all('denoise')}
        onChange={(on) => edit('Reduce noise', (d) => setAudio(d, ids, { denoise: on }))}
      />
    </div>
  )
}

function BeatSyncTool() {
  const music = useEditorShallow((s) => (s.project ? musicClips(s.project) : []))
  const [chosen, setChosen] = useState<string | null>(null)
  const [cut, setCut] = useState<BeatCut>('beat')
  const clipId = chosen && music.some((m) => m.id === chosen) ? chosen : music[0]?.id
  if (music.length === 0)
    return (
      <>
        <Hint>Add a music track first.</Hint>
        <Button
          block
          icon={<Music size={18} />}
          onClick={() => editorStore.getState().setActivePanel(ROOT_PANEL.audio)}
        >
          Add music
        </Button>
      </>
    )
  return (
    <>
      {music.length > 1 && (
        <Chips
          label="Music clip"
          options={music.map((m, i) => ({ value: m.id, label: m.name ?? `Track ${i + 1}` }))}
          value={clipId}
          onChange={setChosen}
        />
      )}
      <SegmentedControl label="Cut on" options={CUTS} value={cut} onChange={setCut} />
      <Action
        task="beats"
        icon={<Music size={18} />}
        disabled={!clipId}
        onClick={() => clipId && startBeatSync({ musicClipId: clipId, cut })}
      >
        Sync to beat
      </Action>
    </>
  )
}

function ToolBody({ id }: { id: MagicToolId }) {
  const packs = usePacksData()
  const llm = useLlmInstalled()
  const language = useEditor((s) => s.project?.captions?.language ?? 'auto')
  const landscape = useEditor((s) => (s.project ? landscapeClips(s.project, s.assets).length : 0))
  const hasCaptions = useEditor((s) => (s.project?.captions?.words.length ?? 0) > 0)
  const [pace, setPace] = useState<Pace>('tight')
  const [tracking, setTracking] = useState<Tracking>('balanced')
  const [target, setTarget] = useState('30')
  const [chapters, setChapters] = useState(true)
  const captionStyle = () => {
    const c = captionStyleFor(packs)
    return { style: c.style, language, ...(c.ref ? { styleRef: c.ref } : {}) }
  }
  switch (id) {
    case 'captions':
      return (
        <Action
          task="captions"
          icon={<Captions size={18} />}
          onClick={() => startCaptions(captionStyle())}
        >
          Generate captions
        </Action>
      )
    case 'silence':
      return (
        <>
          <SegmentedControl label="Pace" options={PACES} value={pace} onChange={setPace} />
          <Action
            task="silence"
            icon={<AudioWaveform size={18} />}
            onClick={() =>
              startSilence({ minSilence: PACES.find((p) => p.value === pace)!.minSilence })
            }
          >
            Find silences
          </Action>
        </>
      )
    case 'fillers':
      return (
        <Action task="fillers" icon={<Eraser size={18} />} onClick={() => startFillers(language)}>
          Find filler words
        </Action>
      )
    case 'copy':
      return (
        <>
          {llm === false && <NeedsModel />}
          <Action
            task="copy"
            icon={<Type size={18} />}
            disabled={llm !== true}
            onClick={() => startCopywriter()}
          >
            Write hook & caption
          </Action>
          <CopyResult />
        </>
      )
    case 'highlights':
      return (
        <>
          <SegmentedControl
            label="Reel length"
            options={TARGET_OPTIONS}
            value={target}
            onChange={setTarget}
          />
          <Action
            task="highlights"
            icon={<Scissors size={18} />}
            onClick={() => startBestMoments(Number(target))}
          >
            Find best moments
          </Action>
        </>
      )
    case 'beats':
      return <BeatSyncTool />
    case 'reframe':
      return (
        <>
          {landscape > 0 ? (
            <SegmentedControl
              label="Camera"
              options={TRACKING}
              value={tracking}
              onChange={setTracking}
            />
          ) : (
            <Hint>No landscape (16:9) clips to reframe.</Hint>
          )}
          <Action
            task="reframe"
            icon={<Crop size={18} />}
            disabled={landscape === 0}
            onClick={() =>
              startReframe(
                undefined,
                undefined,
                TRACKING.find((t) => t.value === tracking)!.strength,
              )
            }
          >
            Reframe to 9:16
          </Action>
        </>
      )
    case 'scenes':
      return (
        <Action task="scenes" icon={<ScissorsLineDashed size={18} />} onClick={() => startScenes()}>
          Split scenes
        </Action>
      )
    case 'emphasis':
      return (
        <>
          {llm === false && <NeedsModel />}
          {!hasCaptions && <Hint>Generate captions first.</Hint>}
          <Toggle
            label="Add chapters"
            description="Topic markers on the timeline"
            checked={chapters}
            onChange={setChapters}
          />
          <Action
            task="emphasis"
            icon={<Highlighter size={18} />}
            disabled={llm !== true || !hasCaptions}
            onClick={() => startImproveCaptions({ chapters })}
          >
            Improve captions
          </Action>
        </>
      )
    case 'voice':
      return <VoiceTool />
    case 'magic':
      return (
        <Action
          task="magic"
          icon={<Wand2 size={18} />}
          onClick={() =>
            startMagic({
              ...captionStyle(),
              ...(llm ? { highlights: { targetSeconds: 60 } } : {}),
            })
          }
        >
          Magic edit
        </Action>
      )
    case 'removebg':
      return null
  }
  return null
}

function ToolView({ id, onBack }: { id: MagicToolId; onBack: () => void }) {
  const tool = toolById(id)
  return (
    <section aria-label={tool.label} className="panels-enter flex flex-col gap-4">
      <header className="-ml-2 flex items-center gap-1">
        <button
          type="button"
          aria-label="Back to Magic"
          onClick={onBack}
          className="grid size-11 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg"
        >
          <ChevronLeft size={22} />
        </button>
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-violet/15 text-violet">
          {tool.icon}
        </span>
        <div className="ml-1.5 flex min-w-0 flex-col">
          <h3 className="text-[17px] leading-tight font-bold">{tool.label}</h3>
          <p className="text-sm leading-snug text-muted">{tool.blurb}</p>
        </div>
      </header>
      <ToolBody id={id} />
    </section>
  )
}

/* ------------------------------------------------------------------ the grid */

function TileStatus({ task }: { task: AiTaskId }) {
  const t = useAiTask(task)
  if (!t) return null
  if (t.status === 'running')
    return (
      <ProgressRing
        value={t.progress}
        size={18}
        stroke={2.5}
        label={`${t.label} running`}
        className="absolute top-2 right-2 text-accent"
      />
    )
  return (
    <span
      aria-label={t.status === 'review' ? 'Ready to review' : 'Failed'}
      className={cn(
        'absolute top-2.5 right-2.5 size-2.5 rounded-full',
        t.status === 'review' ? 'bg-accent' : 'bg-danger',
      )}
    />
  )
}

function ToolTile({ tool, onOpen }: { tool: ToolDef; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={() => {
        haptic(5)
        onOpen()
      }}
      className="relative flex min-h-[4.5rem] items-center gap-3 rounded-2xl bg-surface-2 px-3 text-left transition-[background-color,transform] duration-150 hover:bg-surface-3 active:scale-[0.97]"
    >
      <span
        className="grid size-10 shrink-0 place-items-center rounded-xl bg-violet/15 text-violet"
        aria-hidden
      >
        {tool.icon}
      </span>
      <span className="min-w-0 text-[15px] leading-tight font-semibold">{tool.label}</span>
      {tool.task && <TileStatus task={tool.task} />}
    </button>
  )
}

/** Selects the main clip under the playhead and opens its Background panel. */
const openRemoveBackground = () => {
  const s = editorStore.getState()
  if (!s.project) return
  const clip = mainClipAt(s.project, s.playhead) ?? mainMediaClips(s.project)[0]
  if (!clip) {
    toast('Add a video or photo first')
    return
  }
  s.select([clip.id])
  s.setActivePanel(CLIP_PANEL.background)
}

function AskMagic({ onRoute }: { onRoute: (id: MagicToolId | 'autoedit') => void }) {
  const [q, setQ] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const r = routeAsk(q)
    if (r.kind === 'unknown') {
      toast('Try “add captions”, “cut the pauses” or “add music”')
      return
    }
    setQ('')
    if (r.kind === 'music') editorStore.getState().setActivePanel(ROOT_PANEL.audio)
    else if (r.kind === 'autoedit') onRoute('autoedit')
    else onRoute(r.id)
  }
  return (
    <form
      onSubmit={submit}
      role="search"
      aria-label="Ask Magic"
      className="flex h-12 items-center gap-2 rounded-full bg-surface-2 pr-1 pl-4 ring-1 ring-line focus-within:ring-accent"
    >
      <Sparkles size={16} className="shrink-0 text-violet" aria-hidden />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Ask Magic… “cut the pauses”"
        aria-label="Ask Magic"
        enterKeyHint="go"
        maxLength={120}
        className="h-full min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-subtle"
      />
      <button
        type="submit"
        aria-label="Ask"
        disabled={q.trim() === ''}
        className="panels-cta grid size-10 shrink-0 place-items-center rounded-full bg-accent text-accent-fg transition-opacity disabled:opacity-30"
      >
        <ArrowUp size={18} />
      </button>
    </form>
  )
}

export function AiPanel() {
  const [view, setView] = useState<MagicToolId | null>(null)
  const [more, setMore] = useState(false)
  const llm = useLlmInstalled()
  const open = (id: MagicToolId) => {
    if (id === 'removebg') openRemoveBackground()
    else setView(id)
  }
  const shown = more ? TOOLS : TOOLS.slice(0, FIRST)
  return (
    <PanelBody>
      <TaskStrip />
      {view ? (
        <ToolView key={view} id={view} onBack={() => setView(null)} />
      ) : (
        <>
          <AutoEditHero />
          <section aria-label="Magic tools" className="flex flex-col gap-2.5">
            <h3 className="text-[13px] font-semibold tracking-wide text-muted uppercase">Tools</h3>
            <div className="grid grid-cols-2 gap-2">
              {shown.map((t) => (
                <ToolTile key={t.id} tool={t} onOpen={() => open(t.id)} />
              ))}
            </div>
            <button
              type="button"
              aria-expanded={more}
              onClick={() => setMore(!more)}
              className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl text-sm font-semibold text-muted hover:text-fg"
            >
              {more ? 'Fewer tools' : 'More tools'}
              <ChevronDown
                size={16}
                className={cn('transition-transform duration-200', more && 'rotate-180')}
              />
            </button>
            {llm === false && <NeedsModel text="Hook and Caption pop need the local AI model." />}
          </section>
          <AskMagic
            onRoute={(id) => {
              if (id === 'autoedit') {
                document
                  .querySelector<HTMLElement>('section[aria-label="Auto edit"] button.panels-cta')
                  ?.focus()
                return
              }
              if (TOOLS.findIndex((t) => t.id === id) >= FIRST) setMore(true)
              open(id)
            }}
          />
        </>
      )}
    </PanelBody>
  )
}
