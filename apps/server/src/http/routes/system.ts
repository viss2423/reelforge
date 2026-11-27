/** Host/system information for the Settings screen. */
import { statfs } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { llmStatus } from '../../ai/llm/index.ts'
import type { AppDeps } from '../deps.ts'

export const systemRoutes = (app: FastifyInstance, deps: AppDeps): void => {
  app.get('/api/system', async () => {
    const { tools, paths, queue, packs } = deps
    const [disk, tailscale] = await Promise.all([
      statfs(paths.root).then(
        (s) => ({ free: s.bavail * s.bsize, total: s.blocks * s.bsize }),
        () => null,
      ),
      deps.tailscale?.() ?? Promise.resolve(null),
    ])
    const cpus = os.cpus()
    return {
      version: deps.version,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      uptime: Math.round(process.uptime()),
      cpu: { model: cpus[0]?.model.trim() ?? 'unknown', threads: tools.cpuThreads },
      memory: { total: os.totalmem(), free: os.freemem(), rss: process.memoryUsage.rss() },
      disk,
      toolchain: {
        ffmpeg: tools.ffmpeg,
        ffmpegVersion: tools.ffmpegVersion,
        hwEncoders: tools.hwEncoders,
        hwDecode: tools.hwDecode ?? null,
        whisper: tools.whisper ?? null,
        whisperModels: tools.whisperModels.map((m) => path.basename(m)),
        llm: llmStatus(paths),
      },
      jobs: { kinds: queue.kinds, classes: queue.stats() },
      packs: { version: packs.version ?? null, source: packs.snapshot.source },
      urls: deps.urls(),
      tailscale,
    }
  })
}
