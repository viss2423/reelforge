/**
 * Generates the media the specs upload: a 3 s vertical 1080×1920 H.264/AAC clip from FFmpeg
 * lavfi sources (testsrc2 + sine). Nothing binary is committed.
 */
import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { promisify } from 'node:util'
import { E2E_FIXTURES, SAMPLE_SECONDS, SAMPLE_VIDEO } from './env.ts'

const run = promisify(execFile)

export default async function globalSetup(): Promise<void> {
  await mkdir(E2E_FIXTURES, { recursive: true })
  const ffmpeg = process.env.FFMPEG ?? 'ffmpeg'
  try {
    await run(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=1080x1920:rate=30:duration=${SAMPLE_SECONDS}`,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:sample_rate=48000:duration=${SAMPLE_SECONDS}`,
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
      SAMPLE_VIDEO,
    ])
  } catch (err) {
    throw new Error(
      `e2e setup needs FFmpeg on PATH (or FFMPEG=<path>) to generate test media: ${String(err)}`,
      { cause: err },
    )
  }
}
