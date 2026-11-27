/**
 * Local language model for the AI assistant (highlights, copywriter, caption emphasis):
 * a pinned llama.cpp `llama-server` build plus one GGUF instruction model, both SHA-256
 * verified, installed into `<data>/bin/llm/` and `<data>/models/llm/`.
 *
 * Choices are benchmarked on the reference host (Ryzen 7 PRO 8840U / Radeon 780M, 16 GB);
 * see apps/server/src/ai/llm/README.md. The Windows/Linux Vulkan builds also contain the
 * CPU backends (AVX2/AVX-512/Zen 4), so one download serves GPU and CPU fallback.
 */
import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { download } from './download.ts'
import type { PinnedFile } from './manifest.ts'

const run = promisify(execFile)

export const LLAMA_CPP_TAG = 'b12588'
const GH = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_TAG}`

export interface LlamaBuild {
  platform: NodeJS.Platform
  arch: string
  asset: string
  sha256: string
  size: number
  backend: 'vulkan' | 'metal' | 'cpu'
}

/** Pinned llama.cpp builds (GitHub release asset digests). */
export const LLAMA_BUILDS: readonly LlamaBuild[] = [
  {
    platform: 'win32',
    arch: 'x64',
    asset: `llama-${LLAMA_CPP_TAG}-bin-win-vulkan-x64.zip`,
    sha256: '77d3b4107c2a5c9747f167a3743092a36e96292e8e1bcca2d46139ddd70ee484',
    size: 38_844_463,
    backend: 'vulkan',
  },
  {
    platform: 'win32',
    arch: 'arm64',
    asset: `llama-${LLAMA_CPP_TAG}-bin-win-vulkan-arm64.zip`,
    sha256: 'df94ad127b492e11199deca2687488631ab70021b4ba3df2d4672121869082c9',
    size: 26_520_879,
    backend: 'vulkan',
  },
  {
    platform: 'linux',
    arch: 'x64',
    asset: `llama-${LLAMA_CPP_TAG}-bin-ubuntu-vulkan-x64.tar.gz`,
    sha256: '090362432bb98f779206dc5b70d745557429f2dd562cb52daa73f95a1231f412',
    size: 36_858_396,
    backend: 'vulkan',
  },
  {
    platform: 'linux',
    arch: 'arm64',
    asset: `llama-${LLAMA_CPP_TAG}-bin-ubuntu-vulkan-arm64.tar.gz`,
    sha256: '6fcec816671e5bb1801b5a0ad934f4fdcd90aa69b67f89d104bd0ca194b3666b',
    size: 29_829_886,
    backend: 'vulkan',
  },
  {
    platform: 'darwin',
    arch: 'arm64',
    asset: `llama-${LLAMA_CPP_TAG}-bin-macos-arm64.tar.gz`,
    sha256: 'bce95d28432c35e600215591c02cc9fdd741e1f6aca2162753d51af92fe52850',
    size: 16_569_192,
    backend: 'metal',
  },
  {
    platform: 'darwin',
    arch: 'x64',
    asset: `llama-${LLAMA_CPP_TAG}-bin-macos-x64.tar.gz`,
    sha256: '4d34aac56ea38af2d5ba2fa8e07af7123532a49a6d132f714ceb7657d1e2f7d7',
    size: 12_351_244,
    backend: 'cpu',
  },
]

export const llamaBuildFor = (platform: NodeJS.Platform, arch: string): LlamaBuild | undefined =>
  LLAMA_BUILDS.find((b) => b.platform === platform && b.arch === arch)

export interface LlmModel extends PinnedFile {
  license: string
  params: string
}

const HF = 'https://huggingface.co'

/**
 * Instruction models (GGUF, Apache-2.0). `id` is what `--llm-model` accepts. Pinned to the
 * repository revision so the URL can never serve different bytes than the hash.
 */
export const LLM_MODELS: readonly LlmModel[] = [
  {
    id: 'qwen3.5-4b',
    url: `${HF}/unsloth/Qwen3.5-4B-GGUF/resolve/e87f176479d0855a907a41277aca2f8ee7a09523/Qwen3.5-4B-Q4_K_M.gguf`,
    sha256: '00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4',
    size: 2_740_937_888,
    dest: 'models/llm/Qwen3.5-4B-Q4_K_M.gguf',
    description: 'Qwen3.5 4B Q4_K_M — best quality per second on the iGPU (default)',
    license: 'Apache-2.0',
    params: '4.2B',
  },
  {
    id: 'qwen3.5-2b',
    url: `${HF}/unsloth/Qwen3.5-2B-GGUF/resolve/f6d5376be1edb4d416d56da11e5397a961aca8ae/Qwen3.5-2B-Q4_K_M.gguf`,
    sha256: 'aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223',
    size: 1_280_835_840,
    dest: 'models/llm/Qwen3.5-2B-Q4_K_M.gguf',
    description: 'Qwen3.5 2B Q4_K_M — 2× faster, weaker copy (low-RAM hosts)',
    license: 'Apache-2.0',
    params: '1.9B',
  },
  {
    id: 'qwen3.5-9b',
    url: `${HF}/unsloth/Qwen3.5-9B-GGUF/resolve/3885219b6810b007914f3a7950a8d1b469d598a5/Qwen3.5-9B-Q4_K_M.gguf`,
    sha256: '03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8',
    size: 5_680_522_464,
    dest: 'models/llm/Qwen3.5-9B-Q4_K_M.gguf',
    description: 'Qwen3.5 9B Q4_K_M — strongest, ~2.5× slower (32 GB+ hosts / dGPU)',
    license: 'Apache-2.0',
    params: '9.0B',
  },
]

export const DEFAULT_LLM_MODEL = 'qwen3.5-4b'

export const LLAMA_SERVER = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'

const findFile = async (dir: string, name: string): Promise<string | undefined> => {
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name === name) return path.join(entry.parentPath, entry.name)
  }
  return undefined
}

const extract = async (archive: string, dest: string): Promise<void> => {
  await mkdir(dest, { recursive: true })
  const tar =
    process.platform === 'win32'
      ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar'
  await run(tar, ['-xf', archive, '-C', dest], { windowsHide: true, maxBuffer: 8 << 20 })
}

export interface InstallLlmOptions {
  dataDir: string
  force: boolean
  signal?: AbortSignal
}

/** Installs the pinned llama.cpp build into `<data>/bin/llm` (idempotent). */
export const installLlamaCpp = async (
  o: InstallLlmOptions,
): Promise<{ status: string; detail: string }> => {
  const build = llamaBuildFor(process.platform, process.arch)
  if (!build)
    return {
      status: 'unsupported',
      detail: `no llama.cpp build for ${process.platform}/${process.arch}`,
    }
  const binDir = path.join(o.dataDir, 'bin', 'llm')
  const stamp = path.join(binDir, 'VERSION.json')
  if (!o.force && existsSync(path.join(binDir, LLAMA_SERVER)) && existsSync(stamp)) {
    const { readFile } = await import('node:fs/promises')
    try {
      const info = JSON.parse(await readFile(stamp, 'utf8')) as { asset?: string }
      if (info.asset === build.asset)
        return { status: 'cached', detail: `${LLAMA_CPP_TAG} (${build.backend})` }
    } catch {
      // Re-install below.
    }
  }
  const archive = path.join(o.dataDir, 'tmp', 'downloads', build.asset)
  await download({
    url: `${GH}/${build.asset}`,
    dest: archive,
    sha256: build.sha256,
    size: build.size,
    label: `llama.cpp ${LLAMA_CPP_TAG} ${build.backend}`,
    force: o.force,
    ...(o.signal ? { signal: o.signal } : {}),
  })
  const staging = path.join(o.dataDir, 'bin', '.llm-staging')
  await rm(staging, { recursive: true, force: true })
  await extract(archive, staging)
  const exe = await findFile(staging, LLAMA_SERVER)
  if (!exe) throw new Error(`${LLAMA_SERVER} not found in ${build.asset}`)
  const exeDir = path.dirname(exe)
  try {
    await run(exe, ['--version'], { cwd: exeDir, windowsHide: true, timeout: 30_000 })
  } catch (err) {
    await rm(staging, { recursive: true, force: true })
    throw new Error(
      `llama-server failed to start${process.platform === 'win32' ? ' — install the VC++ runtime: winget install Microsoft.VCRedist.2015+.x64' : ''}`,
      { cause: err },
    )
  }
  await writeFile(
    path.join(exeDir, 'VERSION.json'),
    `${JSON.stringify({ tag: LLAMA_CPP_TAG, asset: build.asset, sha256: build.sha256, backend: build.backend, installedAt: new Date().toISOString() }, null, 2)}\n`,
  )
  const old = path.join(o.dataDir, 'bin', '.llm-old')
  await rm(old, { recursive: true, force: true })
  if (existsSync(binDir)) await rename(binDir, old)
  try {
    await rename(exeDir, binDir)
  } catch {
    await cp(exeDir, binDir, { recursive: true })
  }
  await rm(old, { recursive: true, force: true })
  await rm(staging, { recursive: true, force: true })
  await rm(archive, { force: true })
  await rm(`${archive}.sha256`, { force: true })
  return { status: 'installed', detail: `${LLAMA_CPP_TAG} (${build.backend}, ${build.asset})` }
}

/** Marks `model` as the active one (read by the server, apps/server/src/ai/llm/runtime.ts). */
export const setActiveModel = async (dataDir: string, model: LlmModel): Promise<void> => {
  const dir = path.join(dataDir, 'models', 'llm')
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'default.json'),
    `${JSON.stringify({ model: path.basename(model.dest) }, null, 2)}\n`,
  )
}
