/**
 * whisper.cpp installer: resolves the latest stable release on GitHub, picks the fastest
 * prebuilt binary for this host, verifies it against GitHub's published SHA-256 digest and
 * installs it atomically into `<data>/bin/whisper/`.
 *
 * Build choice (benchmarked on a Ryzen 7 PRO 8840U / Radeon 780M, see apps/server/src/ai/README.md):
 * upstream publishes no Windows Vulkan binary, so on Windows x64 the plain CPU build
 * (AVX2/AVX-512 ggml kernels) is used — it beat the OpenBLAS build for whisper's
 * small-batch decoder workloads. A Vulkan build is preferred automatically if upstream ever
 * ships one; CUDA is used when an NVIDIA GPU is present.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { download, fetchJson } from './download.ts'

const run = promisify(execFile)

const REPO = 'ggml-org/whisper.cpp'

export interface GhAsset {
  name: string
  size: number
  digest?: string | null
  browser_download_url: string
}
export interface GhRelease {
  tag_name: string
  draft: boolean
  prerelease: boolean
  published_at: string
  body?: string | null
  assets: GhAsset[]
}

export type WhisperBuild = 'cpu' | 'blas' | 'cuda' | 'vulkan'

export interface BuildCandidate {
  build: WhisperBuild
  pattern: RegExp
}

export interface HostInfo {
  platform: NodeJS.Platform
  arch: string
  cpuOnly: boolean
  hasNvidia: boolean
  hasVulkan: boolean
}

/** Ordered preference of release assets for a host (first match wins). */
export const buildCandidates = (host: HostInfo, forced?: WhisperBuild): BuildCandidate[] => {
  const list: BuildCandidate[] = []
  if (host.platform === 'win32' && host.arch === 'x64') {
    if (!host.cpuOnly && host.hasNvidia) {
      list.push({ build: 'cuda', pattern: /^whisper-bin-win-cuda-12[\d.]*-x64\.zip$/ })
      list.push({ build: 'cuda', pattern: /^whisper-cublas-12[\d.]*-bin-x64\.zip$/ })
    }
    if (!host.cpuOnly && host.hasVulkan)
      list.push({ build: 'vulkan', pattern: /^whisper-.*vulkan.*-x64\.zip$/i })
    list.push({ build: 'cpu', pattern: /^whisper-bin-x64\.zip$/ })
    list.push({ build: 'blas', pattern: /^whisper-blas-bin-x64\.zip$/ })
  } else if (host.platform === 'win32' && host.arch === 'arm64') {
    list.push({ build: 'cpu', pattern: /^whisper-bin-win-cpu-arm64\.zip$/ })
  } else if (host.platform === 'linux' && (host.arch === 'x64' || host.arch === 'arm64')) {
    list.push({ build: 'cpu', pattern: new RegExp(`^whisper-bin-ubuntu-${host.arch}\\.tar\\.gz$`) })
  }
  return forced ? list.filter((c) => c.build === forced) : list
}

/** Nightly tag referenced by a stable release body ("**Nightly build:** [b5454](…)"). */
export const nightlyTagFromBody = (body: string | null | undefined): string | undefined =>
  /Nightly build:\**\s*\[(b\d+)\]/i.exec(body ?? '')?.[1]

export interface ResolvedBinary {
  /** Stable version (e.g. v1.9.5) the binary corresponds to. */
  version: string
  /** Release tag that actually hosts the asset (stable or its nightly build). */
  tag: string
  build: WhisperBuild
  asset: GhAsset
  sha256?: string
}

/**
 * Choose the binary: latest stable release; if it carries no binaries, the nightly build it
 * links to; otherwise the newest release that has a matching asset.
 */
export const resolveBinary = (
  releases: GhRelease[],
  candidates: BuildCandidate[],
): ResolvedBinary | undefined => {
  const sorted = releases
    .filter((r) => !r.draft)
    .toSorted((a, b) => b.published_at.localeCompare(a.published_at))
  const stable = sorted.find((r) => !r.prerelease)
  const nightlyTag = nightlyTagFromBody(stable?.body)
  const ordered = [
    ...(stable ? [stable] : []),
    ...sorted.filter((r) => r.tag_name === nightlyTag),
    ...sorted,
  ]
  for (const rel of ordered) {
    for (const c of candidates) {
      const asset = rel.assets.find((a) => c.pattern.test(a.name))
      if (!asset) continue
      const sha = asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : undefined
      return {
        version:
          stable && (rel === stable || rel.tag_name === nightlyTag)
            ? stable.tag_name
            : rel.tag_name,
        tag: rel.tag_name,
        build: c.build,
        asset,
        ...(sha ? { sha256: sha } : {}),
      }
    }
  }
  return undefined
}

export const WHISPER_EXE = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'

const findFile = async (dir: string, name: string): Promise<string | undefined> => {
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name === name) return path.join(entry.parentPath, entry.name)
  }
  return undefined
}

const extract = async (archive: string, dest: string): Promise<void> => {
  await mkdir(dest, { recursive: true })
  // Windows 10+ ships bsdtar, which handles .zip; GNU tar from Git Bash would not.
  const tar =
    process.platform === 'win32'
      ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar'
  await run(tar, ['-xf', archive, '-C', dest], { windowsHide: true, maxBuffer: 8 << 20 })
}

export interface InstalledInfo {
  version: string
  tag: string
  build: WhisperBuild
  asset: string
  sha256?: string
  installedAt: string
}

export const readInstalled = async (binDir: string): Promise<InstalledInfo | undefined> => {
  try {
    const info = JSON.parse(
      await readFile(path.join(binDir, 'VERSION.json'), 'utf8'),
    ) as InstalledInfo
    return existsSync(path.join(binDir, WHISPER_EXE)) ? info : undefined
  } catch {
    return undefined
  }
}

const hasCommand = async (cmd: string, args: string[]): Promise<boolean> => {
  try {
    await run(cmd, args, { windowsHide: true, timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

/** Detect GPU runtimes relevant to whisper.cpp builds. */
export const detectHost = async (cpuOnly: boolean): Promise<HostInfo> => {
  const sys = process.env.SystemRoot ?? 'C:\\Windows'
  return {
    platform: process.platform,
    arch: process.arch,
    cpuOnly,
    hasNvidia: !cpuOnly && (await hasCommand('nvidia-smi', ['-L'])),
    hasVulkan:
      !cpuOnly &&
      (process.platform === 'win32'
        ? existsSync(path.join(sys, 'System32', 'vulkan-1.dll'))
        : existsSync('/usr/lib/x86_64-linux-gnu/libvulkan.so.1') ||
          existsSync('/usr/lib/libvulkan.so.1')),
  }
}

export interface InstallWhisperOptions {
  dataDir: string
  cpuOnly: boolean
  force: boolean
  build?: WhisperBuild
  signal?: AbortSignal
}

export interface InstallWhisperResult {
  status: 'installed' | 'cached' | 'kept-offline' | 'unsupported'
  detail: string
  path?: string
}

/** Install or update whisper.cpp into `<data>/bin/whisper`. */
export const installWhisper = async (
  opts: InstallWhisperOptions,
): Promise<InstallWhisperResult> => {
  const binDir = path.join(opts.dataDir, 'bin', 'whisper')
  const installed = await readInstalled(binDir)
  const host = await detectHost(opts.cpuOnly)
  const candidates = buildCandidates(host, opts.build)
  if (candidates.length === 0) {
    return {
      status: 'unsupported',
      detail:
        host.platform === 'darwin'
          ? 'no prebuilt CLI for macOS — run `brew install whisper-cpp` (Metal-accelerated)'
          : `no prebuilt whisper.cpp for ${host.platform}/${host.arch}${opts.build ? ` (${opts.build})` : ''} — build from source: https://github.com/${REPO}`,
    }
  }

  let resolved: ResolvedBinary | undefined
  try {
    const releases = await fetchJson<GhRelease[]>(
      `https://api.github.com/repos/${REPO}/releases?per_page=30`,
      opts.signal,
    )
    resolved = resolveBinary(releases, candidates)
  } catch (err) {
    if (installed) {
      return {
        status: 'kept-offline',
        detail: `${installed.version} ${installed.build} (release check failed: ${(err as Error).message})`,
        path: path.join(binDir, WHISPER_EXE),
      }
    }
    throw err
  }
  if (!resolved) throw new Error(`no matching whisper.cpp asset found in ${REPO} releases`)

  if (
    !opts.force &&
    installed &&
    installed.tag === resolved.tag &&
    installed.asset === resolved.asset.name &&
    installed.sha256 === resolved.sha256
  ) {
    return {
      status: 'cached',
      detail: `${installed.version} (${installed.build})`,
      path: path.join(binDir, WHISPER_EXE),
    }
  }

  const downloads = path.join(opts.dataDir, 'tmp', 'downloads')
  const archive = path.join(downloads, resolved.asset.name)
  await download({
    url: resolved.asset.browser_download_url,
    dest: archive,
    size: resolved.asset.size,
    label: `whisper.cpp ${resolved.version} ${resolved.build}`,
    force: opts.force,
    ...(resolved.sha256 ? { sha256: resolved.sha256 } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })

  const staging = path.join(opts.dataDir, 'bin', '.whisper-staging')
  await rm(staging, { recursive: true, force: true })
  await extract(archive, staging)
  const exe = await findFile(staging, WHISPER_EXE)
  if (!exe) throw new Error(`${WHISPER_EXE} not found in ${resolved.asset.name}`)
  const exeDir = path.dirname(exe)
  // Smoke test before swapping: catches missing runtime DLLs (e.g. VC++ redistributable).
  try {
    await run(exe, ['--help'], { cwd: exeDir, windowsHide: true, timeout: 30_000 })
  } catch (err) {
    const e = err as { code?: unknown; stderr?: string }
    // whisper-cli prints usage and may exit non-zero; only a spawn/loader failure is fatal.
    if (typeof e.code !== 'number' || !/usage/i.test(e.stderr ?? '')) {
      await rm(staging, { recursive: true, force: true })
      throw new Error(
        `whisper-cli failed to start (${String(e.code)}).` +
          (process.platform === 'win32'
            ? ' Install the VC++ runtime: winget install Microsoft.VCRedist.2015+.x64'
            : ''),
        { cause: err },
      )
    }
  }
  const info: InstalledInfo = {
    version: resolved.version,
    tag: resolved.tag,
    build: resolved.build,
    asset: resolved.asset.name,
    ...(resolved.sha256 ? { sha256: resolved.sha256 } : {}),
    installedAt: new Date().toISOString(),
  }
  await writeFile(path.join(exeDir, 'VERSION.json'), `${JSON.stringify(info, null, 2)}\n`)

  // Atomic-ish swap: old install stays usable until the new one is in place.
  const old = path.join(opts.dataDir, 'bin', '.whisper-old')
  await rm(old, { recursive: true, force: true })
  if (existsSync(binDir)) await rename(binDir, old)
  try {
    await rename(exeDir, binDir)
  } catch {
    // Cross-device or locked: fall back to a copy.
    await cp(exeDir, binDir, { recursive: true })
  }
  await rm(old, { recursive: true, force: true })
  await rm(staging, { recursive: true, force: true })
  await rm(archive, { force: true })
  await rm(`${archive}.sha256`, { force: true })
  return {
    status: 'installed',
    detail: `${resolved.version} (${resolved.build}, ${resolved.asset.name})`,
    path: path.join(binDir, WHISPER_EXE),
  }
}
