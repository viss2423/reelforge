/**
 * llama.cpp `llama-server` as a lazily started, idle-unloaded child process.
 *
 * - Started on the first request (model load ≈ 2–4 s from a warm disk cache), bound to
 *   127.0.0.1 on a free port and protected by a random API key.
 * - GPU (Vulkan) first; if that instance fails to come up, it retries on the CPU.
 * - Stopped after `idleMs` without requests, on `stop()`, and on server shutdown. A pid file
 *   lets the next run kill an instance orphaned by a crash (Windows does not kill children
 *   with their parent).
 */
import { spawn, type ChildProcess, execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Logger } from '../../contracts.ts'
import { llamaServerArgs, type LlmInstall } from './runtime.ts'

const execFileP = promisify(execFile)

/** Default idle time before the model is unloaded (frees ~3 GB of shared memory). */
export const DEFAULT_IDLE_MS = 5 * 60_000
const READY_TIMEOUT_MS = 180_000

export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })

const killTree = (child: ChildProcess): void => {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    }).on('error', () => child.kill())
  } else child.kill('SIGKILL')
}

/** Kills a llama-server left behind by a crashed previous run (only if it IS llama-server). */
export const killOrphan = async (pidFile: string): Promise<void> => {
  let pid: number
  try {
    pid = Number(readFileSync(pidFile, 'utf8').trim())
  } catch {
    return
  }
  rmSync(pidFile, { force: true })
  if (!Number.isInteger(pid) || pid <= 0) return
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileP(
        'tasklist',
        ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
        {
          windowsHide: true,
        },
      )
      if (!/llama-server/i.test(stdout)) return
      await execFileP('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true })
    } else {
      const comm = readFileSync(`/proc/${pid}/comm`, 'utf8')
      if (/llama-server/.test(comm)) process.kill(pid, 'SIGKILL')
    }
  } catch {
    // Already gone, or not ours.
  }
}

export interface LlamaServerOptions {
  install: LlmInstall
  /** Directory for the pid file. */
  runDir: string
  threads: number
  ctx?: number
  idleMs?: number
  log?: Logger
  /** Injected for tests. */
  spawnServer?: (exe: string, args: string[]) => ChildProcess
  /** Kills a child (default: the whole process tree). */
  killServer?: (child: ChildProcess) => void
  fetchImpl?: typeof fetch
}

export interface LlamaEndpoint {
  url: string
  apiKey: string
  backend: 'vulkan' | 'cpu'
  /** Model load time of this instance (ms). */
  loadMs: number
}

export class LlamaServer {
  private readonly o: LlamaServerOptions
  private child: ChildProcess | undefined
  private starting: Promise<LlamaEndpoint> | undefined
  private endpoint: LlamaEndpoint | undefined
  private idleTimer: NodeJS.Timeout | undefined
  private busy = 0
  private gpuFailed = false
  private orphanChecked = false

  constructor(o: LlamaServerOptions) {
    this.o = o
  }

  private kill(child: ChildProcess): void {
    ;(this.o.killServer ?? killTree)(child)
  }

  get loaded(): boolean {
    return this.endpoint !== undefined
  }

  get backend(): 'vulkan' | 'cpu' | undefined {
    return this.endpoint?.backend
  }

  private get pidFile(): string {
    return path.join(this.o.runDir, 'llama-server.pid')
  }

  /** Marks a request as running (no idle unload until `release`). Starts the server if needed. */
  async acquire(signal?: AbortSignal): Promise<LlamaEndpoint> {
    this.busy++
    clearTimeout(this.idleTimer)
    try {
      return await this.ensure(signal)
    } catch (err) {
      this.release()
      throw err
    }
  }

  release(): void {
    this.busy = Math.max(0, this.busy - 1)
    if (this.busy > 0 || !this.endpoint) return
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => void this.stop(), this.o.idleMs ?? DEFAULT_IDLE_MS)
    this.idleTimer.unref()
  }

  private ensure(signal?: AbortSignal): Promise<LlamaEndpoint> {
    if (this.endpoint && this.child?.exitCode === null) return Promise.resolve(this.endpoint)
    this.starting ??= this.start(signal).finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  private async start(signal?: AbortSignal): Promise<LlamaEndpoint> {
    if (!this.orphanChecked) {
      this.orphanChecked = true
      await killOrphan(this.pidFile)
    }
    const wantGpu = this.o.install.device !== 'cpu' && !this.gpuFailed
    try {
      return await this.launch(wantGpu, signal)
    } catch (err) {
      if (!wantGpu || this.o.install.device === 'gpu' || signal?.aborted) throw err
      this.o.log?.warn({ err }, 'llama-server failed on the GPU; falling back to the CPU')
      this.gpuFailed = true
      return this.launch(false, signal)
    }
  }

  private async launch(gpu: boolean, signal?: AbortSignal): Promise<LlamaEndpoint> {
    const port = await freePort()
    const apiKey = randomBytes(18).toString('base64url')
    const args = llamaServerArgs({
      model: this.o.install.model,
      port,
      apiKey,
      gpu,
      threads: this.o.threads,
      ctx: this.o.ctx ?? 8192,
    })
    const started = performance.now()
    const child = this.o.spawnServer
      ? this.o.spawnServer(this.o.install.server, args)
      : spawn(this.o.install.server, args, {
          cwd: path.dirname(this.o.install.server),
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe'],
        })
    this.child = child
    const tail: string[] = []
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (s: string) => {
      for (const line of s.split(/\r?\n/)) {
        if (!line) continue
        tail.push(line)
        if (tail.length > 30) tail.shift()
      }
    })
    let exited = false
    child.once('exit', () => {
      exited = true
      if (this.child === child) {
        this.child = undefined
        this.endpoint = undefined
        rmSync(this.pidFile, { force: true })
      }
    })
    if (child.pid !== undefined) {
      mkdirSync(this.o.runDir, { recursive: true })
      writeFileSync(this.pidFile, String(child.pid))
    }
    const url = `http://127.0.0.1:${port}`
    const fetchImpl = this.o.fetchImpl ?? fetch
    const deadline = Date.now() + READY_TIMEOUT_MS
    const fail = (why: string): Error => {
      this.kill(child)
      const detail = tail.filter((l) => /error|fail|unable|out of memory/i.test(l)).slice(-4)
      return new Error(`llama-server ${why}${detail.length ? `:\n${detail.join('\n')}` : ''}`)
    }
    for (;;) {
      if (signal?.aborted) {
        this.kill(child)
        throw signal.reason instanceof Error ? signal.reason : new Error('cancelled')
      }
      if (exited) throw fail(`exited during model load (${gpu ? 'GPU' : 'CPU'})`)
      if (Date.now() > deadline) throw fail('did not become ready in time')
      try {
        const res = await fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(2000) })
        if (res.ok) break
      } catch {
        // Not listening yet.
      }
      await new Promise((r) => setTimeout(r, 150))
    }
    const endpoint: LlamaEndpoint = {
      url,
      apiKey,
      backend: gpu ? 'vulkan' : 'cpu',
      loadMs: Math.round(performance.now() - started),
    }
    this.endpoint = endpoint
    this.o.log?.info(
      {
        model: path.basename(this.o.install.model),
        backend: endpoint.backend,
        ms: endpoint.loadMs,
      },
      'LLM loaded',
    )
    return endpoint
  }

  /** Stops the server now (frees the model). Safe to call at any time. */
  async stop(): Promise<void> {
    clearTimeout(this.idleTimer)
    const child = this.child
    this.child = undefined
    this.endpoint = undefined
    if (!child) return
    const done = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve()
      else child.once('exit', () => resolve())
    })
    this.kill(child)
    await Promise.race([done, new Promise((r) => setTimeout(r, 5000))])
    rmSync(this.pidFile, { force: true })
    this.o.log?.info({}, 'LLM unloaded')
  }
}
