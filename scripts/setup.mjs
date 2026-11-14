#!/usr/bin/env node
/**
 * ReelForge bootstrap (`pnpm bootstrap`): checks prerequisites and installs the local AI
 * toolchain into the data dir (REELFORGE_DATA, default ~/.reelforge):
 *
 *   bin/whisper/whisper-cli(.exe)        whisper.cpp, fastest prebuilt build for this host
 *   models/whisper/ggml-*.bin            speech-to-text models (--models)
 *   models/face/yunet.onnx               face detector for auto-reframe
 *   models/rnnoise/sh.rnnn               voice denoiser for FFmpeg arnndn
 *
 * Idempotent and resumable: re-running skips verified files and resumes partial downloads.
 * Every download is SHA-256 verified.
 */
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { checkFfmpeg, checkNode } from './lib/checks.ts'
import { download } from './lib/download.ts'
import {
  DEFAULT_WHISPER_MODELS,
  FACE_MODEL,
  RNNOISE_MODEL,
  WHISPER_MODELS,
} from './lib/manifest.ts'
import { formatBytes, formatTable } from './lib/progress.ts'
import { installWhisper } from './lib/whisper.ts'

const HELP = `Usage: pnpm bootstrap [-- options]

Options:
  --models <list>        Comma-separated whisper models (default: ${DEFAULT_WHISPER_MODELS.join(',')})
                         Available: ${WHISPER_MODELS.map((m) => m.id).join(', ')}
  --skip-models          Do not download any models
  --force                Re-download everything, ignoring verified local copies
  --cpu-only             Never pick a GPU build of whisper.cpp
  --whisper-build <b>    Force a whisper.cpp build: cpu | blas | cuda | vulkan
  --data <dir>           Data directory (default: $REELFORGE_DATA or ~/.reelforge)
  -h, --help             Show this help
`

const { values: args } = parseArgs({
  options: {
    models: { type: 'string' },
    'skip-models': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    'cpu-only': { type: 'boolean', default: false },
    'whisper-build': { type: 'string' },
    data: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
})

if (args.help) {
  process.stdout.write(HELP)
  process.exit(0)
}

const dataDir = path.resolve(
  args.data ?? process.env.REELFORGE_DATA ?? path.join(os.homedir(), '.reelforge'),
)
const BUILDS = ['cpu', 'blas', 'cuda', 'vulkan']
if (args['whisper-build'] && !BUILDS.includes(args['whisper-build'])) {
  process.stderr.write(`--whisper-build must be one of ${BUILDS.join(', ')}\n`)
  process.exit(2)
}

const modelIds = args.models
  ? args.models
      .split(',')
      .map((s) =>
        s
          .trim()
          .replace(/^ggml-/, '')
          .replace(/\.bin$/, ''),
      )
      .filter(Boolean)
  : [...DEFAULT_WHISPER_MODELS]
const unknown = modelIds.filter((id) => !WHISPER_MODELS.some((m) => m.id === id))
if (unknown.length) {
  process.stderr.write(
    `Unknown model(s): ${unknown.join(', ')}\nAvailable: ${WHISPER_MODELS.map((m) => m.id).join(', ')}\n`,
  )
  process.exit(2)
}

/** @type {Array<{ item: string, status: string, detail: string, ok: boolean, required: boolean }>} */
const summary = []
const controller = new AbortController()
process.once('SIGINT', () => controller.abort(new Error('interrupted — re-run to resume')))

const log = (msg) => process.stderr.write(`${msg}\n`)

log(`ReelForge setup → ${dataDir}\n`)

// 1. Prerequisites
const node = checkNode()
const ffmpegChecks = await checkFfmpeg()
for (const c of [node, ...ffmpegChecks]) {
  summary.push({
    item: c.name,
    status: c.ok ? 'ok' : c.required ? 'MISSING' : 'warn',
    detail: c.detail,
    ok: c.ok,
    required: c.required,
  })
  if (!c.ok && c.fix) log(`! ${c.name}: ${c.detail}\n  fix: ${c.fix}`)
}

/** Run one install step, recording the outcome without aborting the remaining steps. */
const step = async (item, required, fn) => {
  try {
    const { status, detail } = await fn()
    summary.push({ item, status, detail, ok: status !== 'unsupported', required })
  } catch (err) {
    if (controller.signal.aborted) throw err
    log(`! ${item}: ${err instanceof Error ? err.message : String(err)}`)
    summary.push({
      item,
      status: 'FAILED',
      detail: err instanceof Error ? err.message : String(err),
      ok: false,
      required,
    })
  }
}

const fetchPinned = (file) => async () => {
  const r = await download({
    url: file.url,
    dest: path.join(dataDir, file.dest),
    sha256: file.sha256,
    size: file.size,
    label: file.id,
    force: args.force,
    signal: controller.signal,
  })
  return { status: r.status, detail: `${formatBytes(r.size)}  sha256 ${r.sha256.slice(0, 12)}…` }
}

try {
  // 2. whisper.cpp
  await step('whisper.cpp', true, () =>
    installWhisper({
      dataDir,
      cpuOnly: args['cpu-only'],
      force: args.force,
      signal: controller.signal,
      ...(args['whisper-build'] ? { build: args['whisper-build'] } : {}),
    }),
  )

  // 3. Models
  if (args['skip-models']) {
    summary.push({
      item: 'models',
      status: 'skipped',
      detail: '--skip-models',
      ok: true,
      required: false,
    })
  } else {
    for (const id of modelIds) {
      const model = WHISPER_MODELS.find((m) => m.id === id)
      if (model) await step(`whisper model ${id}`, id === modelIds[0], fetchPinned(model))
    }
    await step('face model (YuNet)', false, fetchPinned(FACE_MODEL))
    await step('RNNoise model', false, fetchPinned(RNNOISE_MODEL))
  }
} catch (err) {
  log(`\nAborted: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 130
}

log(
  `\n${formatTable(
    ['Component', 'Status', 'Details'],
    summary.map((s) => [s.item, s.status, s.detail]),
  )}\n`,
)

const failedRequired = summary.filter((s) => !s.ok && s.required)
if (failedRequired.length) {
  log(
    `Setup incomplete: ${failedRequired.map((s) => s.item).join(', ')}. Fix the items above and re-run \`pnpm bootstrap\`.`,
  )
  process.exitCode ||= 1
} else if (!process.exitCode) {
  const warnings = summary.filter((s) => !s.ok)
  log(
    warnings.length
      ? `Setup complete with warnings (${warnings.map((s) => s.item).join(', ')}): related features stay disabled until fixed.`
      : 'Setup complete. Start ReelForge with `pnpm start`.',
  )
}
