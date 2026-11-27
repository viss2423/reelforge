/**
 * The language-model half of the AI panel: Auto Edit (with variants), Best moments,
 * Hook & caption (copywriter) and Improve captions. Tools that need the model say so and
 * stay disabled when the host has none; Auto Edit and Best moments still work (heuristic).
 */
import { Captions, ClipboardCopy, Clapperboard, Plus, Scissors, Sparkles, Type } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useSystem } from '@/api/queries.ts'
import { Button } from '@/components/Button.tsx'
import { toast } from '@/components/Toast.tsx'
import { useEditor } from '@/state/selectors.ts'
import { usePacksData } from '../hooks.ts'
import { Chips, Hint, Section, Toggle } from '../ui.tsx'
import { TARGETS, type TargetSeconds } from './autoedit/flow.ts'
import { startAutoEdit, switchVariant, useAutoEditSession } from './autoedit/session.ts'
import { VIBES } from './autoedit/style.ts'
import {
  insertHookText,
  startBestMoments,
  startCopywriter,
  startImproveCaptions,
  useCopyResult,
} from './llmtools.ts'
import { TaskCard } from './TaskCard.tsx'
import type { AiTaskId } from './tasks.ts'

const TARGET_OPTIONS = TARGETS.map((t) => ({ value: String(t), label: `${t} s` }))
const VIBE_OPTIONS = VIBES.map((v) => ({ value: v.id, label: v.label }))

/** Whether the host has the language model (undefined while loading). */
export const useLlmInstalled = (): boolean | undefined => {
  const s = useSystem()
  return s.isPending ? undefined : (s.data?.llm?.installed ?? false)
}

export const NO_LLM_HINT =
  'Needs the local AI model on the host computer — run `pnpm bootstrap` there, then restart ReelForge.'

function Card({
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

/** Switch between the alternatives the last Auto edit produced. */
function Variants() {
  const projectId = useEditor((s) => s.project?.id)
  const session = useAutoEditSession(projectId)
  if (!session || session.result.variants.length < 2) return null
  return (
    <div className="flex flex-col gap-1.5" data-testid="autoedit-variants">
      <span className="text-xs font-semibold text-muted">Try another version</span>
      <Chips
        label="Auto edit version"
        options={session.result.variants.map((v, i) => ({ value: String(i), label: v.label }))}
        value={String(session.active)}
        onChange={(v) => switchVariant(Number(v))}
      />
    </div>
  )
}

/** The trending sound to add when posting (copy the name; nothing is bundled or generated). */
function TrendingSoundCard() {
  const projectId = useEditor((s) => s.project?.id)
  const sound = useAutoEditSession(projectId)?.result.trendingSound
  if (!sound) return null
  const label = sound.artist ? `${sound.name} — ${sound.artist}` : sound.name
  return (
    <div className="flex flex-col gap-1.5 rounded-xl bg-surface-2 p-3" data-testid="trending-sound">
      <span className="text-xs font-semibold text-muted">
        Suggested trending sound to add when posting
      </span>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-sm font-semibold">{label}</span>
        <Button
          size="sm"
          icon={<ClipboardCopy size={14} />}
          onClick={() => void copyText(label, 'Sound name')}
        >
          Copy
        </Button>
      </div>
    </div>
  )
}

export function AutoEditCard() {
  const packs = usePacksData()
  const llm = useLlmInstalled()
  const language = useEditor((s) => s.project?.captions?.language ?? 'auto')
  const [target, setTarget] = useState<string>('30')
  const [vibe, setVibe] = useState<string>(VIBES[0]!.id)
  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-gradient-to-br from-violet/25 to-accent/15 p-4">
      <div className="flex items-center gap-2">
        <Clapperboard size={20} className="text-violet" />
        <span className="text-lg font-bold">Auto edit</span>
      </div>
      <p className="text-sm text-muted">
        Turns your clips into a finished reel: hook first, best moments, cuts on the beat, music,
        captions and a hook title — one undo step.
        {llm === false ? ' (Smarter with the AI model installed on the host.)' : ''}
      </p>
      <Chips label="Length" options={TARGET_OPTIONS} value={target} onChange={setTarget} />
      <Chips label="Vibe" options={VIBE_OPTIONS} value={vibe} onChange={setVibe} />
      <TaskCard id="autoedit">
        <Button
          variant="primary"
          block
          icon={<Sparkles size={18} />}
          onClick={() =>
            startAutoEdit({
              target: Number(target) as TargetSeconds,
              vibe,
              language,
              llm: llm === true,
              ...(packs ? { packs } : {}),
            })
          }
        >
          Auto edit this project
        </Button>
      </TaskCard>
      <Variants />
      <TrendingSoundCard />
    </div>
  )
}

const copyText = async (text: string, what: string): Promise<void> => {
  try {
    await navigator.clipboard.writeText(text)
    toast(`${what} copied`, { tone: 'success' })
  } catch {
    toast.error(`Couldn't copy the ${what.toLowerCase()}`)
  }
}

function CopyResult() {
  const projectId = useEditor((s) => s.project?.id)
  const copy = useCopyResult(projectId)
  const packs = usePacksData()
  if (!copy) return null
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-surface-2 p-3" data-testid="copy-result">
      <span className="text-xs font-semibold text-muted">Hook text</span>
      {copy.hooks.map((h) => (
        <div key={h} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 text-sm font-semibold">{h}</span>
          <Button
            size="sm"
            icon={<Plus size={14} />}
            aria-label={`Insert “${h}”`}
            onClick={() => {
              insertHookText(h, packs)
              toast('Hook text added', { tone: 'success' })
            }}
          >
            Insert
          </Button>
        </div>
      ))}
      {copy.caption && (
        <>
          <span className="mt-1 text-xs font-semibold text-muted">Caption</span>
          <p className="text-sm">{copy.caption}</p>
        </>
      )}
      {copy.hashtags.length > 0 && <p className="text-sm text-accent">{copy.hashtags.join(' ')}</p>}
      <div className="flex gap-2">
        <Button
          size="sm"
          block
          icon={<ClipboardCopy size={14} />}
          onClick={() => void copyText(copy.caption, 'Caption')}
        >
          Copy caption
        </Button>
        <Button
          size="sm"
          block
          icon={<ClipboardCopy size={14} />}
          onClick={() => void copyText(copy.hashtags.join(' '), 'Hashtags')}
        >
          Copy hashtags
        </Button>
      </div>
    </div>
  )
}

export function WriterTools() {
  const llm = useLlmInstalled()
  const hasCaptions = useEditor((s) => (s.project?.captions?.words.length ?? 0) > 0)
  const [target, setTarget] = useState<string>('30')
  const [chapters, setChapters] = useState(true)
  return (
    <Section title="AI assistant">
      {llm === false && <Hint>{NO_LLM_HINT}</Hint>}
      <Card
        id="highlights"
        icon={<Scissors size={20} />}
        title="Best moments"
        description="Keep the hook and the strongest moments — you review the cut first"
        action={
          <Button block onClick={() => startBestMoments(Number(target))}>
            Find best moments
          </Button>
        }
      >
        <Chips label="Reel length" options={TARGET_OPTIONS} value={target} onChange={setTarget} />
      </Card>
      <Card
        id="copy"
        icon={<Type size={20} />}
        title="Hook & caption"
        description="Three hook titles, a post caption and hashtags in your video's language"
        action={
          <Button block disabled={llm !== true} onClick={() => startCopywriter()}>
            Write hook & caption
          </Button>
        }
      >
        <CopyResult />
      </Card>
      <Card
        id="emphasis"
        icon={<Captions size={20} />}
        title="Improve captions"
        description={
          hasCaptions
            ? 'Highlight the words that matter, add fitting emoji and chapters'
            : 'Generate captions first'
        }
        action={
          <Button
            block
            disabled={llm !== true || !hasCaptions}
            onClick={() => startImproveCaptions({ chapters })}
          >
            Improve captions
          </Button>
        }
      >
        <Toggle
          label="Add chapters"
          description="Topic markers on the timeline"
          checked={chapters}
          onChange={setChapters}
        />
      </Card>
    </Section>
  )
}
