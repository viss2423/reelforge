/**
 * AI tools, one tap each. Every tool runs on the host, shows live progress, can be
 * cancelled or retried, and lands as a single undo step. "Magic edit" chains them.
 */
import type { AudioClip, MediaClip } from '@reelforge/core'
import {
  AudioWaveform,
  Captions,
  Crop,
  Eraser,
  Music,
  ScissorsLineDashed,
  Sparkles,
  Wand2,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Button } from '@/components/Button.tsx'
import { SegmentedControl } from '@/components/SegmentedControl.tsx'
import { useEditor, useEditorShallow } from '@/state/selectors.ts'
import { usePacksData } from '../hooks.ts'
import { edit } from '../model/commands.ts'
import { hasAudio, isAudioClip, isVideo } from '../model/draft.ts'
import { setAudio } from '../model/edits.ts'
import { Chips, PanelBody, Section, Toggle } from '../ui.tsx'
import { landscapeClips, musicClips } from './flows.ts'
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
import { TaskCard } from './TaskCard.tsx'
import type { AiTaskId } from './tasks.ts'

/** Pause lengths offered for silence removal (µs). */
const PACES = [
  { value: 'natural', label: 'Natural', minSilence: 700_000 },
  { value: 'tight', label: 'Tight', minSilence: 400_000 },
  { value: 'fast', label: 'Fast', minSilence: 200_000 },
] as const
type Pace = (typeof PACES)[number]['value']

const EVERY = [
  { value: 1, label: 'Every beat' },
  { value: 2, label: 'Every 2' },
  { value: 4, label: 'Every 4' },
] as const

function Tool({
  id,
  icon,
  title,
  description,
  children,
  action,
}: {
  id: AiTaskId
  icon: ReactNode
  title: string
  description: string
  children?: ReactNode
  action: ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-line p-3">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-violet/15 text-violet">
          {icon}
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="font-semibold">{title}</span>
          <span className="text-sm text-muted">{description}</span>
        </div>
      </div>
      {children}
      <TaskCard id={id}>{action}</TaskCard>
    </div>
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

function VoiceTools() {
  const clips = useVoiceClips()
  const ids = clips.map((c) => c.id)
  const all = (k: 'enhanceVoice' | 'denoise') =>
    clips.length > 0 && clips.every((c) => hasAudio(c) && c.audio[k])
  return (
    <Section title="Voice">
      <Toggle
        label="Enhance voice"
        description="Studio EQ and compression on every voice clip"
        disabled={clips.length === 0}
        checked={all('enhanceVoice')}
        onChange={(on) => edit('Enhance voice', (d) => setAudio(d, ids, { enhanceVoice: on }))}
      />
      <Toggle
        label="Reduce noise"
        description="AI noise removal on every voice clip"
        disabled={clips.length === 0}
        checked={all('denoise')}
        onChange={(on) => edit('Reduce noise', (d) => setAudio(d, ids, { denoise: on }))}
      />
    </Section>
  )
}

function BeatSyncTool() {
  const music = useEditorShallow((s) => (s.project ? musicClips(s.project) : []))
  const [chosen, setChosen] = useState<string | null>(null)
  const [every, setEvery] = useState<1 | 2 | 4>(1)
  const clipId = chosen && music.some((m) => m.id === chosen) ? chosen : music[0]?.id
  return (
    <Tool
      id="beats"
      icon={<Music size={20} />}
      title="Beat sync"
      description={
        music.length
          ? 'Cut your clips on the beat of the music'
          : 'Add a music track first (Audio tool)'
      }
      action={
        <Button
          block
          disabled={!clipId}
          onClick={() => clipId && startBeatSync({ musicClipId: clipId, every })}
        >
          Sync to beat
        </Button>
      }
    >
      {music.length > 1 && (
        <Chips
          label="Music clip"
          options={music.map((m, i) => ({ value: m.id, label: m.name ?? `Track ${i + 1}` }))}
          value={clipId}
          onChange={setChosen}
        />
      )}
      {music.length > 0 && (
        <SegmentedControl
          label="Cut on"
          size="sm"
          options={EVERY}
          value={every}
          onChange={setEvery}
        />
      )}
    </Tool>
  )
}

export function AiPanel() {
  const packs = usePacksData()
  const [pace, setPace] = useState<Pace>('tight')
  const landscape = useEditor((s) => (s.project ? landscapeClips(s.project, s.assets).length : 0))
  const language = useEditor((s) => s.project?.captions?.language ?? 'auto')
  const captionStyle = () => {
    const c = captionStyleFor(packs)
    return { style: c.style, language, ...(c.ref ? { styleRef: c.ref } : {}) }
  }
  return (
    <PanelBody>
      <div className="flex flex-col gap-3 rounded-2xl bg-gradient-to-br from-accent/20 to-violet/20 p-4">
        <div className="flex items-center gap-2">
          <Wand2 size={20} className="text-accent" />
          <span className="text-lg font-bold">Magic edit</span>
        </div>
        <p className="text-sm text-muted">
          Cuts silences and filler words, syncs to your music and adds captions — in one tap,
          undoable in one step.
        </p>
        <TaskCard id="magic">
          <Button
            variant="primary"
            block
            icon={<Sparkles size={18} />}
            onClick={() => startMagic(captionStyle())}
          >
            Magic edit
          </Button>
        </TaskCard>
      </div>

      <Section title="Clean up">
        <Tool
          id="silence"
          icon={<AudioWaveform size={20} />}
          title="Remove silences"
          description="Find the pauses and cut them — you'll see what it saves first"
          action={
            <Button
              block
              onClick={() =>
                startSilence({ minSilence: PACES.find((p) => p.value === pace)!.minSilence })
              }
            >
              Find silences
            </Button>
          }
        >
          <SegmentedControl
            label="Pace"
            size="sm"
            options={PACES}
            value={pace}
            onChange={setPace}
          />
        </Tool>
        <Tool
          id="fillers"
          icon={<Eraser size={20} />}
          title="Remove filler words"
          description="Cut the “um”s and “uh”s"
          action={
            <Button block onClick={() => startFillers(language)}>
              Find filler words
            </Button>
          }
        />
        <Tool
          id="captions"
          icon={<Captions size={20} />}
          title="Auto captions"
          description="Word-perfect captions in the trending style"
          action={
            <Button block onClick={() => startCaptions(captionStyle())}>
              Generate captions
            </Button>
          }
        />
      </Section>

      <Section title="Edit">
        <BeatSyncTool />
        <Tool
          id="scenes"
          icon={<ScissorsLineDashed size={20} />}
          title="Split at scene changes"
          description="Cut long takes into shots automatically"
          action={
            <Button block onClick={() => startScenes()}>
              Split scenes
            </Button>
          }
        />
        <Tool
          id="reframe"
          icon={<Crop size={20} />}
          title="Auto reframe"
          description={
            landscape
              ? `Follow the subject in ${landscape} landscape clip${landscape === 1 ? '' : 's'}`
              : 'Only needed for landscape (16:9) clips'
          }
          action={
            <Button block disabled={landscape === 0} onClick={() => startReframe()}>
              Reframe to 9:16
            </Button>
          }
        />
      </Section>

      <VoiceTools />
    </PanelBody>
  )
}
