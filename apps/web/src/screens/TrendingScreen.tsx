/**
 * Trending Now: what the host's trend engine found today — topics, edit formats, hashtags
 * and trending sounds (names and links only), each with its sources and freshness — plus
 * the templates it generated. Tapping a topic shows a reel idea (hooks, shot list, caption,
 * hashtags, suggested template) with "Make this reel". Pull down (or tap refresh) to ask
 * the host for a fresh run.
 */
import {
  Copy,
  ExternalLink,
  Hash,
  Lightbulb,
  Music,
  RefreshCw,
  Sparkles,
  TrendingUp,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode, type TouchEvent } from 'react'
import { useNavigate } from 'react-router'
import { usePacks, useRefreshTrends, useTrendIdea, useTrends } from '@/api/queries.ts'
import type { ReelIdea, Trends } from '@/api/schemas.ts'
import { Button } from '@/components/Button.tsx'
import { AdaptiveModal } from '@/components/Dialog.tsx'
import { EmptyState } from '@/components/EmptyState.tsx'
import { IconButton } from '@/components/IconButton.tsx'
import { Skeleton } from '@/components/Skeleton.tsx'
import { Spinner } from '@/components/Spinner.tsx'
import { toast } from '@/components/Toast.tsx'
import { formatRelative } from '@/lib/format.ts'
import { latestMatchingTemplate, listTemplates, type TemplateEntry } from '@/lib/packs.ts'
import { autoEditUrl, postText, sourceLabel } from '@/lib/trends.ts'
import { AppFrame, SectionTitle } from './AppFrame.tsx'
import { TemplateSheet } from './home/Templates.tsx'

const PULL_THRESHOLD = 70

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

export function TrendingScreen() {
  const trends = useTrends()
  const refresh = useRefreshTrends()
  const [topic, setTopic] = useState<string | null>(null)

  const doRefresh = () =>
    refresh.mutate(undefined, {
      onSuccess: () => toast.success('Refreshing trends on the host…'),
      onError: (e) => toast.error('Could not refresh trends', e.message),
    })
  const { pull, handlers } = usePullToRefresh(doRefresh)
  const t = trends.data
  const busy = refresh.isPending || t?.running === true

  return (
    <AppFrame
      title="Trending now"
      actions={
        <IconButton
          label="Refresh trends"
          onClick={doRefresh}
          disabled={busy}
          icon={busy ? <Spinner size={18} /> : <RefreshCw size={20} />}
        />
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
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-20 w-full" />
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
            description={
              t?.lastError
                ? `Last attempt failed: ${t.lastError}`
                : 'Your computer checks free trend sources every day. Tap refresh to run it now.'
            }
            action={
              <Button variant="primary" loading={busy} onClick={doRefresh}>
                Refresh now
              </Button>
            }
          />
        ) : (
          <TrendingContent trends={t} busy={busy} onTopic={setTopic} />
        )}
      </div>
      {topic && <IdeaSheet topic={topic} trends={t} onClose={() => setTopic(null)} />}
    </AppFrame>
  )
}

function Freshness({ trends, busy }: { trends: Trends; busy: boolean }) {
  return (
    <p className="mt-3 text-xs text-muted" data-testid="trends-updated">
      {busy ? 'Refreshing… · ' : ''}Updated {formatRelative(trends.generatedAt!)}
      {' · '}
      {trends.sources
        .filter((s) => s.state === 'ok')
        .map((s) => sourceLabel(s.id))
        .join(', ')}
      {trends.stale ? ' · out of date' : ''}
    </p>
  )
}

const Sources = ({ ids }: { ids: readonly string[] }) => (
  <span className="text-[11px] text-muted">{ids.map(sourceLabel).join(' · ')}</span>
)

function Chip({
  children,
  onClick,
  label,
}: {
  children: ReactNode
  onClick: () => void
  label: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex min-h-11 flex-col items-start justify-center rounded-xl border border-line bg-surface px-3 py-1.5 text-left active:bg-surface-2"
    >
      {children}
    </button>
  )
}

function TrendingContent({
  trends,
  busy,
  onTopic,
}: {
  trends: Trends
  busy: boolean
  onTopic: (topic: string) => void
}) {
  const packs = usePacks()
  const [chosen, setChosen] = useState<TemplateEntry | null>(null)
  const generated = useMemo(
    () => listTemplates(packs.data, trends).filter((e) => e.packId === 'trending-live'),
    [packs.data, trends],
  )
  return (
    <>
      <Freshness trends={trends} busy={busy} />

      <SectionTitle>Topics people are into</SectionTitle>
      <ul className="flex flex-wrap gap-2" data-testid="trend-topics">
        {trends.topics.map((s) => (
          <li key={s.text}>
            <Chip label={`Reel idea for ${s.text}`} onClick={() => onTopic(s.text)}>
              <span className="text-sm font-semibold capitalize">{s.text}</span>
              <Sources ids={s.sources} />
            </Chip>
          </li>
        ))}
      </ul>

      {trends.formats.length > 0 && (
        <>
          <SectionTitle>Formats</SectionTitle>
          <ul className="flex flex-wrap gap-2">
            {trends.formats.map((s) => (
              <li key={s.text}>
                <Chip label={`Reel idea for ${s.text}`} onClick={() => onTopic(s.text)}>
                  <span className="text-sm font-semibold capitalize">{s.text}</span>
                  <Sources ids={s.sources} />
                </Chip>
              </li>
            ))}
          </ul>
        </>
      )}

      {generated.length > 0 && (
        <>
          <SectionTitle>Made for today</SectionTitle>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="trend-templates">
            {generated.map((e) => (
              <li key={e.ref}>
                <button
                  type="button"
                  className="block w-full rounded-card border border-line bg-surface p-3 text-left"
                  onClick={() => setChosen(e)}
                >
                  {e.fresh && (
                    <span className="mb-1 inline-flex items-center gap-1 rounded-md bg-accent px-1.5 py-0.5 text-[11px] font-semibold text-accent-fg">
                      <Sparkles size={12} /> New today
                    </span>
                  )}
                  <p className="truncate text-sm font-semibold">{e.template.name}</p>
                  {e.trend && <p className="truncate text-xs text-muted">from “{e.trend}”</p>}
                  {e.template.musicHint && (
                    <p className="mt-1 flex items-center gap-1 truncate text-xs">
                      <Music size={12} className="shrink-0" /> {e.template.musicHint.title}
                      {e.template.musicHint.bpm ? ` · ${e.template.musicHint.bpm} BPM` : ''}
                    </p>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {trends.sounds.length > 0 && (
        <>
          <SectionTitle>Trending sounds</SectionTitle>
          <p className="-mt-2 mb-2 text-xs text-muted">
            Add the real sound in the app you post to — ReelForge never downloads music.
          </p>
          <ul
            className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface"
            data-testid="trend-sounds"
          >
            {trends.sounds.map((s) => (
              <li key={s.title} className="flex min-h-14 items-center gap-3 px-4 py-2">
                <Music size={18} className="shrink-0 text-violet" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">
                    {s.title}
                    {s.artist ? (
                      <span className="font-normal text-muted"> — {s.artist}</span>
                    ) : null}
                  </p>
                  <p className="text-xs text-muted">
                    {s.bpm} BPM{s.measured ? '' : ' (est.)'} · <Sources ids={s.sources} />
                  </p>
                </div>
                <a
                  href={s.link}
                  target="_blank"
                  rel="noreferrer noopener"
                  aria-label={`Find ${s.title}`}
                  className="grid size-11 place-items-center rounded-xl text-muted"
                >
                  <ExternalLink size={18} />
                </a>
              </li>
            ))}
          </ul>
        </>
      )}

      {trends.hashtags.length > 0 && (
        <>
          <SectionTitle
            action={
              <Button
                size="sm"
                variant="ghost"
                icon={<Copy size={16} />}
                onClick={() => void copy(trends.hashtags.map((h) => `#${h}`).join(' '), 'Hashtags')}
              >
                Copy all
              </Button>
            }
          >
            Hashtags
          </SectionTitle>
          <ul className="flex flex-wrap gap-2">
            {trends.hashtags.map((h) => (
              <li key={h}>
                <button
                  type="button"
                  className="flex h-9 items-center gap-1 rounded-lg bg-surface-2 px-2.5 text-sm"
                  onClick={() => void copy(`#${h}`, `#${h}`)}
                >
                  <Hash size={14} className="text-muted" />
                  {h}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {chosen && <TemplateSheet entry={chosen} onClose={() => setChosen(null)} />}
    </>
  )
}

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
    <AdaptiveModal open onClose={onClose} title={idea?.title || topic} description="Reel idea">
      {idea ? (
        <IdeaBody idea={idea} onDone={onClose} />
      ) : ask.isError ? (
        <p className="text-sm text-danger">{ask.error.message}</p>
      ) : (
        <div className="flex items-center gap-2 py-6 text-sm text-muted">
          <Spinner size={18} /> Writing an idea on your computer…
        </div>
      )}
    </AdaptiveModal>
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
    else toast('No templates yet', { description: 'Sync packs in Settings.' })
  }
  return (
    <div className="flex flex-col gap-4 pb-2" data-testid="reel-idea">
      <section>
        <h3 className="mb-1 flex items-center gap-1.5 text-sm font-bold">
          <Lightbulb size={16} className="text-warning" /> Hooks
        </h3>
        <ul className="flex flex-col gap-1">
          {idea.hooks.map((h) => (
            <li key={h} className="rounded-lg bg-surface-2 px-3 py-2 text-sm">
              {h}
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h3 className="mb-1 text-sm font-bold">Shot list</h3>
        <ol className="list-decimal pl-5 text-sm">
          {idea.shots.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      </section>
      <section>
        <h3 className="mb-1 flex items-center justify-between text-sm font-bold">
          Caption
          <Button
            size="sm"
            variant="ghost"
            icon={<Copy size={16} />}
            onClick={() => void copy(postText(idea), 'Caption')}
          >
            Copy
          </Button>
        </h3>
        <p className="text-sm whitespace-pre-line">{postText(idea)}</p>
      </section>
      {template && (
        <p className="text-sm text-muted">
          Suggested template: <b className="text-fg">{template.template.name}</b>
          {template.template.musicHint ? ` · ♪ ${template.template.musicHint.title}` : ''}
        </p>
      )}
      <Button variant="primary" size="lg" block onClick={make}>
        Make this reel
      </Button>
      {sheet && <TemplateSheet entry={sheet} onClose={() => setSheet(null)} />}
    </div>
  )
}
