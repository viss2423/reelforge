/**
 * Audio tool: add music (upload or library) and record a voiceover on the device. New
 * audio lands at the playhead; a voiceover lands where recording started, so it lines up
 * with the picture that was playing while it was spoken.
 */
import { insertAudioClip, type Asset, type AudioClip, type Us } from '@reelforge/core'
import { Mic, Music, Square, Upload, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/Button.tsx'
import { FileButton } from '@/components/FileButton.tsx'
import { Spinner } from '@/components/Spinner.tsx'
import { toast } from '@/components/Toast.tsx'
import { formatDuration } from '@/lib/format.ts'
import { editorStore } from '@/state/editorStore.ts'
import { useAssetsMap } from '@/state/selectors.ts'
import { isAssetPlaceable } from '../../actions.ts'
import { describeError, edit } from '../model/commands.ts'
import { uploadAndWait } from '../upload.ts'
import { Hint, PanelBody, Section } from '../ui.tsx'
import { canRecord, startRecording, type ActiveRecording } from './recorder.ts'

/** Inserts an audio asset at `at` with `role` and selects it. Returns the new clip id. */
export const addAudio = (asset: Asset, at: Us, role: AudioClip['role']): string | undefined => {
  const clip = edit(role === 'voiceover' ? 'Add voiceover' : 'Add music', (d) =>
    insertAudioClip(d, { asset, at, role }),
  )
  if (clip) editorStore.getState().select([clip.id])
  return clip?.id
}

function MusicSection() {
  const assets = useAssetsMap()
  const [busy, setBusy] = useState(false)
  const music = Object.values(assets)
    .filter((a) => a.kind === 'audio' && isAssetPlaceable(a))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const upload = async (files: File[]) => {
    const file = files[0]
    if (!file) return
    setBusy(true)
    const at = editorStore.getState().playhead
    try {
      addAudio(await uploadAndWait(file), at, 'music')
    } catch (err) {
      toast.error("Couldn't add music", describeError(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section
      title="Music"
      action={
        <FileButton
          onFiles={(f) => void upload(f)}
          accept="audio/*"
          multiple={false}
          disabled={busy}
          testId="upload-music"
          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-sm font-semibold text-accent-fg"
        >
          {busy ? <Spinner /> : <Upload size={14} />} Upload
        </FileButton>
      }
    >
      {music.length === 0 ? (
        <Hint>
          Upload a track — it is added at the playhead. Turn on ducking to keep voices clear.
        </Hint>
      ) : (
        <ul className="flex flex-col gap-1" aria-label="Audio library">
          {music.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => addAudio(a, editorStore.getState().playhead, 'music')}
                className="flex min-h-12 w-full items-center gap-3 rounded-xl px-2 text-left hover:bg-surface-2"
              >
                <span className="grid size-9 place-items-center rounded-lg bg-violet/20 text-violet">
                  <Music size={18} />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">{a.name}</span>
                {a.duration !== undefined && (
                  <span className="text-xs text-muted tabular-nums">
                    {formatDuration(a.duration)}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

type RecState =
  | { status: 'idle' }
  | { status: 'starting' }
  | { status: 'recording'; rec: ActiveRecording; at: Us }
  | { status: 'uploading' }

function VoiceoverSection() {
  const [state, setState] = useState<RecState>({ status: 'idle' })
  const [elapsed, setElapsed] = useState(0)
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  // Leaving the panel mid-recording throws the take away and releases the microphone.
  useEffect(
    () => () => {
      const s = stateRef.current
      if (s.status === 'recording') {
        s.rec.discard()
        editorStore.getState().setPlaying(false)
      }
    },
    [],
  )

  useEffect(() => {
    if (state.status !== 'recording') return
    const started = state.rec.startedAt
    const id = setInterval(() => setElapsed(performance.now() - started), 250)
    return () => clearInterval(id)
  }, [state])

  const start = async () => {
    setState({ status: 'starting' })
    try {
      const rec = await startRecording()
      const s = editorStore.getState()
      setElapsed(0)
      setState({ status: 'recording', rec, at: s.playhead })
      // Play the edit while recording so the voice can follow the picture.
      s.setPlaying(true)
    } catch (err) {
      setState({ status: 'idle' })
      toast.error("Couldn't start recording", describeError(err))
    }
  }

  const stop = async () => {
    if (state.status !== 'recording') return
    const { rec, at } = state
    editorStore.getState().setPlaying(false)
    setState({ status: 'uploading' })
    try {
      const { file } = await rec.stop()
      addAudio(await uploadAndWait(file), at, 'voiceover')
      toast.success('Voiceover added')
    } catch (err) {
      toast.error("Couldn't add the voiceover", describeError(err))
    } finally {
      setState({ status: 'idle' })
    }
  }

  const cancel = () => {
    if (state.status !== 'recording') return
    state.rec.discard()
    editorStore.getState().setPlaying(false)
    setState({ status: 'idle' })
  }

  if (!canRecord())
    return (
      <Section title="Voiceover">
        <Hint>
          This browser can&apos;t record audio. Open ReelForge over HTTPS on your phone to record.
        </Hint>
      </Section>
    )

  return (
    <Section title="Voiceover">
      {state.status === 'recording' ? (
        <div className="flex items-center gap-3">
          <span className="size-3 animate-pulse rounded-full bg-danger" aria-hidden />
          <span className="flex-1 font-mono text-lg tabular-nums" aria-live="off">
            {formatDuration(elapsed * 1000)}
          </span>
          <Button variant="ghost" icon={<X size={16} />} onClick={cancel}>
            Discard
          </Button>
          <Button variant="danger" icon={<Square size={16} />} onClick={() => void stop()}>
            Stop
          </Button>
        </div>
      ) : (
        <Button
          variant="primary"
          block
          icon={<Mic size={18} />}
          loading={state.status === 'starting' || state.status === 'uploading'}
          onClick={() => void start()}
        >
          Record voiceover
        </Button>
      )}
      <p className="text-xs text-muted">
        Recording starts at the playhead and plays your edit so you can talk over it.
      </p>
    </Section>
  )
}

export function AudioPanel() {
  return (
    <PanelBody>
      <MusicSection />
      <VoiceoverSection />
    </PanelBody>
  )
}
