/**
 * Generates the media the specs upload, all from FFmpeg lavfi sources (and, on Windows, the
 * built-in SAPI voice for speech). Nothing binary is committed.
 *
 * - SAMPLE_VIDEO: 3 s vertical 1080×1920 H.264/AAC clip (testsrc2 + sine)
 * - FLOW_MEDIA: the full-flow spec's two picture clips, spoken clip and music track
 *
 * It also sweeps data dirs that earlier runs had to leave behind (see global-teardown.ts).
 */
import { execFile } from 'node:child_process'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  E2E_DIR,
  E2E_FIXTURES,
  FLOW_CLIP_SECONDS,
  FLOW_MEDIA,
  SAMPLE_SECONDS,
  SAMPLE_VIDEO,
} from './env.ts'

const run = promisify(execFile)
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg'

const ffmpeg = (args: string[]) =>
  run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args]).catch((err: unknown) => {
    throw new Error(
      `e2e setup needs FFmpeg on PATH (or FFMPEG=<path>) to generate test media: ${String(err)}`,
      { cause: err },
    )
  })

const H264_AAC = [
  '-c:v',
  'libx264',
  '-preset',
  'veryfast',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
  '-shortest',
  '-movflags',
  '+faststart',
]

/** A vertical H.264/AAC clip from a lavfi picture source and a tone. */
const toneClip = (video: string, hz: number, seconds: number, out: string) =>
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `${video}=size=1080x1920:rate=30:duration=${seconds}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${hz}:sample_rate=48000:duration=${seconds}`,
    ...H264_AAC,
    out,
  ])

/**
 * Three spoken sentences separated by 1.5 s pauses (what silence removal must cut). SSML
 * breaks keep the pauses exact regardless of the installed voice's pacing.
 */
const SPEECH_SSML = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">
Welcome to ReelForge, the editor that runs on your own computer.
<break time="1500ms"/>
Every caption in this video was written by the host.
<break time="1500ms"/>
Silences are removed and the cuts follow the music.
</speak>`

const TTS_PS1 = `param([string]$Out, [string]$SsmlFile)
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SetOutputToWaveFile($Out)
$s.SpeakSsml([System.IO.File]::ReadAllText($SsmlFile))
$s.Dispose()
`

/** Speech over a black picture (so burned-in captions are measurable). Windows only. */
const speechClip = async (): Promise<void> => {
  if (process.platform !== 'win32') return
  const script = path.join(E2E_FIXTURES, 'tts.ps1')
  const ssml = path.join(E2E_FIXTURES, 'speech.ssml')
  const wav = path.join(E2E_FIXTURES, 'speech.wav')
  await Promise.all([writeFile(script, TTS_PS1), writeFile(ssml, SPEECH_SSML)])
  await run('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-Out',
    wav,
    '-SsmlFile',
    ssml,
  ])
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=c=black:size=1080x1920:rate=30',
    '-i',
    wav,
    // Resample the 16-22 kHz SAPI voice to the 48 kHz phones record at.
    '-ar',
    '48000',
    ...H264_AAC,
    FLOW_MEDIA.speech,
  ])
}

/** 120 BPM: a sharp, decaying 1 kHz click every 0.5 s over a quiet 110 Hz pad. */
const musicTrack = () =>
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    "aevalsrc='0.8*sin(2*PI*1000*t)*exp(-40*mod(t,0.5))+0.15*sin(2*PI*110*t)':s=48000:d=16",
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    FLOW_MEDIA.music,
  ])

/** Older than this, a `reelforge-e2e-<startMs>-<pid>` dir can't belong to a live run. */
const STALE_MS = 6 * 3_600_000

const sweepStaleRuns = async (): Promise<void> => {
  const now = Date.now()
  const names = await readdir(tmpdir()).catch(() => [] as string[])
  const stale = names.filter((name) => {
    const started = Number(/^reelforge-e2e-(\d+)-\d+$/.exec(name)?.[1])
    return started && now - started > STALE_MS && path.join(tmpdir(), name) !== E2E_DIR
  })
  await Promise.all(
    stale.map((name) =>
      rm(path.join(tmpdir(), name), { recursive: true, force: true }).catch(() => undefined),
    ),
  )
}

export default async function globalSetup(): Promise<void> {
  await mkdir(E2E_FIXTURES, { recursive: true })
  await Promise.all([
    toneClip('testsrc2', 440, SAMPLE_SECONDS, SAMPLE_VIDEO),
    toneClip('testsrc2', 330, FLOW_CLIP_SECONDS, FLOW_MEDIA.clipA),
    toneClip('smptehdbars', 550, FLOW_CLIP_SECONDS, FLOW_MEDIA.clipB),
    speechClip(),
    musicTrack(),
    sweepStaleRuns(),
  ])
}
