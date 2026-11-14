import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  alignmentModel,
  buildCliArgs,
  dtwPreset,
  escapeFilterValue,
  hasWhisperFilter,
  listModels,
  parseCliProgress,
  physicalCores,
  resolveModel,
  whisperCliPath,
  WHISPER_EXE,
  type ModelInfo,
} from '../../src/ai/transcribe/engines.ts'
import { FFMPEG_BIN, makeTempDir, NO_FFMPEG, skipBecause } from './helpers.ts'

const m = (id: string): ModelInfo => ({ id, file: `/models/whisper/ggml-${id}.bin` })

describe('model selection', () => {
  const installed = [m('base'), m('small-q5_1'), m('large-v3-turbo-q5_0'), m('tiny')]

  it('defaults to the most accurate installed model', () => {
    expect(resolveModel(installed).id).toBe('large-v3-turbo-q5_0')
    expect(resolveModel([m('tiny'), m('base')]).id).toBe('base')
    expect(resolveModel([m('custom-finetune')]).id).toBe('custom-finetune')
  })

  it('resolves explicit ids and ggml file names', () => {
    expect(resolveModel(installed, 'base').id).toBe('base')
    expect(resolveModel(installed, 'ggml-small-q5_1.bin').id).toBe('small-q5_1')
  })

  it('explains how to install a missing model', () => {
    expect(() => resolveModel(installed, 'medium')).toThrow(/pnpm bootstrap -- --models medium/)
    expect(() => resolveModel([])).toThrow(/no whisper model installed/)
  })

  it('picks a small DTW timing model for the hybrid backend', () => {
    expect(alignmentModel(installed)?.id).toBe('base')
    expect(alignmentModel([m('tiny'), m('large-v3')])?.id).toBe('tiny')
    expect(alignmentModel([m('large-v3-turbo-q5_0')])).toBeUndefined()
  })
})

describe('dtwPreset', () => {
  it('maps model ids to whisper.cpp alignment-head presets', () => {
    expect(dtwPreset('base')).toBe('base')
    expect(dtwPreset('base.en')).toBe('base.en')
    expect(dtwPreset('base-q5_1')).toBe('base')
    expect(dtwPreset('large-v3-turbo-q5_0')).toBe('large.v3.turbo')
    expect(dtwPreset('large-v3')).toBe('large.v3')
    expect(dtwPreset('small-q5_1')).toBe('small')
    expect(dtwPreset('distil-large-v3')).toBeUndefined()
  })
})

describe('buildCliArgs', () => {
  const base = { model: m('base'), wav: 'a.wav', outBase: 'out', language: 'auto', threads: 8 }

  it('requests full JSON with DTW (flash attention off) and suppresses non-speech', () => {
    const args = buildCliArgs({ ...base, dtw: true })
    expect(args).toEqual(expect.arrayContaining(['-ojf', '-sns', '-pp', '-np']))
    expect(args.join(' ')).toContain('-dtw base -nfa')
    expect(args.join(' ')).toContain('-t 8')
    expect(args.join(' ')).toContain('-l auto')
    expect(args).not.toContain('-bs')
  })

  it('uses greedy decoding for the timing pass and omits DTW for unknown models', () => {
    const args = buildCliArgs({ ...base, model: m('custom'), dtw: true, greedy: true })
    expect(args.join(' ')).toContain('-bs 1 -bo 1')
    expect(args).not.toContain('-dtw')
  })
})

describe('helpers', () => {
  it('parses whisper-cli progress lines', () => {
    expect(parseCliProgress('whisper_print_progress_callback: progress =  45%')).toBe(0.45)
    expect(parseCliProgress('progress = 100%')).toBe(1)
    expect(parseCliProgress('whisper_init_from_file')).toBeUndefined()
  })

  it('escapes filtergraph option values (Windows paths, quotes, separators)', () => {
    expect(escapeFilterValue('C:\\models\\ggml-base.bin')).toBe('C\\\\:/models/ggml-base.bin')
    expect(escapeFilterValue("it's,[a];b")).toBe("it\\\\\\'s\\,\\[a\\]\\;b")
  })

  it('uses physical cores (SMT siblings excluded)', () => {
    expect(physicalCores(16)).toBe(8)
    expect(physicalCores(1)).toBe(1)
  })
})

describe('filesystem discovery', () => {
  let tmp: ReturnType<typeof makeTempDir>
  beforeAll(() => {
    tmp = makeTempDir('engines')
    mkdirSync(path.join(tmp.dir, 'models', 'whisper'), { recursive: true })
    for (const f of ['ggml-base.bin', 'ggml-silero-v5.1.2.bin', 'notes.txt', 'ggml-tiny.bin'])
      writeFileSync(path.join(tmp.dir, 'models', 'whisper', f), '')
    mkdirSync(path.join(tmp.dir, 'bin', 'whisper'), { recursive: true })
    writeFileSync(path.join(tmp.dir, 'bin', 'whisper', WHISPER_EXE), '')
  })
  afterAll(() => tmp.cleanup())

  it('lists installed ggml models, excluding VAD models', async () => {
    const models = await listModels(path.join(tmp.dir, 'models'))
    expect(models.map((x) => x.id).toSorted()).toEqual(['base', 'tiny'])
    expect(await listModels(path.join(tmp.dir, 'nope'))).toEqual([])
  })

  it('prefers the toolchain path and falls back to the bootstrap location', () => {
    const boot = path.join(tmp.dir, 'bin', 'whisper', WHISPER_EXE)
    expect(whisperCliPath(undefined, path.join(tmp.dir, 'bin'))).toBe(boot)
    expect(whisperCliPath(boot, '/nowhere')).toBe(boot)
    expect(whisperCliPath('/missing/whisper-cli', path.join(tmp.dir, 'nope'))).toBeUndefined()
  })
})

describe.skipIf(skipBecause(NO_FFMPEG))('hasWhisperFilter', () => {
  it('detects the whisper filter in this FFmpeg build (and caches the answer)', async () => {
    const a = hasWhisperFilter(FFMPEG_BIN)
    expect(hasWhisperFilter(FFMPEG_BIN)).toBe(a)
    expect(typeof (await a)).toBe('boolean')
    expect(await hasWhisperFilter('definitely-not-ffmpeg-xyz')).toBe(false)
  })
})
