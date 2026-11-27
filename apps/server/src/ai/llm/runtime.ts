/**
 * Where the LLM runtime and models live (installed by `pnpm bootstrap`, scripts/lib/llm.ts):
 *
 *   <data>/bin/llm/llama-server(.exe)    llama.cpp server (Vulkan build on Windows/Linux)
 *   <data>/models/llm/<file>.gguf        instruction model(s)
 *   <data>/models/llm/default.json       `{ "model": "<file>.gguf" }` — the active model
 *
 * `REELFORGE_LLM_MODEL` (file name or absolute path) overrides the active model and
 * `REELFORGE_LLM_DEVICE=cpu` forces CPU inference.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type { DataPaths } from '../../contracts.ts'

export const LLAMA_SERVER_EXE = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'

/** Preference when no default.json names a model (best measured trade-off first). */
export const MODEL_PREFERENCE = [/qwen3\.5-4b/i, /gemma-4-e4b/i, /qwen3\.5-9b/i, /qwen3\.5-2b/i]

export type LlmDevice = 'auto' | 'gpu' | 'cpu'

export interface LlmInstall {
  server: string
  model: string
  device: LlmDevice
}

export const llmBinDir = (paths: Pick<DataPaths, 'bin'>): string => path.join(paths.bin, 'llm')
export const llmModelDir = (paths: Pick<DataPaths, 'models'>): string =>
  path.join(paths.models, 'llm')

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** Picks the model file: env override → default.json → preference order → largest-first. */
export const pickModel = (
  files: readonly string[],
  configured?: string,
  envOverride?: string,
): string | undefined => {
  const ggufs = files.filter((f) => f.toLowerCase().endsWith('.gguf') && !/^mmproj/i.test(f))
  for (const want of [envOverride, configured]) {
    if (want && ggufs.includes(want)) return want
  }
  for (const re of MODEL_PREFERENCE) {
    const hit = ggufs.find((f) => re.test(f))
    if (hit) return hit
  }
  return ggufs.toSorted()[0]
}

const readConfigured = (dir: string): string | undefined => {
  try {
    const j = JSON.parse(readFileSync(path.join(dir, 'default.json'), 'utf8')) as {
      model?: unknown
    }
    return typeof j.model === 'string' ? j.model : undefined
  } catch {
    return undefined
  }
}

/** Resolves the installed runtime + model, or undefined when either is missing. */
export const findLlmInstall = (
  paths: Pick<DataPaths, 'bin' | 'models'>,
  env: NodeJS.ProcessEnv = process.env,
): LlmInstall | undefined => {
  const server = path.join(llmBinDir(paths), LLAMA_SERVER_EXE)
  if (!isFile(server)) return undefined
  const device: LlmDevice =
    env.REELFORGE_LLM_DEVICE === 'cpu' || env.REELFORGE_LLM_DEVICE === 'gpu'
      ? env.REELFORGE_LLM_DEVICE
      : 'auto'
  const override = env.REELFORGE_LLM_MODEL
  if (override && path.isAbsolute(override) && isFile(override))
    return { server, model: override, device }
  const dir = llmModelDir(paths)
  if (!existsSync(dir)) return undefined
  const file = pickModel(readdirSync(dir), readConfigured(dir), override)
  return file ? { server, model: path.join(dir, file), device } : undefined
}

/** Physical cores (generation is memory bound; SMT siblings only add contention). */
export const generationThreads = (logical: number): number => Math.max(1, Math.floor(logical / 2))

export interface ServerArgsOptions {
  model: string
  port: number
  apiKey: string
  gpu: boolean
  threads: number
  ctx: number
}

/** llama-server argv for one single-slot, loopback-only, reasoning-off instance. */
export const llamaServerArgs = (o: ServerArgsOptions): string[] => [
  '--model',
  o.model,
  '--host',
  '127.0.0.1',
  '--port',
  String(o.port),
  '--api-key',
  o.apiKey,
  '--ctx-size',
  String(o.ctx),
  '--parallel',
  '1',
  '--threads',
  String(o.threads),
  // Structured editing tasks gain nothing from hidden chain-of-thought; it only costs time.
  '--reasoning',
  'off',
  '--no-webui',
  '--cache-ram',
  '0',
  ...(o.gpu
    ? ['--n-gpu-layers', '999', '--flash-attn', 'auto']
    : ['--n-gpu-layers', '0', '--device', 'none']),
]
