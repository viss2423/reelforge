import { describe, expect, it } from 'vitest'
import {
  FfmpegAbortError,
  FfmpegError,
  ProgressParser,
  RingBuffer,
  parseLoudnorm,
  runFfmpeg,
  summarizeStderr,
  type FfmpegProgress,
} from '../../src/render/ffmpeg.ts'
import { FFMPEG, ffmpegAvailable } from './harness.ts'

const block = (o: Record<string, string>, end = false): string =>
  `${Object.entries(o)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')}\nprogress=${end ? 'end' : 'continue'}\n`

describe('RingBuffer', () => {
  it('keeps only the last `capacity` characters', () => {
    const b = new RingBuffer(10)
    b.push('hello ')
    b.push('world')
    expect(b.toString()).toBe('ello world')
    b.push('0123456789ABCDEF')
    expect(b.toString()).toBe('6789ABCDEF')
    b.push('')
    expect(b.toString()).toBe('6789ABCDEF')
  })

  it('handles many small chunks without growing', () => {
    const b = new RingBuffer(100)
    for (let i = 0; i < 10_000; i++) b.push(`${i % 10}`)
    expect(b.toString()).toHaveLength(100)
    expect(b.toString().endsWith('6789')).toBe(true)
  })
})

describe('ProgressParser', () => {
  it('emits one report per block, across arbitrary chunk boundaries', () => {
    const reports: FfmpegProgress[] = []
    const p = new ProgressParser((r) => reports.push(r))
    const text =
      block({ frame: '12', fps: '0.00', out_time_us: 'N/A', speed: 'N/A' }) +
      block({
        frame: '75',
        fps: '37.5',
        out_time_us: '2500000',
        out_time_ms: '2500000',
        speed: '2.41x',
      }) +
      block({ frame: '900', fps: '41', out_time_us: '30000000', speed: '2.6x' }, true)
    for (let i = 0; i < text.length; i += 7) p.push(text.slice(i, i + 7))
    expect(reports).toEqual([
      { outTimeUs: undefined, frame: 12, fps: 0, speed: undefined, done: false },
      { outTimeUs: 2_500_000, frame: 75, fps: 37.5, speed: 2.41, done: false },
      { outTimeUs: 30_000_000, frame: 900, fps: 41, speed: 2.6, done: true },
    ])
  })

  it('handles CRLF, falls back to out_time_ms and ignores junk lines', () => {
    const reports: FfmpegProgress[] = []
    const p = new ProgressParser((r) => reports.push(r))
    p.push('garbage\r\nout_time_ms=1000\r\n=x\r\nprogress=continue\r\n')
    expect(reports).toEqual([
      { outTimeUs: 1000, frame: undefined, fps: undefined, speed: undefined, done: false },
    ])
  })

  it('treats negative timestamps (pre-roll) as unknown', () => {
    const reports: FfmpegProgress[] = []
    new ProgressParser((r) => reports.push(r)).push('out_time_us=-23219\nprogress=continue\n')
    expect(reports[0]!.outTimeUs).toBeUndefined()
  })
})

describe('summarizeStderr / FfmpegError', () => {
  it('keeps the last non-empty lines', () => {
    const s = 'a\n\n b \nc\r\nd\ne\nf\ng\n'
    expect(summarizeStderr(s)).toBe('b | c | d | e | f | g')
    expect(summarizeStderr('')).toBe('no error output')
    const e = new FfmpegError(1, 'x\nError opening output\n')
    expect(e.message).toBe('ffmpeg failed (exit 1): x | Error opening output')
    expect(e.exitCode).toBe(1)
    expect(new FfmpegError(null, '').message).toContain('exit signal')
  })
})

describe('parseLoudnorm', () => {
  const json = `[Parsed_loudnorm_0 @ 000001]
{
	"input_i" : "-23.54",
	"input_tp" : "-7.12",
	"input_lra" : "5.40",
	"input_thresh" : "-33.80",
	"output_i" : "-14.02",
	"output_tp" : "-1.50",
	"output_lra" : "4.20",
	"output_thresh" : "-24.20",
	"normalization_type" : "dynamic",
	"target_offset" : "0.02"
}
[out#0/null @ 0000] video:0KiB audio:1KiB`

  it('extracts the measurement block', () => {
    expect(parseLoudnorm(`noise {not json}\n${json}`)).toEqual({
      I: -23.54,
      TP: -7.12,
      LRA: 5.4,
      thresh: -33.8,
      offset: 0.02,
    })
  })

  it('rejects silence (-inf), missing and malformed output', () => {
    expect(parseLoudnorm(json.replace('"-23.54"', '"-inf"'))).toBeUndefined()
    expect(parseLoudnorm('no braces here')).toBeUndefined()
    expect(parseLoudnorm('{ "input_i": ')).toBeUndefined()
    expect(parseLoudnorm('{ bad json }')).toBeUndefined()
  })
})

describe.skipIf(!ffmpegAvailable())('runFfmpeg', () => {
  it('resolves with stderr and streams progress', async () => {
    const reports: FfmpegProgress[] = []
    const { stderr } = await runFfmpeg({
      bin: FFMPEG,
      args: [
        '-hide_banner',
        '-progress',
        'pipe:1',
        '-nostats',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=s=128x128:r=30:d=1',
        '-f',
        'null',
        '-',
      ],
      onProgress: (r) => reports.push(r),
    })
    expect(typeof stderr).toBe('string')
    expect(reports.at(-1)).toMatchObject({ done: true, frame: 30 })
  })

  it('rejects with the relevant stderr on failure', async () => {
    const err = await runFfmpeg({
      bin: FFMPEG,
      args: ['-hide_banner', '-i', 'does-not-exist.mp4'],
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(FfmpegError)
    expect((err as FfmpegError).message).toMatch(/does-not-exist/)
  })

  it('kills the process on abort', async () => {
    const ac = new AbortController()
    const started = Date.now()
    const run = runFfmpeg({
      bin: FFMPEG,
      args: ['-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=30', '-f', 'null', '-'],
      signal: ac.signal,
    })
    setTimeout(() => ac.abort(), 200)
    await expect(run).rejects.toBeInstanceOf(FfmpegAbortError)
    expect(Date.now() - started).toBeLessThan(10_000)
    await expect(
      runFfmpeg({ bin: FFMPEG, args: ['-version'], signal: AbortSignal.abort() }),
    ).rejects.toBeInstanceOf(FfmpegAbortError)
  })

  it('rejects when the binary does not exist', async () => {
    await expect(runFfmpeg({ bin: 'definitely-not-ffmpeg-xyz', args: [] })).rejects.toThrow(
      /ENOENT/,
    )
  })
})
