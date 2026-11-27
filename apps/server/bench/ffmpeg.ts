/** Locate FFmpeg for benchmarks: $FFMPEG, then PATH. */
import { execFileSync } from 'node:child_process'
export const findFfmpeg = (): string => {
  if (process.env.FFMPEG) return process.env.FFMPEG
  const cmd = process.platform === 'win32' ? 'where' : 'which'
  return execFileSync(cmd, ['ffmpeg'], { encoding: 'utf8' }).split(/\r?\n/)[0]!.trim()
}
