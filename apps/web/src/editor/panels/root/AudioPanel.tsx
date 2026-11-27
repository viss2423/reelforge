/**
 * Audio tool, in three tabs: For you (one-tap Auto music and today's trending sounds),
 * Library (the royalty-free browser) and Mine (your uploads and a voiceover recorded on the
 * device). New audio lands at the playhead; a voiceover lands where recording started, so it
 * lines up with the picture that was playing while it was spoken.
 */
import { insertAudioClip, type Asset, type AudioClip, type Us } from '@reelforge/core'
import { Mic, Music, Square, Upload, X } from 'lucide-react'
import { Tabs } from '@/components/Tabs.tsx'
import { cn } from '@/lib/cn.ts'
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
import { AutoMusicSection, MusicLibrarySection } from './AutoMusic.tsx'
import { TrendingSounds } from './TrendingSounds.tsx'
import { PanelBody, Section } from '../ui.tsx'
import { canRecord, startRecording, type ActiveRecording } from './recorder.ts'

/** Inserts an audio asset at `at` with `role` and selects it. Returns the new clip id. */
export const addAudio = (asset: Asset, at: Us, role: AudioClip['role']): string | undefined => {
  const clip = edit(role === 'voiceover' ? 'Add voiceover' : 'Add music', (d) =>
    insertAudioClip(d, { asset, at, role }),
  )
  if (clip) editorStore.getState().select([clip.id])
  return clip?.id
}

const tileClass =
  'flex min-h-20 flex-col items-center justify-center gap-1.5 rounded-2xl bg-surface-2 px-2 text-sm font-semibold transition-[background-color,transform] duration-150 hover:bg-surface-3 active:scale-[0.97]'

type RecState =
  | { status: 'idle' }
  | { status: 'starting' }
  | { status: 'recording'; rec: ActiveRecording; at: Us }
  | { status: 'uploading' }

/** "Mine": upload your own track or record a voiceover, then your uploaded tracks. */
function MineTab() {
  const assets = useAssetsMap()
  const [uploading, setUploading] = useState(false)
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

  const music = Object.values(assets)
    .filter((a) => a.kind === 'audio' && isAssetPlaceable(a))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  const upload = async (files: File[]) => {
    const file = files[0]
    if (!file) return
    setUploading(true)
    const at = editorStore.getState().playhead
    try {
      addAudio(await uploadAndWait(file), at, 'music')
    } catch (err) {
      toast.error("Couldn't add music", describeError(err))
    } finally {
      setUploading(false)
    }
  }

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

  const recordable = canRecord()
  return (
    <>
      {state.status === 'recording' ? (
        <section
          aria-label="Voiceover"
          className="panels-enter flex items-center gap-3 rounded-2xl bg-danger/10 py-2 pr-2 pl-4"
        >
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
        </section>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <FileButton
            onFiles={(f) => void upload(f)}
            accept="audio/*"
            multiple={false}
            disabled={uploading}
            testId="upload-music"
            label="Upload music"
            className={tileClass}
          >
            {uploading ? <Spinner /> : <Upload size={22} className="text-violet" />}
            Upload
          </FileButton>
          <button
            type="button"
            disabled={!recordable || state.status !== 'idle'}
            onClick={() => void start()}
            className={cn(tileClass, 'disabled:opacity-50')}
            aria-label="Record voiceover"
          >
            {state.status === 'idle' ? <Mic size={22} className="text-accent" /> : <Spinner />}
            Voiceover
          </button>
        </div>
      )}
      <p className="-mt-2 text-xs text-muted">
        {recordable
          ? 'Recording starts at the playhead and plays your edit.'
          : 'Recording needs ReelForge opened over HTTPS on your phone.'}
      </p>
      {music.length > 0 && (
        <Section title="Your music">
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
        </Section>
      )}
    </>
  )
}

type AudioTab = 'foryou' | 'library' | 'mine'
const AUDIO_TABS = [
  { id: 'foryou', label: 'For you' },
  { id: 'library', label: 'Library' },
  { id: 'mine', label: 'Mine' },
] as const

/** The tab last used in this session (reopening the sheet returns to it). */
let lastTab: AudioTab = 'foryou'

export function AudioPanel() {
  const [tab, setTab] = useState<AudioTab>(lastTab)
  return (
    <PanelBody>
      <Tabs
        label="Audio"
        items={AUDIO_TABS}
        value={tab}
        onChange={(t) => {
          lastTab = t
          setTab(t)
        }}
        className="-mt-2"
      />
      {tab === 'foryou' ? (
        <>
          <AutoMusicSection />
          <TrendingSounds />
        </>
      ) : tab === 'library' ? (
        <MusicLibrarySection />
      ) : (
        <MineTab />
      )}
    </PanelBody>
  )
}
