/**
 * End-to-end transcription: speech synthesised with Windows SAPI (System.Speech), whose
 * SpeakProgress events give ground-truth word onsets, run through the real `transcribe` job
 * (FFmpeg decode + whisper.cpp). Gated on Windows, FFmpeg, whisper-cli and the models
 * installed by `pnpm bootstrap`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import type { Word } from '@reelforge/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WHISPER_EXE } from '../../src/ai/transcribe/engines.ts'
import { transcribeJob, type TranscribeResult } from '../../src/ai/transcribe/index.ts'
import { normalizeWord } from '../../src/ai/transcribe/words.ts'
import {
  addAssetFile,
  DATA_DIR,
  makeAsset,
  makeContext,
  makePaths,
  makeTempDir,
  MemoryStore,
  NO_FFMPEG,
  skipBecause,
} from './helpers.ts'

const WHISPER = path.join(DATA_DIR, 'bin', 'whisper', WHISPER_EXE)
const model = (id: string): string => path.join(DATA_DIR, 'models', 'whisper', `ggml-${id}.bin`)

const skipReason =
  (process.platform !== 'win32' && 'speech synthesis uses Windows SAPI — Windows only') ||
  NO_FFMPEG ||
  (!existsSync(WHISPER) && `whisper-cli not installed at ${WHISPER} — run \`pnpm bootstrap\``) ||
  (!existsSync(model('base')) && 'whisper model "base" missing — run `pnpm bootstrap`')

const TEXT =
  'The quick brown fox jumps over the lazy dog. ' +
  'Yesterday we sold twenty five thousand copies of the new album! ' +
  'Please remember to subscribe for more videos about cameras and editing.'

interface Mark {
  /** Onset in us. */
  t: number
  w: string
}

/** Speak `text` into a 16-bit WAV with SAPI; returns the word onsets SAPI reported. */
const synthesize = (text: string, out: string): Mark[] => {
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    '$s.Rate = 0',
    '$marks = New-Object System.Collections.ArrayList',
    '$s.add_SpeakProgress({ param($o, $e) [void]$marks.Add(@{ t = $e.AudioPosition.TotalMilliseconds; w = $e.Text }) })',
    // SAPI computes AudioPosition as if the output were 16 kHz: write exactly that format,
    // otherwise (default 22.05 kHz) the reported onsets run ~38 % late.
    '$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)',
    '$s.SetOutputToWaveFile($env:RF_TTS_OUT, $fmt)',
    '$s.Speak($env:RF_TTS_TEXT)',
    '$s.Dispose()',
    'ConvertTo-Json -Compress -InputObject $marks.ToArray()',
  ].join('; ')
  const json = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      env: { ...process.env, RF_TTS_TEXT: text, RF_TTS_OUT: out },
      encoding: 'utf8',
      windowsHide: true,
    },
  )
  return (JSON.parse(json) as Array<{ t: number; w: string }>).map((m) => ({
    t: Math.round(m.t * 1000),
    w: m.w,
  }))
}

/** Mean absolute onset error over words recognised verbatim (in order). */
const onsetError = (
  words: readonly Word[],
  marks: readonly Mark[],
): { mae: number; matched: number } => {
  let j = 0
  let sum = 0
  let matched = 0
  for (const w of words) {
    const n = normalizeWord(w.text)
    for (let k = j; k < Math.min(marks.length, j + 4); k++) {
      if (normalizeWord(marks[k]?.w ?? '') === n) {
        sum += Math.abs(w.start - (marks[k]?.t ?? 0))
        matched++
        j = k + 1
        break
      }
    }
  }
  return { mae: matched ? sum / matched : Infinity, matched }
}

describe.skipIf(skipBecause(skipReason))('transcribe job (SAPI speech → whisper.cpp)', () => {
  const tmp = makeTempDir('transcribe')
  const paths = makePaths(tmp.dir)
  const store = new MemoryStore()
  let marks: Mark[] = []
  let durationUs = 0

  beforeAll(() => {
    const wav = path.join(tmp.dir, 'speech.wav')
    marks = synthesize(TEXT, wav)
    const last = marks.at(-1)
    durationUs = (last?.t ?? 0) + 1_500_000
    addAssetFile(
      paths,
      store,
      makeAsset('speech', 'speech.wav', { kind: 'audio', hasVideo: false, duration: durationUs }),
      wav,
    )
  })
  afterAll(() => tmp.cleanup())

  const transcribe = async (payload: Record<string, unknown>): Promise<TranscribeResult> => {
    const ctx = makeContext('transcribe', { assetId: 'speech', ...payload }, paths, store)
    const r = (await transcribeJob.handler(ctx)) as TranscribeResult
    // Cached on the asset and broadcast.
    expect(store.getAsset('speech')?.transcript).toEqual(r.words)
    expect(ctx.events.some((e) => e.type === 'asset')).toBe(true)
    // Progress is monotonic and completes.
    const ps = ctx.progressLog.map((p) => p.p)
    expect(ps.every((p, i) => i === 0 || p >= (ps[i - 1] ?? 0))).toBe(true)
    expect(ps.at(-1)).toBe(1)
    return r
  }

  const expectWellFormed = (r: TranscribeResult): void => {
    const text = r.words.map((w) => normalizeWord(w.text)).join(' ')
    for (const w of [
      'quick',
      'brown',
      'fox',
      'jumps',
      'lazy',
      'dog',
      'subscribe',
      'cameras',
      'editing',
    ]) {
      expect(text).toContain(w)
    }
    let prevEnd = 0
    for (const w of r.words) {
      expect(Number.isInteger(w.start) && Number.isInteger(w.end)).toBe(true)
      expect(w.start).toBeGreaterThanOrEqual(prevEnd)
      expect(w.end).toBeGreaterThan(w.start)
      expect(w.end).toBeLessThanOrEqual(durationUs)
      expect(w.confidence).toBeGreaterThanOrEqual(0)
      expect(w.confidence).toBeLessThanOrEqual(1)
      prevEnd = w.end
    }
    // "twenty five thousand" / "25,000" and the exclamation are emphasised.
    expect(r.words.some((w) => w.emphasis && /\d|thousand|album/i.test(w.text))).toBe(true)
    expect(r.language).toBe('en')
  }

  it(
    'fast model (whisper-cli, DTW timing): accurate words and onsets',
    { timeout: 120_000 },
    async () => {
      const r = await transcribe({ model: 'base', backend: 'cli' })
      expect(r.backend).toBe('cli')
      expectWellFormed(r)
      const { mae, matched } = onsetError(r.words, marks)
      console.warn(
        `[bench] transcribe base/cli: RTF ${r.realtimeFactor}, onset MAE ${(mae / 1000).toFixed(0)} ms over ${matched} words`,
      )
      expect(matched).toBeGreaterThanOrEqual(18)
      expect(mae).toBeLessThan(80_000)
    },
  )

  it.skipIf(
    skipBecause(
      !existsSync(model('large-v3-turbo-q5_0')) &&
        'large-v3-turbo-q5_0 missing — run `pnpm bootstrap`',
    ),
  )('default model (auto backend): accurate words and onsets', { timeout: 300_000 }, async () => {
    const r = await transcribe({})
    expect(r.model).toBe('large-v3-turbo-q5_0')
    expectWellFormed(r)
    const { mae, matched } = onsetError(r.words, marks)
    console.warn(
      `[bench] transcribe ${r.model}/${r.backend}: RTF ${r.realtimeFactor}, onset MAE ${(mae / 1000).toFixed(0)} ms over ${matched} words`,
    )
    expect(matched).toBeGreaterThanOrEqual(18)
    expect(mae).toBeLessThan(80_000)
  })

  it(
    'honours cancellation (kills whisper) and cleans its temp dir',
    { timeout: 60_000 },
    async () => {
      const ac = new AbortController()
      const ctx = makeContext(
        'transcribe',
        { assetId: 'speech', model: 'base', backend: 'cli' },
        paths,
        store,
        {},
        ac.signal,
      )
      const p = transcribeJob.handler(ctx)
      setTimeout(() => ac.abort(), 300)
      await expect(p).rejects.toThrow(/cancel/i)
      expect(existsSync(paths.tmp) ? readdirSync(paths.tmp) : []).toEqual([])
    },
  )

  it('reports actionable errors', async () => {
    const ctx = makeContext('transcribe', { assetId: 'speech', model: 'medium-nope' }, paths, store)
    await expect(transcribeJob.handler(ctx)).rejects.toThrow(/not installed.*pnpm bootstrap/)
    const bad = makeContext('transcribe', { assetId: '../etc' }, paths, store)
    await expect(transcribeJob.handler(bad)).rejects.toThrow(/invalid payload/)
  })
})
