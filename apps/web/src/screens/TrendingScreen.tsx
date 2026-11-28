/**
 * Trending: a "Today" feed of what the host's trend engine found — the top five topics as
 * a ranked list (tap for a reel idea, or the arrow to make the reel straight away), more
 * topics as chips, trending sounds as a rail, copyable hashtags and the templates
 * generated today. Pull down (or tap refresh) to ask the host for a fresh run.
 */
import {
  ArrowUpRight,
  Copy,
  ExternalLink,
  Hash,
  Lightbulb,
  Music2,
  Pause,
  Play,
  RefreshCw,
  Sparkles,
  TrendingUp,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode, type TouchEvent } from 'react'
import { useNavigate } from 'react-router'
import { displayTitle } from '@reelforge/core'
import { api } from '@/api/index.ts'
import { usePacks, useRefreshTrends, useTrendIdea, useTrends } from '@/api/queries.ts'
import type { ReelIdea, Trends } from '@/api/schemas.ts'
import { Button } from '@/components/Button.tsx'
import { AdaptiveModal } from '@/components/Dialog.tsx'
import { EmptyState } from '@/components/EmptyState.tsx'
import { IconButton } from '@/components/IconButton.tsx'
import { Skeleton } from '@/components/Skeleton.tsx'
import { Spinner } from '@/components/Spinner.tsx'
import { toast } from '@/components/Toast.tsx'
import { cn } from '@/lib/cn.ts'
import { latestMatchingTemplate, listTemplates, type TemplateEntry } from '@/lib/packs.ts'
import { autoEditUrl, postText, sourceLabel } from '@/lib/trends.ts'
import { AppFrame, SectionTitle } from './AppFrame.tsx'
import { TemplateRail, TemplateSheet } from './home/Templates.tsx'

const PULL_THRESHOLD = 70
const TOP = 5
const CHIPS_COLLAPSED = 8
const TAGS_COLLAPSED = 10

/** One colour per trend source, shown as a tiny dot instead of repeating its name. */
const SOURCE_COLOR: Record<string, string> = {
  'google-trends': '#4c8bf5',
  wikipedia: '#b8b8c6',
  'apple-music': '#fa2d55',
  deezer: '#a238ff',
  youtube: '#ff3b30',
  reddit: '#ff6a1a',
  calendar: '#f5b014',
}
const sourceColor = (id: string): string => SOURCE_COLOR[id] ?? '#8b8b9a'

/** "10h ago"-style age for the freshness chip. */
export const shortAgo = (iso: string, now = Date.now()): string => {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000)
  if (Number.isNaN(s)) return ''
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86_400)}d ago`
}

/** Pull-to-refresh on the screen's scroll container (touch only; desktop uses the button). */
function usePullToRefresh(onRefresh: () => void) {
  const start = useRef<number | null>(null)
  const [pull, setPull] = useState(0)
  const scroller = (el: EventTarget) => (el as HTMLElement).closest('main')
  return {
    pull,
    handlers: {
      onTouchStart: (e: TouchEvent) => {
        start.current =
          (scroller(e.target)?.scrollTop ?? 0) <= 0 ? (e.touches[0]?.clientY ?? null) : null
      },
      onTouchMove: (e: TouchEvent) => {
        if (start.current === null) return
        setPull(Math.max(0, Math.min(120, (e.touches[0]?.clientY ?? 0) - start.current)))
      },
      onTouchEnd: () => {
        if (pull >= PULL_THRESHOLD) onRefresh()
        start.current = null
        setPull(0)
      },
    },
  }
}

const copy = async (text: string, what: string) => {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`${what} copied`)
  } catch {
    toast.error('Copy is not available here')
  }
}

/** Auto Edit link for a topic: its cached idea when there is one, else topic + vibe. */
const makeUrlFor = (text: string, trends: Trends): string | undefined => {
  const idea = trends.ideas.find((i) => i.topic.toLowerCase() === text.toLowerCase())
  if (idea) return autoEditUrl(idea, idea.template || undefined)
  return autoEditUrl(
    { topic: text, title: text, hooks: [], shots: [], caption: '', hashtags: [], template: '' },
    undefined,
  )
}

type Sound = Trends['sounds'][number]

/** Auto Edit vibe that fits a chart sound (its mood words, else its energy and tempo). */
export const vibeForSound = (s: Pick<Sound, 'mood' | 'genre' | 'energy' | 'bpm'>): string => {
  const words = `${s.mood ?? ''} ${s.genre ?? ''}`.toLowerCase()
  if (/chill|calm|soft|sad|acoustic|lofi|lo-fi|indie|folk|r&b|soul/.test(words)) return 'aesthetic'
  if (/dark|epic|cinematic|ambient|score|classical|orchestral/.test(words)) return 'cinematic'
  if (/happy|fun|party|dance|disco|pop/.test(words)) return 'fun'
  if ((s.energy ?? 0) >= 0.7 || s.bpm >= 120) return 'energetic'
  return 'energetic'
}

export function TrendingScreen() {
  const trends = useTrends()
  const refresh = useRefreshTrends()
  const [topic, setTopic] = useState<string | null>(null)
  const [legend, setLegend] = useState(false)

  const doRefresh = () =>
    refresh.mutate(undefined, {
      onSuccess: () => toast.success('Refreshing trends…'),
      onError: (e) => toast.error('Could not refresh trends', e.message),
    })
  const { pull, handlers } = usePullToRefresh(doRefresh)
  const t = trends.data
  const busy = refresh.isPending || t?.running === true

  return (
    <AppFrame
      title="Trending"
      actions={
        <>
          {t?.generatedAt && (
            <button
              type="button"
              data-testid="trends-updated"
              aria-expanded={legend}
              aria-controls="trend-sources-legend"
              onClick={() => setLegend((v) => !v)}
              className="flex h-8 items-center gap-1.5 rounded-full bg-surface-2 px-3 text-xs font-medium text-muted tabular-nums hover:text-fg"
            >
              <span
                aria-hidden
                className={cn(
                  'size-1.5 rounded-full',
                  busy ? 'animate-pulse bg-accent' : t.stale ? 'bg-warning' : 'bg-success',
                )}
              />
              {busy ? (
                'Refreshing…'
              ) : (
                <>
                  <span className="sr-only sm:not-sr-only">Updated </span>
                  {shortAgo(t.generatedAt)}
                </>
              )}
              {t.stale && !busy ? <span className="sr-only"> (out of date)</span> : null}
            </button>
          )}
          <IconButton
            label="Refresh trends"
            onClick={doRefresh}
            disabled={busy}
            icon={busy ? <Spinner size={18} /> : <RefreshCw size={19} />}
          />
        </>
      }
    >
      <div {...handlers} data-testid="trending">
        <div
          aria-hidden
          className="flex items-end justify-center overflow-hidden text-xs text-muted transition-[height]"
          style={{ height: pull }}
        >
          {pull >= PULL_THRESHOLD ? 'Release to refresh' : pull > 0 ? 'Pull to refresh' : ''}
        </div>
        {trends.isPending ? (
          <div className="mt-4 flex flex-col gap-3">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-16 w-full rounded-2xl" />
            ))}
          </div>
        ) : trends.isError ? (
          <EmptyState
            title="Couldn't load trends"
            description={trends.error.message}
            action={<Button onClick={() => void trends.refetch()}>Retry</Button>}
          />
        ) : !t?.generatedAt ? (
          <EmptyState
            icon={<TrendingUp size={28} />}
            title={busy ? 'Finding today’s trends…' : 'No trends yet'}
            description={t?.lastError ? `Last try failed: ${t.lastError}` : 'Checked once a day.'}
            action={
              <Button variant="primary" className="bg-magic" loading={busy} onClick={doRefresh}>
                Check now
              </Button>
            }
          />
        ) : (
          <>
            {legend && <SourcesLegend trends={t} />}
            <TrendingContent trends={t} onTopic={setTopic} />
          </>
        )}
      </div>
      {topic && <IdeaSheet topic={topic} trends={t} onClose={() => setTopic(null)} />}
    </AppFrame>
  )
}

/** Which colour is which source (opened from the "Updated" chip). */
function SourcesLegend({ trends }: { trends: Trends }) {
  return (
    <ul
      id="trend-sources-legend"
      data-testid="trend-sources-legend"
      aria-label="Sources"
      className="animate-rf-rise mt-2 flex flex-wrap gap-x-4 gap-y-2 rounded-2xl bg-surface px-4 py-3 text-xs text-muted"
    >
      {trends.sources
        .filter((s) => s.state === 'ok')
        .map((s) => (
          <li key={s.id} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2 rounded-full"
              style={{ backgroundColor: sourceColor(s.id) }}
            />
            <span className="text-fg">{sourceLabel(s.id)}</span>
            <span className="tabular-nums">{s.items}</span>
          </li>
        ))}
    </ul>
  )
}

/** Tiny coloured dots for a topic's sources (names stay in the accessible text). */
function SourceDots({ ids }: { ids: readonly string[] }) {
  return (
    <span className="relative inline-flex shrink-0 items-center gap-1">
      {ids.map((id) => (
        <span
          key={id}
          title={sourceLabel(id)}
          aria-hidden
          className="size-1.5 rounded-full"
          style={{ backgroundColor: sourceColor(id) }}
        />
      ))}
      <span className="sr-only">{ids.map(sourceLabel).join(', ')}</span>
    </span>
  )
}

function TrendingContent({
  trends,
  onTopic,
}: {
  trends: Trends
  onTopic: (topic: string) => void
}) {
  const packs = usePacks()
  const navigate = useNavigate()
  const [chosen, setChosen] = useState<TemplateEntry | null>(null)
  const [allChips, setAllChips] = useState(false)
  const [allTags, setAllTags] = useState(false)
  const generated = useMemo(
    () => listTemplates(packs.data, trends).filter((e) => e.packId === 'trending-live'),
    [packs.data, trends],
  )
  const top = trends.topics.slice(0, TOP)
  const chips = [
    ...trends.topics.slice(TOP).map((s) => ({ ...s, format: false })),
    ...trends.formats.map((s) => ({ ...s, format: true })),
  ]
  const shownChips = allChips ? chips : chips.slice(0, CHIPS_COLLAPSED)

  const make = (text: string) => {
    const url = makeUrlFor(text, trends)
    if (url) void navigate(url)
    else onTopic(text)
  }

  // Phones read top to bottom; wide screens put the ranked list beside the chips.
  return (
    <div className="grid grid-cols-1 gap-x-10 lg:grid-cols-2">
      <section className="min-w-0 lg:order-1 lg:row-span-2">
        <SectionTitle className="mt-4">Top topics</SectionTitle>
        <ol className="flex flex-col gap-1" data-testid="trend-topics">
          {top.map((s, i) => (
            <li
              key={s.text}
              className="animate-rf-rise flex items-center gap-1 rounded-2xl bg-surface pr-1.5 transition-colors hover:bg-surface-2"
              style={{ animationDelay: `${i * 40}ms` }}
            >
              <button
                type="button"
                aria-label={`Reel idea for ${s.text}`}
                onClick={() => onTopic(s.text)}
                className="flex min-h-16 min-w-0 flex-1 items-center gap-4 rounded-2xl py-2 pl-4 text-left"
              >
                <span
                  aria-hidden
                  className={cn(
                    'w-7 shrink-0 text-center text-[28px] leading-none font-extrabold tabular-nums',
                    i === 0 ? 'bg-magic bg-clip-text text-transparent' : 'text-subtle',
                  )}
                >
                  {i + 1}
                </span>
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="truncate text-[16px] font-semibold">{displayTitle(s.text)}</span>
                  <SourceDots ids={s.sources} />
                </span>
              </button>
              <button
                type="button"
                aria-label={`Make a reel about ${s.text}`}
                title="Make this reel"
                onClick={() => make(s.text)}
                className="grid size-11 shrink-0 place-items-center rounded-full bg-surface-2 text-fg transition-colors hover:bg-accent hover:text-accent-fg"
              >
                <ArrowUpRight size={20} />
              </button>
            </li>
          ))}
        </ol>
      </section>

      {chips.length > 0 && (
        <section className="min-w-0 lg:order-2">
          <SectionTitle
            action={
              chips.length > CHIPS_COLLAPSED && (
                <button
                  type="button"
                  aria-expanded={allChips}
                  onClick={() => setAllChips((v) => !v)}
                  className="h-8 rounded-full px-3 text-sm font-semibold text-accent hover:bg-surface-2"
                >
                  {allChips ? 'Show less' : `Show all (${chips.length})`}
                </button>
              )
            }
            className="mt-8 lg:mt-4"
          >
            More topics
          </SectionTitle>
          <ul className="flex flex-wrap gap-2" data-testid="trend-more-topics">
            {shownChips.map((s) => (
              <li key={`${s.format ? 'f' : 't'}:${s.text}`}>
                <button
                  type="button"
                  aria-label={`Reel idea for ${s.text}`}
                  onClick={() => onTopic(s.text)}
                  className="flex h-10 items-center gap-2 rounded-full bg-surface-2 px-3.5 text-sm font-medium transition-colors hover:bg-surface-3"
                >
                  {s.format && <Sparkles size={14} aria-hidden className="text-violet" />}
                  {displayTitle(s.text)}
                  <SourceDots ids={s.sources} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {trends.sounds.length > 0 && (
        <section className="min-w-0 lg:order-4 lg:col-span-2">
          <SectionTitle>Sounds</SectionTitle>
          <SoundRail sounds={trends.sounds} previews={trends.soundPreview === true} />
        </section>
      )}

      {trends.hashtags.length > 0 && (
        <section className="min-w-0 lg:order-3">
          <SectionTitle
            action={
              <div className="flex items-center">
                {trends.hashtags.length > TAGS_COLLAPSED && (
                  <button
                    type="button"
                    aria-expanded={allTags}
                    onClick={() => setAllTags((v) => !v)}
                    className="h-8 rounded-full px-3 text-sm font-semibold text-muted hover:bg-surface-2 hover:text-fg"
                  >
                    {allTags ? 'Less' : `All ${trends.hashtags.length}`}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() =>
                    void copy(trends.hashtags.map((h) => `#${h}`).join(' '), 'Hashtags')
                  }
                  className="flex h-8 items-center gap-1.5 rounded-full px-3 text-sm font-semibold text-accent hover:bg-surface-2"
                >
                  <Copy size={14} aria-hidden /> Copy all
                </button>
              </div>
            }
          >
            Hashtags
          </SectionTitle>
          <ul className="flex flex-wrap gap-2" aria-label="Hashtags (tap to copy)">
            {(allTags ? trends.hashtags : trends.hashtags.slice(0, TAGS_COLLAPSED)).map((h) => (
              <li key={h}>
                <button
                  type="button"
                  aria-label={`Copy #${h}`}
                  className="flex h-9 items-center gap-0.5 rounded-full bg-violet/12 px-3 text-sm font-medium text-fg transition-colors hover:bg-violet/25"
                  onClick={() => void copy(`#${h}`, `#${h}`)}
                >
                  <Hash size={13} aria-hidden className="text-violet" />
                  {h}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {generated.length > 0 && (
        <section className="min-w-0 lg:order-5 lg:col-span-2">
          <SectionTitle>New today</SectionTitle>
          <TemplateRail entries={generated} onPick={setChosen} testId="trend-templates" />
        </section>
      )}
      {chosen && <TemplateSheet entry={chosen} onClose={() => setChosen(null)} />}
    </div>
  )
}

/** Plays a sound's official preview through the host, one at a time. */
function usePreviewPlayer() {
  const audio = useRef<HTMLAudioElement | null>(null)
  const url = useRef<string | null>(null)
  const ac = useRef<AbortController | null>(null)
  const [state, setState] = useState<{ key: string; loading: boolean } | null>(null)

  const stop = () => {
    ac.current?.abort()
    audio.current?.pause()
    audio.current = null
    if (url.current) URL.revokeObjectURL(url.current)
    url.current = null
    setState(null)
  }
  useEffect(
    () => () => {
      ac.current?.abort()
      audio.current?.pause()
      if (url.current) URL.revokeObjectURL(url.current)
    },
    [],
  )

  const toggle = async (key: string, sound: Sound) => {
    const same = state?.key === key
    stop()
    if (same) return
    const ctrl = new AbortController()
    ac.current = ctrl
    setState({ key, loading: true })
    try {
      const ref = { title: sound.title, ...(sound.artist ? { artist: sound.artist } : {}) }
      const info = await api.soundPreviewInfo(ref, ctrl.signal)
      if (!info.available) {
        toast('No preview for this one', { description: 'Open it with the link instead.' })
        setState(null)
        return
      }
      const buf = await api.soundPreviewAudio(ref, ctrl.signal)
      if (ctrl.signal.aborted) return
      url.current = URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' }))
      const el = new Audio(url.current)
      audio.current = el
      el.addEventListener('ended', () => setState(null), { once: true })
      await el.play()
      setState({ key, loading: false })
    } catch (err) {
      if (!ctrl.signal.aborted) {
        toast.error("Couldn't play the preview", err instanceof Error ? err.message : undefined)
        setState(null)
      }
    }
  }
  return { state, toggle }
}

function SoundRail({ sounds, previews }: { sounds: readonly Sound[]; previews: boolean }) {
  const navigate = useNavigate()
  const player = usePreviewPlayer()
  return (
    <ul
      className="no-scrollbar -mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-1 md:-mx-6 md:scroll-px-6 md:px-6"
      data-testid="trend-sounds"
    >
      {sounds.map((s, i) => {
        const key = `${s.title}|${s.artist ?? ''}`
        const playing = player.state?.key === key
        return (
          <li
            key={key}
            className="flex w-60 shrink-0 snap-start flex-col gap-3 rounded-2xl bg-surface p-3"
          >
            <div className="flex items-center gap-3">
              <div
                aria-hidden
                className="grid size-12 shrink-0 place-items-center rounded-xl text-white"
                style={{
                  backgroundImage: `linear-gradient(135deg, ${GRADS[i % GRADS.length]!.join(', ')})`,
                }}
              >
                <Music2 size={20} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-semibold">{s.title}</p>
                <p className="truncate text-xs text-muted">{s.artist ?? ' '}</p>
              </div>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted">
              <span
                className="rounded-full bg-surface-2 px-2 py-0.5 font-medium tabular-nums"
                title={s.measured ? undefined : 'Estimated tempo'}
              >
                {s.measured ? '' : '~'}
                {Math.round(s.bpm)} BPM
              </span>
              {s.fresh && (
                <span className="rounded-full bg-accent/15 px-2 py-0.5 font-medium text-accent">
                  New
                </span>
              )}
              <SourceDots ids={s.sources} />
            </div>
            <div className="mt-auto flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => void navigate(`/?autoedit=1&vibe=${vibeForSound(s)}`)}
                className="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-full bg-surface-2 text-sm font-semibold transition-colors hover:bg-surface-3"
              >
                <Sparkles size={15} aria-hidden className="text-accent" />
                Use vibe
              </button>
              {previews && (
                <button
                  type="button"
                  aria-label={playing ? `Stop ${s.title}` : `Play ${s.title}`}
                  aria-pressed={playing}
                  onClick={() => void player.toggle(key, s)}
                  className="grid size-10 shrink-0 place-items-center rounded-full bg-surface-2 transition-colors hover:bg-surface-3 aria-pressed:bg-accent aria-pressed:text-accent-fg"
                >
                  {playing && player.state?.loading ? (
                    <Spinner size={16} />
                  ) : playing ? (
                    <Pause size={16} />
                  ) : (
                    <Play size={16} />
                  )}
                </button>
              )}
              <a
                href={s.link}
                target="_blank"
                rel="noreferrer noopener"
                aria-label={`Find ${s.title}`}
                title="Open"
                className="grid size-10 place-items-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-fg"
              >
                <ExternalLink size={16} />
              </a>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

const GRADS: readonly (readonly [string, string])[] = [
  ['#ff2d7a', '#8b5cf6'],
  ['#0ea5c6', '#6d5ef0'],
  ['#f59e0b', '#ef4444'],
  ['#22c55e', '#0ea5c6'],
  ['#a238ff', '#fa2d55'],
]

/** Reel idea for a topic: cached ideas from the daily run, else asked from the host. */
function IdeaSheet({
  topic,
  trends,
  onClose,
}: {
  topic: string
  trends: Trends | undefined
  onClose: () => void
}) {
  const cached = trends?.ideas.find((i) => i.topic.toLowerCase() === topic.toLowerCase())
  const ask = useTrendIdea()
  const { mutate } = ask
  useEffect(() => {
    if (!cached) mutate(topic)
  }, [cached, mutate, topic])
  const idea = cached ?? ask.data
  return (
    <AdaptiveModal open onClose={onClose} title={idea?.title || topic}>
      {idea ? (
        <IdeaBody idea={idea} onDone={onClose} />
      ) : ask.isError ? (
        <p className="text-sm text-danger">{ask.error.message}</p>
      ) : (
        <div className="flex items-center gap-2 py-6 text-sm text-muted">
          <Spinner size={18} /> Writing an idea…
        </div>
      )}
    </AdaptiveModal>
  )
}

function IdeaSection({
  title,
  children,
  action,
}: {
  title: ReactNode
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex min-h-8 items-center justify-between text-[13px] font-semibold tracking-wider text-muted uppercase">
        {title}
        {action}
      </h3>
      {children}
    </section>
  )
}

function IdeaBody({ idea, onDone }: { idea: ReelIdea; onDone: () => void }) {
  const packs = usePacks()
  const trends = useTrends()
  const navigate = useNavigate()
  const [sheet, setSheet] = useState<TemplateEntry | null>(null)
  const templates = useMemo(() => listTemplates(packs.data, trends.data), [packs.data, trends.data])
  const template =
    templates.find((t) => t.ref === idea.template) ?? latestMatchingTemplate(templates, idea.topic)
  const make = () => {
    const url = autoEditUrl(idea, template?.ref)
    if (url) {
      onDone()
      void navigate(url)
    } else if (template) setSheet(template)
    else toast('No templates yet', { description: 'Check for updates in Settings.' })
  }
  return (
    <div className="flex flex-col gap-5 pb-2" data-testid="reel-idea">
      <IdeaSection
        title={
          <span className="flex items-center gap-1.5">
            <Lightbulb size={14} className="text-warning" aria-hidden /> Hooks
          </span>
        }
      >
        <ul className="flex flex-col gap-1.5">
          {idea.hooks.map((h) => (
            <li key={h} className="rounded-xl bg-surface-2 px-3.5 py-2.5 text-[15px] font-medium">
              {h}
            </li>
          ))}
        </ul>
      </IdeaSection>
      <IdeaSection title="Shots">
        <ol className="flex flex-col gap-1.5 text-[15px]">
          {idea.shots.map((s, i) => (
            <li key={s} className="flex gap-3">
              <span className="w-4 shrink-0 text-right text-muted tabular-nums">{i + 1}</span>
              {s}
            </li>
          ))}
        </ol>
      </IdeaSection>
      <IdeaSection
        title="Caption"
        action={
          <button
            type="button"
            onClick={() => void copy(postText(idea), 'Caption')}
            className="flex h-8 items-center gap-1.5 rounded-full px-3 text-sm font-semibold tracking-normal text-accent normal-case hover:bg-surface-2"
          >
            <Copy size={14} aria-hidden /> Copy
          </button>
        }
      >
        <p className="text-[15px] whitespace-pre-line">{postText(idea)}</p>
      </IdeaSection>
      {template && (
        <p className="text-sm text-muted">
          Template: <b className="font-semibold text-fg">{template.template.name}</b>
          {template.template.musicHint ? ` · ♪ ${template.template.musicHint.title}` : ''}
        </p>
      )}
      <Button
        variant="primary"
        size="lg"
        block
        className="bg-magic"
        icon={<Sparkles size={18} />}
        onClick={make}
      >
        Make this reel
      </Button>
      {sheet && <TemplateSheet entry={sheet} onClose={() => setSheet(null)} />}
    </div>
  )
}
