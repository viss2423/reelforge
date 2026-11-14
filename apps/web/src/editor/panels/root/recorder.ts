/**
 * On-device voiceover capture with MediaRecorder. Only capture happens on the phone; the
 * recording is uploaded as a normal asset and every bit of processing (probe, waveform,
 * denoise, mix) runs on the host.
 */

/** Container/codec preference: Opus in WebM (Chromium/Firefox), AAC in MP4 (Safari). */
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
] as const

export interface RecorderEnv {
  getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream>
  MediaRecorder: typeof MediaRecorder
  now: () => number
}

const defaultEnv = (): RecorderEnv | undefined => {
  if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia)
    return undefined
  return {
    getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
    MediaRecorder,
    now: () => performance.now(),
  }
}

/** True when this browser can record audio. */
export const canRecord = (): boolean => defaultEnv() !== undefined

export const pickMime = (isSupported: (m: string) => boolean): string | undefined =>
  MIME_CANDIDATES.find((m) => isSupported(m))

const extensionFor = (mime: string): string => (mime.startsWith('audio/mp4') ? 'm4a' : 'webm')

export interface Recording {
  file: File
  /** Wall-clock length in ms. */
  durationMs: number
}

export interface ActiveRecording {
  /** Stops and resolves with the recorded file. */
  stop(): Promise<Recording>
  /** Stops and throws the audio away. */
  discard(): void
  readonly startedAt: number
}

/**
 * Asks for the microphone and starts recording. Voice processing (echo cancellation, noise
 * suppression, AGC) is requested from the device: it is free and helps the host's denoise.
 */
export const startRecording = async (
  env: RecorderEnv | undefined = defaultEnv(),
): Promise<ActiveRecording> => {
  if (!env) throw new Error('Recording is not supported in this browser')
  const stream = await env.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  })
  const mime = pickMime((m) => env.MediaRecorder.isTypeSupported(m))
  const recorder = new env.MediaRecorder(stream, {
    ...(mime ? { mimeType: mime } : {}),
    audioBitsPerSecond: 128_000,
  })
  const chunks: Blob[] = []
  recorder.addEventListener('dataavailable', (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  })
  const release = () => {
    for (const t of stream.getTracks()) t.stop()
  }
  const startedAt = env.now()
  // Timeslice: chunks stream out every second instead of one huge buffer at the end.
  recorder.start(1000)
  return {
    startedAt,
    stop: () =>
      new Promise<Recording>((resolve, reject) => {
        recorder.addEventListener(
          'stop',
          () => {
            release()
            const type = recorder.mimeType || mime || 'audio/webm'
            const blob = new Blob(chunks, { type })
            if (blob.size === 0) {
              reject(new Error('Nothing was recorded'))
              return
            }
            const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
            resolve({
              file: new File([blob], `voiceover-${stamp}.${extensionFor(type)}`, { type }),
              durationMs: env.now() - startedAt,
            })
          },
          { once: true },
        )
        recorder.addEventListener('error', () => reject(new Error('Recording failed')), {
          once: true,
        })
        recorder.stop()
      }),
    discard: () => {
      if (recorder.state !== 'inactive') recorder.stop()
      release()
    },
  }
}
