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
  MoreHorizontal,
  Music2,
  Pause,
  Play,
  Plus,
  Scissors,
  TrendingUp,
} from 'lucide-react'
import { useRef, useState } from 'react'
import { api } from '@/api/index.ts'
import { useTrends } from '@/api/queries.ts'
import { Button } from '@/components/Button.tsx'
import { IconButton } from '@/components/IconButton.tsx'
import { Spinner } from '@/components/Spinner.tsx'
import { toast } from '@/components/Toast.tsx'
import { cn } from '@/lib/cn.ts'
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
import { Section } from '../ui.tsx'

const MAX_SOUNDS = 6

const same = (a: { title: string; artist?: string | undefined } | undefined, b: TrendSound) =>
  !!a && a.title === b.title && (a.artist ?? '') === (b.artist ?? '')

export function TrendingSounds({ compact = false }: { compact?: boolean }) {
  const trends = useTrends()
  const sounds = (trends.data?.sounds ?? []).slice(0, compact ? 3 : MAX_SOUNDS)
  if (trends.isPending) return null
  return (
    <Section title="Trending today">
      {sounds.length === 0 ? (
        <p className="text-sm text-muted">No chart sounds yet. They refresh daily.</p>
      ) : (
        <ul className="flex flex-col" aria-label="Trending sounds" data-testid="trending-sounds">
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
        Chart songs stay in Instagram: add them when you post, or use a similar free track.
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
  const [open, setOpen] = useState(false)
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
  const matchCuts = (
    <Button
      size="sm"
      variant="ghost"
      icon={<Scissors size={14} />}
      loading={busy === 'cuts'}
      disabled={busy !== undefined}
      onClick={() => void cuts()}
      data-testid="match-cuts"
    >
      Match cuts
    </Button>
  )
  const lead = 'grid size-11 shrink-0 place-items-center rounded-full transition-colors'
  return (
    <li
      className="flex flex-col border-b border-line/60 py-1.5 last:border-b-0"
      data-testid="trending-sound"
    >
      <div className="flex items-center gap-2.5">
        {compact ? (
          <span className={cn(lead, 'bg-accent/10 text-accent')} aria-hidden>
            <TrendingUp size={18} />
          </span>
        ) : previewEnabled ? (
          <button
            type="button"
            aria-label={
              previewing ? `Stop preview of ${sound.title}` : `Preview ${sound.title} with my reel`
            }
            aria-pressed={previewing}
            disabled={busy !== undefined && busy !== 'preview'}
            onClick={() => void preview()}
            data-testid="preview-sound"
            className={cn(
              lead,
              previewing
                ? 'panels-cta bg-accent text-accent-fg'
                : 'bg-surface-2 text-fg hover:bg-surface-3',
            )}
          >
            {busy === 'preview' ? (
              <Spinner />
            ) : previewing ? (
              <Pause size={18} />
            ) : (
              <Play size={18} />
            )}
          </button>
        ) : (
          <a
            href={sound.link}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={`Listen to ${sound.title} on Deezer`}
            className={cn(lead, 'bg-surface-2 text-fg hover:bg-surface-3')}
            data-testid="listen-sound"
          >
            <ExternalLink size={16} />
          </a>
        )}
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-sm font-semibold">
            <span className="truncate">{sound.title}</span>
            {sound.fresh && (
              <span className="shrink-0 rounded-full bg-accent/15 px-1.5 text-[11px] font-semibold text-accent">
                {freshness(sound)}
              </span>
            )}
          </p>
          <p className="truncate text-xs text-muted" title={sources}>
            {[
              sound.artist,
              `${Math.round(sound.bpm)} BPM${sound.measured ? '' : ' (est.)'}`,
              !sound.fresh && freshness(sound),
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          icon={<Plus size={14} />}
          loading={busy === 'similar'}
          disabled={busy !== undefined}
          onClick={() => void similar()}
          data-testid="find-similar"
          aria-label={`Add a free track similar to ${sound.title}`}
          className="rounded-full"
        >
          Similar
        </Button>
        <IconButton
          size="sm"
          label={`More for ${sound.title}`}
          icon={<MoreHorizontal size={18} />}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        />
      </div>
      {open && (
        <div className="panels-enter flex flex-wrap gap-1 pt-1 pl-[3.375rem]">
          <Button size="sm" variant="ghost" icon={<Copy size={14} />} onClick={() => void copy()}>
            Add this sound when you post
          </Button>
          {!compact && !previewEnabled && matchCuts}
        </div>
      )}
      {noPreview && (
        <p
          className="flex items-center gap-2 pl-[3.375rem] text-xs text-muted"
          data-testid="no-preview"
        >
          <Music2 size={14} className="shrink-0" />
          No official preview.
          <button
            type="button"
            className="min-h-8 font-semibold text-accent underline"
            onClick={() => void similar()}
          >
            Use the closest free match
          </button>
        </p>
      )}
      {previewing && (
        <div
          className="flex items-center gap-2 pl-[3.375rem] text-xs text-muted"
          data-testid="sound-previewing"
        >
          <span className="min-w-0 flex-1">
            Playing with your reel{longReel ? ' (loops every 30 s)' : ''}. Not saved or exported.
          </span>
          {matchCuts}
        </div>
      )}
    </li>
  )
}
