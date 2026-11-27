/**
 * Audio panel music tools: one-tap "Auto music", the royalty-free library browser (mood /
 * genre / BPM search, 10 s chorus previews streamed from the host, licence + credit shown)
 * and the template's "trending sound to add when posting" hint.
 */
import type { LibraryTrack, MusicMood, RankedTrack } from '@reelforge/core'
import { useQuery } from '@tanstack/react-query'
import {
  Copy,
  Music,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  TrendingUp,
} from 'lucide-react'
import { useDeferredValue, useEffect, useRef, useState } from 'react'
import { api } from '@/api/index.ts'
import { Button } from '@/components/Button.tsx'
import { IconButton } from '@/components/IconButton.tsx'
import { Spinner } from '@/components/Spinner.tsx'
import { toast } from '@/components/Toast.tsx'
import { formatDuration } from '@/lib/format.ts'
import { useAssetsMap, useProject } from '@/state/selectors.ts'
import { usePacksData } from '../hooks.ts'
import { describeError } from '../model/commands.ts'
import { MOOD_OPTIONS, autoMusic, detectSpeech, placeTrack, trendingHint } from '../model/music.ts'
import { Advanced, Chips, Hint, Section, Toggle } from '../ui.tsx'

/* ------------------------------------------------------------------ preview player */

/** One shared <audio> so starting a preview stops the previous one. */
let player: HTMLAudioElement | undefined
const listeners = new Set<(id: string | undefined) => void>()
let playingId: string | undefined
const setPlaying = (id: string | undefined) => {
  playingId = id
  for (const l of listeners) l(id)
}

const togglePreview = (trackId: string) => {
  if (!player) {
    player = new Audio()
    player.addEventListener('ended', () => setPlaying(undefined))
    player.addEventListener('error', () => {
      if (!playingId) return
      setPlaying(undefined)
      toast.error("Couldn't play the preview", 'The host could not fetch this track')
    })
  }
  if (playingId === trackId) {
    player.pause()
    setPlaying(undefined)
    return
  }
  player.preload = 'auto'
  player.src = api.musicPreviewUrl(trackId)
  player.load()
  setPlaying(trackId)
  void player.play().catch(() => setPlaying(undefined))
}

const usePreviewing = (): string | undefined => {
  const [id, setId] = useState(playingId)
  useEffect(() => {
    listeners.add(setId)
    return () => {
      listeners.delete(setId)
      // Leaving the panel stops the preview.
      if (listeners.size === 0) {
        player?.pause()
        playingId = undefined
      }
    }
  }, [])
  return id
}

/* ------------------------------------------------------------------ track row */

function LicenceBadge({ track }: { track: Pick<LibraryTrack, 'licence'> }) {
  return (
    <span
      className={
        track.licence.attributionRequired
          ? 'rounded-md bg-surface-3 px-1.5 py-0.5 text-[11px] font-semibold text-muted'
          : 'rounded-md bg-success/15 px-1.5 py-0.5 text-[11px] font-semibold text-success'
      }
      title={
        track.licence.attributionRequired ? 'Credit the artist in your caption' : 'No credit needed'
      }
    >
      {track.licence.name}
    </span>
  )
}

function TrackRow({
  track,
  onAdd,
  busy,
}: {
  track: LibraryTrack
  onAdd: () => void
  busy: boolean
}) {
  const previewing = usePreviewing() === track.id
  return (
    <li
      className="flex min-h-14 items-center gap-2"
      data-testid="music-track"
      data-track-id={track.id}
    >
      <button
        type="button"
        aria-label={previewing ? `Stop preview of ${track.title}` : `Preview ${track.title}`}
        onClick={() => togglePreview(track.id)}
        className="grid size-10 shrink-0 place-items-center rounded-full bg-violet/20 text-violet"
      >
        {previewing ? <Pause size={18} /> : <Play size={18} />}
      </button>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-semibold">{track.title}</span>
        <span className="flex items-center gap-1.5 truncate text-xs text-muted">
          <span className="truncate">{track.artist || track.source}</span>
          {track.bpm !== undefined && (
            <span className="tabular-nums">· {Math.round(track.bpm)} BPM</span>
          )}
          <span className="tabular-nums">· {formatDuration(track.duration)}</span>
        </span>
      </span>
      <LicenceBadge track={track} />
      <Button
        size="sm"
        variant="secondary"
        icon={<Plus size={14} />}
        loading={busy}
        onClick={onAdd}
        aria-label={`Add ${track.title}`}
      >
        Add
      </Button>
    </li>
  )
}

/* ------------------------------------------------------------------ auto music */

export function AutoMusicSection() {
  const project = useProject()
  const assets = useAssetsMap()
  const packs = usePacksData()
  const [mood, setMood] = useState<MusicMood>('upbeat')
  const [vibe, setVibe] = useState('')
  const detected = detectSpeech(project, assets)
  const [duck, setDuck] = useState<boolean | undefined>(undefined)
  const [status, setStatus] = useState<string | undefined>(undefined)
  const [result, setResult] = useState<
    { pick: RankedTrack; suggestions: RankedTrack[] } | undefined
  >()
  const abort = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => abort.current?.abort(), [])
  const ducking = duck ?? detected
  const hint = trendingHint(project, packs?.manifests)

  const run = async (next?: RankedTrack) => {
    abort.current?.abort()
    const ac = new AbortController()
    abort.current = ac
    try {
      if (next && result) {
        setStatus(`Adding “${next.title}”…`)
        await placeTrack(api, next, { duck: ducking, signal: ac.signal })
        setResult({ ...result, pick: next })
      } else {
        const r = await autoMusic(api, {
          mood,
          vibe,
          duck: ducking,
          signal: ac.signal,
          onStatus: setStatus,
        })
        setResult({ pick: r.pick, suggestions: r.suggestions })
        if (r.warnings.length)
          toast('Some music sources were skipped', { description: r.warnings[0]! })
      }
      toast.success('Music added', 'Starts at the chorus, trimmed to your reel')
    } catch (err) {
      if (!ac.signal.aborted) toast.error("Couldn't add music", describeError(err))
    } finally {
      if (abort.current === ac) setStatus(undefined)
    }
  }

  const nextPick = result
    ? result.suggestions[
        (result.suggestions.findIndex((t) => t.id === result.pick.id) + 1) %
          result.suggestions.length
      ]
    : undefined

  return (
    <section
      aria-label="Auto music"
      className="flex flex-col gap-3 rounded-3xl bg-surface-2 p-4"
      data-testid="auto-music-card"
    >
      <div className="flex items-center gap-2.5">
        <span className="grid size-9 place-items-center rounded-xl bg-accent/15 text-accent">
          <Music size={18} />
        </span>
        <div className="flex min-w-0 flex-col">
          <h3 className="text-[17px] leading-tight font-bold">Auto music</h3>
          <p className="truncate text-sm text-muted">A free track, cut to your reel.</p>
        </div>
      </div>
      <Chips label="Vibe" options={MOOD_OPTIONS} value={mood} onChange={setMood} />
      <Button
        variant="primary"
        size="lg"
        block
        className="panels-cta"
        icon={<Sparkles size={18} />}
        loading={status !== undefined}
        onClick={() => void run()}
        data-testid="auto-music"
      >
        Add music
      </Button>
      {status && (
        <p
          className="truncate text-xs text-muted"
          aria-live="polite"
          data-testid="auto-music-status"
        >
          {status}
        </p>
      )}
      {result && (
        <div className="panels-enter flex flex-col gap-1" data-testid="auto-music-pick">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">{result.pick.title}</span>
              <span className="block truncate text-xs text-muted">
                {[
                  result.pick.artist,
                  result.pick.bpm && `${Math.round(result.pick.bpm)} BPM`,
                  ...result.pick.reasons.filter((r) => !r.includes('BPM')).slice(0, 1),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </span>
            <LicenceBadge track={result.pick} />
            {nextPick && nextPick.id !== result.pick.id && (
              <IconButton
                size="sm"
                label={`Try another: ${nextPick.title}`}
                icon={<RefreshCw size={16} />}
                disabled={status !== undefined}
                onClick={() => void run(nextPick)}
              />
            )}
          </div>
          {result.pick.attribution && (
            <p
              className="truncate text-xs text-muted"
              title={result.pick.attribution}
              data-testid="auto-music-credit"
            >
              Credit: {result.pick.attribution}
            </p>
          )}
        </div>
      )}
      <Advanced label="More options" id="auto-music">
        <input
          type="text"
          value={vibe}
          onChange={(e) => setVibe(e.target.value)}
          maxLength={200}
          placeholder="Describe it: summer road trip, gym…"
          aria-label="Describe the vibe"
          className="h-11 rounded-xl bg-surface px-3 text-sm ring-1 ring-line outline-none focus:ring-accent"
        />
        <Toggle
          label="Duck under speech"
          description={detected ? 'Speech found: instrumentals first' : 'Quieter while people talk'}
          checked={ducking}
          onChange={setDuck}
        />
      </Advanced>
      {hint && <TrendingHint hint={hint} />}
    </section>
  )
}

function TrendingHint({ hint }: { hint: { title: string; bpm?: number; url?: string } }) {
  const text = hint.bpm ? `${hint.title} · ${hint.bpm} BPM` : hint.title
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(hint.title)
      toast.success('Copied', 'Search for it in the sound picker when you post')
    } catch {
      toast.error("Couldn't copy", hint.title)
    }
  }
  return (
    <div
      className="flex items-center gap-2 rounded-2xl bg-surface py-1.5 pr-1.5 pl-3"
      data-testid="trending-hint"
    >
      <TrendingUp size={16} className="shrink-0 text-accent" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[11px] text-muted">Template sound · add when posting</span>
        <span className="truncate text-sm font-semibold">{text}</span>
      </span>
      <Button size="sm" variant="ghost" icon={<Copy size={14} />} onClick={() => void copy()}>
        Copy
      </Button>
    </div>
  )
}

/* ------------------------------------------------------------------ library browser */

const BPM_OPTIONS = [
  { value: 'any', label: 'Any tempo' },
  { value: 'slow', label: '< 95 BPM' },
  { value: 'mid', label: '95–125' },
  { value: 'fast', label: '125+' },
] as const
type BpmFilter = (typeof BPM_OPTIONS)[number]['value']
const BPM_RANGE: Record<BpmFilter, { bpmMin?: number; bpmMax?: number }> = {
  any: {},
  slow: { bpmMax: 95 },
  mid: { bpmMin: 95, bpmMax: 125 },
  fast: { bpmMin: 125 },
}

export function MusicLibrarySection() {
  const project = useProject()
  const assets = useAssetsMap()
  const [q, setQ] = useState('')
  const [mood, setMood] = useState<MusicMood | undefined>(undefined)
  const [bpm, setBpm] = useState<BpmFilter>('any')
  const [adding, setAdding] = useState<string | undefined>(undefined)
  const query = useDeferredValue(q.trim())
  const enabled = query.length >= 2 || mood !== undefined
  const search = useQuery({
    queryKey: ['music', 'search', query, mood, bpm],
    queryFn: ({ signal }) =>
      api.musicSearch(
        { ...(query ? { q: query } : {}), ...(mood ? { mood } : {}), ...BPM_RANGE[bpm], limit: 20 },
        signal,
      ),
    enabled,
    staleTime: 10 * 60_000,
  })

  const add = async (track: LibraryTrack) => {
    setAdding(track.id)
    try {
      await placeTrack(api, track, { duck: detectSpeech(project, assets) })
      toast.success('Music added', track.title)
    } catch (err) {
      toast.error("Couldn't add music", describeError(err))
    } finally {
      setAdding(undefined)
    }
  }

  return (
    <Section title="Royalty-free library">
      <div className="flex h-11 items-center gap-2 rounded-xl bg-surface-2 pr-1 pl-3 ring-1 ring-transparent focus-within:ring-accent">
        <Search size={16} className="shrink-0 text-muted" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search title, genre…"
          aria-label="Search music"
          className="h-full min-w-0 flex-1 bg-transparent text-[15px] outline-none"
        />
        <select
          aria-label="Tempo"
          value={bpm}
          onChange={(e) =>
            setBpm(BPM_OPTIONS.find((o) => o.value === e.target.value)?.value ?? 'any')
          }
          className="h-9 shrink-0 rounded-lg bg-surface-3 px-2 text-xs font-semibold"
        >
          {BPM_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <Chips
        label="Mood"
        options={MOOD_OPTIONS}
        value={mood}
        onChange={(m) => setMood(m === mood ? undefined : m)}
      />
      {!enabled ? (
        <p className="py-6 text-center text-sm text-muted">Pick a mood or search.</p>
      ) : search.isPending ? (
        <div className="flex justify-center py-4">
          <Spinner />
        </div>
      ) : search.isError ? (
        <Hint>The music library is unreachable: {describeError(search.error)}</Hint>
      ) : search.data.tracks.length === 0 ? (
        <Hint>
          No tracks found.
          {search.data.warnings[0] ? ` ${search.data.warnings[0]}` : ' Try another search.'}
        </Hint>
      ) : (
        <ul className="flex flex-col gap-1" aria-label="Music library results">
          {search.data.tracks.map((t) => (
            <TrackRow key={t.id} track={t} busy={adding === t.id} onAdd={() => void add(t)} />
          ))}
        </ul>
      )}
      <p className="text-xs text-muted">Free to use: CC0 and CC BY. Credits go in your caption.</p>
    </Section>
  )
}

/** Exposed for tests: stop any preview. */
export const stopMusicPreview = () => {
  player?.pause()
  setPlaying(undefined)
}
