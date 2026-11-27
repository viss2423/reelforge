/**
 * Home → "Auto edit": pick clips (and optionally a song), a length and a vibe; ReelForge
 * creates the project, uploads in the background and the editor runs Auto edit as soon as
 * the clips have landed. Opened with `?autoedit=1&topic=…&vibe=…` from the trends screen.
 */
import { Music, Sparkles, Upload, X } from 'lucide-react'
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
import { Chips } from '@/editor/panels/ui.tsx'
import { enqueueUploads } from '@/state/uploads.ts'
import { newProjectName } from './useImport.ts'

export interface AutoEditPrefill {
  topic?: string
  vibe?: string
}

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
  const [clips, setClips] = useState<File[]>([])
  const [music, setMusic] = useState<File | null>(null)
  const [target, setTarget] = useState<string>('30')
  const [vibe, setVibe] = useState<string>(vibeById(prefill?.vibe).id)
  const [topic, setTopic] = useState(prefill?.topic ?? '')

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

  return (
    <AdaptiveModal
      open={open}
      onClose={onClose}
      title="Auto edit"
      description="Raw clips in, finished reel out. Everything is processed on your computer."
      locked={create.isPending}
      footer={
        <Button
          variant="primary"
          block
          icon={<Sparkles size={18} />}
          disabled={!clips.length}
          loading={create.isPending}
          onClick={() => void start()}
          data-testid="autoedit-start"
        >
          {clips.length
            ? `Make my reel (${clips.length} clip${clips.length === 1 ? '' : 's'})`
            : 'Pick clips first'}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <FileButton
            testId="autoedit-clips"
            accept="video/*,image/*"
            onFiles={(f) => setClips((c) => [...c, ...f])}
            className="h-14 gap-2 rounded-xl border border-dashed border-line bg-surface-2 font-semibold"
          >
            <Upload size={20} />
            {clips.length ? 'Add more clips' : 'Pick videos and photos'}
          </FileButton>
          {clips.length > 0 && (
            <ul className="flex flex-col gap-1 text-sm" aria-label="Chosen clips">
              {clips.map((f, i) => (
                <li key={`${f.name}-${i}`} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${f.name}`}
                    className="text-muted"
                    onClick={() => setClips((c) => c.filter((_, j) => j !== i))}
                  >
                    <X size={16} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex items-center gap-2">
          <FileButton
            testId="autoedit-music"
            accept="audio/*"
            multiple={false}
            onFiles={(f) => setMusic(f[0] ?? null)}
            className="h-11 gap-2 rounded-xl bg-surface-2 px-3 text-sm font-semibold"
          >
            <Music size={18} />
            {music ? 'Change song' : 'Add a song (optional)'}
          </FileButton>
          <span className="min-w-0 flex-1 truncate text-sm text-muted">
            {music ? music.name : 'Otherwise music is picked to match the vibe'}
          </span>
        </div>
        <Chips
          label="Length"
          options={TARGETS.map((t) => ({ value: String(t), label: `${t} s` }))}
          value={target}
          onChange={setTarget}
        />
        <Chips
          label="Vibe"
          options={VIBES.map((v) => ({ value: v.id, label: v.label }))}
          value={vibe}
          onChange={setVibe}
        />
        <label className="flex flex-col gap-1 text-sm font-semibold">
          Topic (optional)
          <input
            value={topic}
            maxLength={80}
            placeholder="e.g. Lisbon weekend, gym routine"
            onChange={(e) => setTopic(e.target.value)}
            className="h-11 rounded-xl border border-line bg-surface-2 px-3 text-base font-normal outline-none focus:border-accent"
          />
        </label>
      </div>
    </AdaptiveModal>
  )
}
