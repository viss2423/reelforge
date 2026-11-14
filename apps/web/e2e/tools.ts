/**
 * Gives the server under test the local AI toolchain (whisper.cpp + models) without
 * touching the run's fresh data dir semantics: when `RF_E2E_TOOLS_DATA` points at a data dir
 * that `pnpm bootstrap` has populated, its `bin/` and `models/` trees are hard-linked into
 * the run's REELFORGE_DATA.
 *
 * Hard links (not junctions/symlinks) so the teardown's recursive delete can never reach the
 * source files, and no copy of the ~1 GB of models is made. It must run synchronously while
 * the Playwright config is evaluated: the server detects its toolchain at boot, and the
 * web server starts before global setup.
 */
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { E2E_DATA } from './env.ts'

/** Bootstrapped data dir to borrow whisper.cpp and models from (unset → AI specs skip). */
export const TOOLS_DATA = process.env.RF_E2E_TOOLS_DATA || undefined

const WHISPER_EXE = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'

/** Why the real-AI specs can't run, or undefined when whisper.cpp and a model are present. */
export const aiUnavailable = (): string | undefined => {
  if (!TOOLS_DATA)
    return 'RF_E2E_TOOLS_DATA is not set (point it at a data dir populated by `pnpm bootstrap`)'
  if (!existsSync(path.join(TOOLS_DATA, 'bin', 'whisper', WHISPER_EXE)))
    return `whisper-cli missing under ${TOOLS_DATA} — run \`pnpm bootstrap\``
  const models = path.join(TOOLS_DATA, 'models', 'whisper')
  if (!existsSync(models) || !readdirSync(models).some((f) => f.endsWith('.bin')))
    return `no whisper model under ${models} — run \`pnpm bootstrap\``
  return undefined
}

const linkTree = (from: string, to: string): void => {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dest = path.join(to, entry.name)
    if (entry.isDirectory()) linkTree(src, dest)
    else if (entry.isFile() && !existsSync(dest)) {
      try {
        linkSync(src, dest)
      } catch {
        // Different volume (EXDEV) or a filesystem without hard links: copy instead.
        copyFileSync(src, dest)
      }
    }
  }
}

/** Links the toolchain into the run's data dir (idempotent; once per run). */
export const linkTools = (): void => {
  if (!TOOLS_DATA || aiUnavailable()) return
  for (const dir of ['bin', 'models']) {
    const src = path.join(TOOLS_DATA, dir)
    if (existsSync(src) && statSync(src).isDirectory()) linkTree(src, path.join(E2E_DATA, dir))
  }
}
