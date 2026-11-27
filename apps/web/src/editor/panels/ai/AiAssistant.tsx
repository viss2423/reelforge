/**
 * The language-model half of the Magic panel: the Auto edit hero (with its versions and the
 * trending sound to add when posting) and the copywriter's result. Tools that need the
 * local model say so and stay disabled without it; Auto edit still works (heuristic).
 */
import { ClipboardCopy, Clapperboard, Info, Plus, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { useSystem } from '@/api/queries.ts'
import { Button } from '@/components/Button.tsx'
import { SegmentedControl } from '@/components/SegmentedControl.tsx'
import { toast } from '@/components/Toast.tsx'
import { useEditor } from '@/state/selectors.ts'
import { usePacksData } from '../hooks.ts'
import { Chips } from '../ui.tsx'
import { TARGETS, type TargetSeconds } from './autoedit/flow.ts'
import { startAutoEdit, switchVariant, useAutoEditSession } from './autoedit/session.ts'
import { VIBES } from './autoedit/style.ts'
import { insertHookText, useCopyResult } from './llmtools.ts'
import { useAiTask } from './tasks.ts'

const TARGET_OPTIONS = TARGETS.map((t) => ({ value: String(t), label: `${t} s` }))
const VIBE_OPTIONS = VIBES.map((v) => ({ value: v.id, label: v.label }))

/** Whether the host has the language model (undefined while loading). */
export const useLlmInstalled = (): boolean | undefined => {
  const s = useSystem()
  return s.isPending ? undefined : (s.data?.llm?.installed ?? false)
}

/** How to get the model (shown on request, not as a paragraph in the panel). */
export const NO_LLM_HINT =
  'Run `pnpm bootstrap` on the computer that runs ReelForge, then restart ReelForge.'

/** One line saying a tool needs the local model, with the setup steps behind ⓘ. */
export function NeedsModel({ text = 'Needs the local AI model.' }: { text?: string }) {
  return (
    <p className="flex min-h-11 items-center gap-1 text-xs text-muted">
      <span>{text}</span>
      <button
        type="button"
        aria-label="How to install the AI model"
        className="grid size-11 shrink-0 place-items-center rounded-full hover:text-fg"
        onClick={() => toast('Install the AI model', { description: NO_LLM_HINT })}
      >
        <Info size={16} />
      </button>
    </p>
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
    <div
      className="flex items-center gap-2 rounded-2xl bg-black/25 py-1.5 pr-1.5 pl-3"
      data-testid="trending-sound"
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[11px] text-muted">Add when posting</span>
        <span className="truncate text-sm font-semibold">{label}</span>
      </span>
      <Button
        size="sm"
        variant="ghost"
        icon={<ClipboardCopy size={14} />}
        onClick={() => void copyText(label, 'Sound name')}
      >
        Copy
      </Button>
    </div>
  )
}

/** The hero of the Magic panel: length, vibe and one button. */
export function AutoEditHero() {
  const packs = usePacksData()
  const llm = useLlmInstalled()
  const language = useEditor((s) => s.project?.captions?.language ?? 'auto')
  const running = useAiTask('autoedit')?.status === 'running'
  const [target, setTarget] = useState<string>('30')
  const [vibe, setVibe] = useState<string>(VIBES[0]!.id)
  return (
    <section
      aria-label="Auto edit"
      className="panels-magic flex flex-col gap-3 rounded-3xl p-4 ring-1 ring-white/10"
    >
      <div className="flex items-center gap-2.5">
        <span className="grid size-9 place-items-center rounded-xl bg-white/10 text-fg">
          <Clapperboard size={18} />
        </span>
        <div className="flex min-w-0 flex-col">
          <h3 className="text-lg leading-tight font-bold">Auto edit</h3>
          <p className="truncate text-sm text-muted">Your clips, cut into a finished reel.</p>
        </div>
      </div>
      <SegmentedControl
        label="Length"
        size="sm"
        options={TARGET_OPTIONS}
        value={target}
        onChange={setTarget}
        className="bg-black/25"
      />
      <Chips label="Vibe" options={VIBE_OPTIONS} value={vibe} onChange={setVibe} />
      <Button
        variant="primary"
        size="lg"
        block
        className="panels-cta"
        icon={<Sparkles size={18} />}
        loading={running}
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
        Make it a reel
      </Button>
      <Variants />
      <TrendingSoundCard />
    </section>
  )
}

export const copyText = async (text: string, what: string): Promise<void> => {
  try {
    await navigator.clipboard.writeText(text)
    toast(`${what} copied`, { tone: 'success' })
  } catch {
    toast.error(`Couldn't copy the ${what.toLowerCase()}`)
  }
}

/** Hook titles to insert, the post caption and hashtags to copy. */
export function CopyResult() {
  const projectId = useEditor((s) => s.project?.id)
  const copy = useCopyResult(projectId)
  const packs = usePacksData()
  if (!copy) return null
  return (
    <div className="flex flex-col gap-2 rounded-2xl bg-surface-2 p-3" data-testid="copy-result">
      <span className="text-[13px] font-semibold tracking-wide text-muted uppercase">Hooks</span>
      {copy.hooks.map((h) => (
        <div key={h} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 text-sm font-semibold">{h}</span>
          <Button
            size="sm"
            variant="ghost"
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
      {copy.caption && <p className="mt-1 text-sm">{copy.caption}</p>}
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
