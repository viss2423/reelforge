/**
 * Home → "Make a reel" (Auto edit) as a two-step wizard: 1 pick clips → 2 length + vibe →
 * Go. ReelForge creates the project, uploads in the background and the editor runs Auto
 * edit as soon as the clips have landed. Opened with `?autoedit=1&topic=…&vibe=…` from the
 * trends screen.
 */
import { Check, ChevronDown, Film, Music, Sparkles, Upload, X } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useCreateProject } from '@/api/queries.ts'
import { AdaptiveModal } from '@/components/Dialog.tsx'
import { Button } from '@/components/Button.tsx'
import { FileButton } from '@/components/FileButton.tsx'
import { toast } from '@/components/Toast.tsx'
import { TARGETS, type TargetSeconds } from '@/editor/panels/ai/autoedit/flow.ts'
import { queueAutoEdit } from '@/editor/panels/ai/autoedit/session.ts'
import { VIBES, vibeById } from '@/editor/panels/ai/autoedit/style.ts'
import { cn } from '@/lib/cn.ts'
import { haptic } from '@/lib/haptics.ts'
import { enqueueUploads } from '@/state/uploads.ts'
import { newProjectName } from './useImport.ts'

export interface AutoEditPrefill {
  topic?: string
  vibe?: string
}

/** One emoji per vibe: a quick visual cue on the tiles (decorative). */
const VIBE_EMOJI: Record<string, string> = {
  energetic: '⚡',
  cinematic: '🎬',
  aesthetic: '🌸',
  fun: '🎉',
  talking: '🎙️',
}

type Step = 1 | 2

export function AutoEditSheet({
  open,
  onClose,
  prefill,
}: {
  open: boolean
  onClose: () => void
  prefill?: AutoEditPrefill
}) {
  const create = useCreateProject()
  const navigate = useNavigate()
  const [step, setStep] = useState<Step>(1)
  const [clips, setClips] = useState<File[]>([])
  const [music, setMusic] = useState<File | null>(null)
  const [target, setTarget] = useState<string>('30')
  const [vibe, setVibe] = useState<string>(vibeById(prefill?.vibe).id)
  const [topic, setTopic] = useState(prefill?.topic ?? '')
  const [extras, setExtras] = useState(false)

  const addClips = (files: File[]) => {
    setClips((c) => [...c, ...files])
    // Picking is the whole of step 1: move straight on to the look.
    setStep(2)
  }

  const start = async (): Promise<void> => {
    if (!clips.length) return
    try {
      const project = await create.mutateAsync({ name: topic.trim() || newProjectName() })
      queueAutoEdit(project.id, {
        target: Number(target) as TargetSeconds,
        vibe,
        ...(topic.trim() ? { topic: topic.trim() } : {}),
      })
      // Clips first (pick order = main track order), then the song onto the audio track.
      enqueueUploads(music ? [...clips, music] : clips, {
        projectId: project.id,
        addToTimeline: true,
      })
      onClose()
      void navigate(`/p/${project.id}`)
    } catch (err) {
      toast.error('Could not create the project', err instanceof Error ? err.message : undefined)
    }
  }

  const n = clips.length
  return (
    <AdaptiveModal
      open={open}
      onClose={onClose}
      title="Make a reel"
      locked={create.isPending}
      footer={
        <Button
          variant="primary"
          size="lg"
          block
          className="bg-magic"
          icon={<Sparkles size={18} />}
          disabled={!n}
          loading={create.isPending}
          onClick={() => void start()}
          data-testid="autoedit-start"
        >
          {n ? `Make my reel · ${n} clip${n === 1 ? '' : 's'}` : 'Pick clips first'}
        </Button>
      }
    >
      <div className="flex flex-col gap-5">
        <Steps step={step} clips={n} onStep={setStep} />

        {step === 1 ? (
          <div className="flex flex-col gap-3">
            <FileButton
              testId="autoedit-clips"
              accept="video/*,image/*"
              onFiles={addClips}
              className="min-h-44 flex-col gap-3 rounded-3xl border-2 border-dashed border-line bg-surface-2/60 px-6 text-center transition-colors hover:border-accent/60"
            >
              <span className="bg-magic grid size-14 place-items-center rounded-full text-white shadow-pop">
                <Upload size={24} aria-hidden />
              </span>
              <span className="text-base font-semibold">
                {n ? 'Add more clips' : 'Pick videos and photos'}
              </span>
              <span className="text-xs text-muted">In the order you want them</span>
            </FileButton>
            {n > 0 && (
              <ClipList
                clips={clips}
                onRemove={(i) => setClips((c) => c.filter((_, j) => j !== i))}
              />
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-[13px] font-semibold tracking-wider text-muted uppercase">
                Length
              </legend>
              <TileGroup
                label="Length"
                className="grid-cols-3"
                options={TARGETS.map((t) => ({
                  value: String(t),
                  label: `${t} s`,
                  big: String(t),
                  small: 'sec',
                }))}
                value={target}
                onChange={setTarget}
              />
            </fieldset>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-[13px] font-semibold tracking-wider text-muted uppercase">
                Vibe
              </legend>
              <TileGroup
                label="Vibe"
                className="grid-cols-2 sm:grid-cols-3"
                options={VIBES.map((v) => ({
                  value: v.id,
                  label: v.label,
                  emoji: VIBE_EMOJI[v.id] ?? '✨',
                }))}
                value={vibe}
                onChange={setVibe}
              />
            </fieldset>

            <div className="rounded-2xl bg-surface-2/60">
              <button
                type="button"
                aria-expanded={extras}
                onClick={() => setExtras((v) => !v)}
                className="flex min-h-12 w-full items-center gap-3 px-4 text-left text-sm"
              >
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-semibold">Song & topic</span>
                  <span className="text-muted">
                    {' · '}
                    {[music ? music.name : 'Auto music', topic.trim() || null]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                <ChevronDown
                  size={18}
                  aria-hidden
                  className={cn('shrink-0 text-muted transition-transform', extras && 'rotate-180')}
                />
              </button>
              {extras && (
                <div className="flex flex-col gap-3 px-4 pb-4">
                  <div className="flex items-center gap-2">
                    <FileButton
                      testId="autoedit-music"
                      accept="audio/*"
                      multiple={false}
                      onFiles={(f) => setMusic(f[0] ?? null)}
                      className="h-11 gap-2 rounded-full bg-surface-3 px-4 text-sm font-semibold"
                    >
                      <Music size={16} aria-hidden />
                      {music ? 'Change song' : 'Add a song'}
                    </FileButton>
                    {music ? (
                      <button
                        type="button"
                        aria-label="Use auto music"
                        onClick={() => setMusic(null)}
                        className="grid size-11 place-items-center rounded-full text-muted hover:bg-surface-3"
                      >
                        <X size={16} />
                      </button>
                    ) : (
                      <span className="min-w-0 flex-1 truncate text-xs text-muted">
                        Or we pick one for the vibe
                      </span>
                    )}
                  </div>
                  <label className="flex flex-col gap-1.5 text-sm font-semibold">
                    Topic
                    <input
                      value={topic}
                      maxLength={80}
                      placeholder="e.g. Lisbon weekend"
                      onChange={(e) => setTopic(e.target.value)}
                      className="h-11 rounded-xl border border-line bg-surface px-3 text-base font-normal outline-none focus:border-accent"
                    />
                  </label>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </AdaptiveModal>
  )
}

/** "1 Clips — 2 Style" header; tapping a step goes there (step 2 needs clips). */
function Steps({ step, clips, onStep }: { step: Step; clips: number; onStep: (s: Step) => void }) {
  const items = [
    { n: 1 as const, label: clips ? `${clips} clip${clips === 1 ? '' : 's'}` : 'Clips' },
    { n: 2 as const, label: 'Style' },
  ]
  return (
    <ol className="flex items-center gap-2" aria-label="Steps">
      {items.map((it, i) => {
        const current = step === it.n
        const done = it.n === 1 && clips > 0 && step === 2
        return (
          <li key={it.n} className="flex flex-1 items-center gap-2">
            <button
              type="button"
              aria-current={current ? 'step' : undefined}
              disabled={it.n === 2 && clips === 0}
              onClick={() => onStep(it.n)}
              className={cn(
                'flex h-10 flex-1 items-center gap-2 rounded-full pr-3 pl-1 text-sm font-semibold transition-colors disabled:opacity-50',
                current ? 'bg-surface-3 text-fg' : 'text-muted hover:text-fg',
              )}
            >
              <span
                className={cn(
                  'grid size-8 place-items-center rounded-full text-xs font-bold tabular-nums',
                  current || done ? 'bg-magic text-white' : 'bg-surface-2',
                )}
              >
                {done ? <Check size={14} aria-hidden /> : it.n}
              </span>
              <span className="truncate">{it.label}</span>
            </button>
            {i === 0 && <span aria-hidden className="h-px w-4 shrink-0 bg-line" />}
          </li>
        )
      })}
    </ol>
  )
}

function ClipList({ clips, onRemove }: { clips: File[]; onRemove: (i: number) => void }) {
  return (
    <ul className="flex flex-col gap-1" aria-label="Chosen clips">
      {clips.map((f, i) => (
        <li
          key={`${f.name}-${i}`}
          className="flex min-h-11 items-center gap-3 rounded-xl bg-surface-2/60 pr-1 pl-3 text-sm"
        >
          <span className="w-5 shrink-0 text-xs text-muted tabular-nums">{i + 1}</span>
          <Film size={16} aria-hidden className="shrink-0 text-muted" />
          <span className="min-w-0 flex-1 truncate">{f.name}</span>
          <button
            type="button"
            aria-label={`Remove ${f.name}`}
            className="grid size-11 place-items-center rounded-full text-muted hover:text-fg"
            onClick={() => onRemove(i)}
          >
            <X size={16} />
          </button>
        </li>
      ))}
    </ul>
  )
}

interface Tile {
  value: string
  /** Accessible name (exactly what tests and screen readers use). */
  label: string
  big?: string
  small?: string
  emoji?: string
}

/** Big tappable radio tiles. */
function TileGroup({
  label,
  options,
  value,
  onChange,
  className,
}: {
  label: string
  options: readonly Tile[]
  value: string
  onChange: (v: string) => void
  className?: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn('grid gap-2', className)}>
      {options.map((o) => {
        const checked = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={o.label}
            onClick={() => {
              haptic(5)
              onChange(o.value)
            }}
            className={cn(
              'relative flex min-h-16 items-center gap-3 rounded-2xl px-4 text-left font-semibold transition-[background-color,box-shadow,transform] duration-200 ease-[var(--ease-spring)] active:scale-[0.97]',
              o.big && 'flex-col justify-center gap-0 text-center',
              checked
                ? 'bg-accent/12 text-fg ring-2 ring-accent'
                : 'bg-surface-2 text-fg ring-1 ring-transparent hover:bg-surface-3',
            )}
          >
            {o.big ? (
              <>
                <span className="text-2xl leading-none font-bold tabular-nums">{o.big}</span>
                <span className="text-xs font-medium text-muted">{o.small}</span>
              </>
            ) : (
              <>
                <span aria-hidden className="text-xl">
                  {o.emoji}
                </span>
                <span className="min-w-0 text-[15px] leading-tight">{o.label}</span>
              </>
            )}
          </button>
        )
      })}
    </div>
  )
}
