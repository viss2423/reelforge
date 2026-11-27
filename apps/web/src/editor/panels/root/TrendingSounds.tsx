/**
 * "Trending sounds today": today's chart sounds from the trend engine with
 * - Add this sound when you post (copies its name for Instagram's sound picker),
 * - Find similar free track (one tap → the most similar royalty-free track as the music bed),
 * - Match cuts to this sound (its beat grid, else its chart BPM),
 * - Preview with my reel — only when the host enables it (TRENDS_SOUND_PREVIEW=1): Deezer's
 *   official 30 s preview plays in sync with the edit, looping on longer reels; streamed
 *   for playback only, never stored or exported. Otherwise "Listen on Deezer" opens the
 *   sound's page (provider terms do not cover syncing previews with video by default).
 * Used by the Audio panel and the Export dialog (compact: copy + find similar).
 */
import {
  Copy,
  ExternalLink,
  Music2,
  Pause,
  Play,
  Scissors,
  Sparkles,
  TrendingUp,
} from 'lucide-react'
import { useRef, useState } from 'react'
import { api } from '@/api/index.ts'
import { useTrends } from '@/api/queries.ts'
import { Button } from '@/components/Button.tsx'
import { Spinner } from '@/components/Spinner.tsx'
import { toast } from '@/components/Toast.tsx'
import { sourceLabel } from '@/lib/trends.ts'
import { editorStore } from '@/state/editorStore.ts'
import { useProject } from '@/state/selectors.ts'
import { PREVIEW_CLIP_US, soundPreviewStore, useSoundPreview } from '../../soundPreview.ts'
import { describeError } from '../model/commands.ts'
import { musicLength } from '../model/music.ts'
import {
  findSimilarFreeTrack,
  freshness,
  matchCutsToSound,
  postingName,
  soundRef,
  type TrendSound,
} from '../model/trendSounds.ts'
import { Hint, Section } from '../ui.tsx'

const MAX_SOUNDS = 6

const same = (a: { title: string; artist?: string | undefined } | undefined, b: TrendSound) =>
  !!a && a.title === b.title && (a.artist ?? '') === (b.artist ?? '')

export function TrendingSounds({ compact = false }: { compact?: boolean }) {
  const trends = useTrends()
  const sounds = (trends.data?.sounds ?? []).slice(0, MAX_SOUNDS)
  if (trends.isPending) return null
  return (
    <Section title="Trending sounds today">
      {sounds.length === 0 ? (
        <Hint>
          No chart sounds yet — the trend engine refreshes daily (Trending tab → pull to refresh).
        </Hint>
      ) : (
        <ul
          className="flex flex-col gap-2"
          aria-label="Trending sounds"
          data-testid="trending-sounds"
        >
          {sounds.map((s) => (
            <SoundRow
              key={`${s.title}|${s.artist ?? ''}`}
              sound={s}
              compact={compact}
              previewEnabled={trends.data?.soundPreview === true}
            />
          ))}
        </ul>
      )}
      <p className="text-xs text-muted">
        Chart songs are copyrighted: ReelForge never downloads or exports them. Add the sound in
        Instagram when you post, or use a similar free track.
      </p>
    </Section>
  )
}

function SoundRow({
  sound,
  compact,
  previewEnabled,
}: {
  sound: TrendSound
  compact: boolean
  previewEnabled: boolean
}) {
  const project = useProject()
  const previewing = useSoundPreview((s) => same(s.sound, sound))
  const [busy, setBusy] = useState<'similar' | 'preview' | 'cuts' | undefined>()
  const [noPreview, setNoPreview] = useState(false)
  const abort = useRef<AbortController | undefined>(undefined)

  const copy = async () => {
    const name = postingName(sound)
    soundPreviewStore.getState().pick()
    try {
      await navigator.clipboard.writeText(name)
      toast.success('Copied', 'Search for it in the sound picker when you post')
    } catch {
      toast.error("Couldn't copy", name)
    }
  }

  const similar = async () => {
    setBusy('similar')
    try {
      const { pick } = await findSimilarFreeTrack(api, sound)
      toast.success(`Added “${pick.title}”`, `Free track similar to ${sound.title}`)
    } catch (err) {
      toast.error("Couldn't find a similar track", describeError(err))
    } finally {
      setBusy(undefined)
    }
  }

  const preview = async () => {
    if (previewing) {
      soundPreviewStore.getState().stop()
      return
    }
    abort.current?.abort()
    const ac = new AbortController()
    abort.current = ac
    setBusy('preview')
    try {
      const info = await api.soundPreviewInfo(soundRef(sound), ac.signal)
      if (!info.available) {
        setNoPreview(true)
        return
      }
      const audio = await api.soundPreviewAudio(soundRef(sound), ac.signal)
      soundPreviewStore.getState().start(
        {
          title: sound.title,
          ...(sound.artist ? { artist: sound.artist } : {}),
          ...(sound.bpm ? { bpm: sound.bpm } : {}),
          source: info.source ?? 'deezer',
        },
        audio,
      )
      editorStore.getState().setPlayhead(0)
      editorStore.getState().setPlaying(true)
    } catch (err) {
      if (!ac.signal.aborted) toast.error("Couldn't play the preview", describeError(err))
    } finally {
      setBusy(undefined)
    }
  }

  const cuts = async () => {
    setBusy('cuts')
    try {
      const grid = await api.soundBeats({
        ...soundRef(sound),
        ...(sound.bpm ? { bpm: sound.bpm } : {}),
      })
      if (matchCutsToSound(grid))
        toast.success(
          'Cuts on the beat',
          grid.engine === 'grid' ? `${grid.bpm} BPM grid` : `${Math.round(grid.bpm)} BPM`,
        )
    } catch (err) {
      toast.error("Couldn't match the cuts", describeError(err))
    } finally {
      setBusy(undefined)
    }
  }

  const sources = sound.sources.map(sourceLabel).join(', ')
  const longReel = musicLength(project) > PREVIEW_CLIP_US
  return (
    <li
      className="flex flex-col gap-2 rounded-xl border border-line p-3"
      data-testid="trending-sound"
    >
      <div className="flex items-start gap-3">
        <TrendingUp size={18} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{sound.title}</p>
          <p className="truncate text-xs text-muted">
            {[
              sound.artist,
              `${Math.round(sound.bpm)} BPM${sound.measured ? '' : ' (est.)'}`,
              sources,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <span
          className={
            sound.fresh
              ? 'shrink-0 rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold text-accent-fg'
              : 'shrink-0 text-[11px] text-muted'
          }
        >
          {freshness(sound)}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" icon={<Copy size={14} />} onClick={() => void copy()}>
          Add this sound when you post
        </Button>
        <Button
          size="sm"
          variant="secondary"
          icon={<Sparkles size={14} />}
          loading={busy === 'similar'}
          disabled={busy !== undefined}
          onClick={() => void similar()}
          data-testid="find-similar"
        >
          Find similar free track
        </Button>
        {!compact && !previewEnabled && (
          <>
            <a
              href={sound.link}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold hover:bg-surface-2"
              data-testid="listen-sound"
            >
              <ExternalLink size={14} /> Listen on Deezer
            </a>
            <Button
              size="sm"
              variant="ghost"
              icon={<Scissors size={14} />}
              loading={busy === 'cuts'}
              disabled={busy !== undefined}
              onClick={() => void cuts()}
              data-testid="match-cuts"
            >
              Match cuts to this sound
            </Button>
          </>
        )}
        {!compact && previewEnabled && (
          <Button
            size="sm"
            variant={previewing ? 'primary' : 'ghost'}
            icon={previewing ? <Pause size={14} /> : <Play size={14} />}
            loading={busy === 'preview'}
            disabled={busy !== undefined && busy !== 'preview'}
            onClick={() => void preview()}
            data-testid="preview-sound"
          >
            {previewing ? 'Stop preview' : 'Preview with my reel'}
          </Button>
        )}
      </div>
      {noPreview && (
        <p className="flex items-center gap-2 text-xs text-muted" data-testid="no-preview">
          <Music2 size={14} className="shrink-0" />
          No official preview for this sound.
          <button
            type="button"
            className="font-semibold text-accent underline"
            onClick={() => void similar()}
          >
            Use the closest free match
          </button>
        </p>
      )}
      {previewing && (
        <div
          className="flex flex-wrap items-center gap-2 text-xs text-muted"
          data-testid="sound-previewing"
        >
          {busy === 'cuts' ? <Spinner /> : null}
          <span className="flex-1">
            Playing the official 30 s preview with your reel
            {longReel ? ' (loops every 30 s)' : ''} — not saved or exported.
          </span>
          <Button
            size="sm"
            variant="ghost"
            icon={<Scissors size={14} />}
            disabled={busy !== undefined}
            onClick={() => void cuts()}
            data-testid="match-cuts"
          >
            Match cuts to this sound
          </Button>
        </div>
      )}
    </li>
  )
}
