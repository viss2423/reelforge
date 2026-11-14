/** Clip audio: volume, mute, fades, voice clean-up, ducking and role. */
import type { AudioClip, MediaClip } from '@reelforge/core'
import { SegmentedControl } from '@/components/SegmentedControl.tsx'
import { Slider } from '@/components/Slider.tsx'
import { edit, gesture } from '../model/commands.ts'
import { isAudioClip } from '../model/draft.ts'
import { setAudio, setAudioClipProps } from '../model/edits.ts'
import { SecondsSlider, Section, Toggle } from '../ui.tsx'

/** Longest fade offered: half the clip, at most 10 s. */
export const maxFade = (duration: number): number => Math.min(10_000_000, Math.floor(duration / 2))

const ROLES = [
  { value: 'music', label: 'Music' },
  { value: 'voiceover', label: 'Voice' },
  { value: 'sfx', label: 'SFX' },
] as const

export function VolumeControls({ clip }: { clip: MediaClip | AudioClip }) {
  const a = clip.audio
  return (
    <Section title="Volume">
      <Slider
        label="Volume"
        value={a.volume * 100}
        min={0}
        max={400}
        step={1}
        defaultValue={100}
        unit="%"
        disabled={a.muted}
        {...gesture<number>('Volume', (d, v) => setAudio(d, [clip.id], { volume: v / 100 }))}
      />
      <Toggle
        label="Mute"
        checked={a.muted}
        onChange={(on) =>
          edit(on ? 'Mute' : 'Unmute', (d) => setAudio(d, [clip.id], { muted: on }))
        }
      />
    </Section>
  )
}

export function FadeControls({ clip }: { clip: MediaClip | AudioClip }) {
  const max = maxFade(clip.duration)
  return (
    <Section title="Fade">
      <SecondsSlider
        label="Fade in"
        value={Math.min(clip.audio.fadeIn, max)}
        max={max}
        defaultValue={0}
        handlers={gesture<number>('Fade in', (d, v) => setAudio(d, [clip.id], { fadeIn: v }))}
      />
      <SecondsSlider
        label="Fade out"
        value={Math.min(clip.audio.fadeOut, max)}
        max={max}
        defaultValue={0}
        handlers={gesture<number>('Fade out', (d, v) => setAudio(d, [clip.id], { fadeOut: v }))}
      />
    </Section>
  )
}

export function VoiceControls({ clip }: { clip: MediaClip | AudioClip }) {
  const audio = isAudioClip(clip) ? clip : undefined
  return (
    <Section title="Voice & mix">
      <Toggle
        label="Enhance voice"
        description="Studio EQ and compression"
        checked={clip.audio.enhanceVoice}
        onChange={(on) =>
          edit('Enhance voice', (d) => setAudio(d, [clip.id], { enhanceVoice: on }))
        }
      />
      <Toggle
        label="Reduce noise"
        description="Removes hum, wind and background noise"
        checked={clip.audio.denoise}
        onChange={(on) => edit('Reduce noise', (d) => setAudio(d, [clip.id], { denoise: on }))}
      />
      {audio && (
        <>
          <Toggle
            label="Duck under voice"
            description="Lower this clip automatically while someone speaks"
            checked={audio.duckUnderVoice}
            onChange={(on) =>
              edit('Auto ducking', (d) => setAudioClipProps(d, audio.id, { duckUnderVoice: on }))
            }
          />
          <SegmentedControl
            label="Role"
            options={ROLES}
            value={audio.role}
            onChange={(role) => edit('Audio role', (d) => setAudioClipProps(d, audio.id, { role }))}
          />
        </>
      )}
    </Section>
  )
}

/** Everything audio for one clip (inspector, and the Volume sheet on phones). */
export function AudioSection({
  clip,
  parts = 'all',
}: {
  clip: MediaClip | AudioClip
  parts?: 'all' | 'volume' | 'fade'
}) {
  return (
    <>
      {parts !== 'fade' && <VolumeControls clip={clip} />}
      {parts !== 'volume' && <FadeControls clip={clip} />}
      {parts !== 'fade' && <VoiceControls clip={clip} />}
    </>
  )
}
