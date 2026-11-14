/**
 * Render job definitions:
 * - `export`  full-quality render of a project (or `settings.range`) to
 *             `<exports>/<jobId>.mp4` + `<jobId>.jpg` poster;
 * - `preview` fast 540×960 draft render of a time range ("accurate preview") to
 *             `<exports>/<jobId>.mp4`, so the same file route serves it.
 * Both run in the `gpu-encode` resource class.
 */
import { ExportSettings, frameDuration, type Project } from '@reelforge/core'
import type { ExportPayload, JobContext, JobDefinition, PreviewPayload } from '../contracts.ts'
import { exportFile } from '../paths.ts'
import { defaultDeps, renderProject, type RenderDeps, type RenderOutcome } from './pipeline.ts'

export {
  renderProject,
  type RenderDeps,
  type RenderOutcome,
  type RenderRequest,
} from './pipeline.ts'

/** Preview output size (matches the 540p proxies the editor plays). */
export const PREVIEW_SIZE = { width: 540, height: 960 } as const

/** Queue priorities: previews are interactive, exports sit behind proxies. */
export const RENDER_PRIORITY = { preview: 18, export: 40 } as const

function loadProject(ctx: JobContext, projectId: string): Project {
  const project = ctx.store.getProject(projectId)
  if (!project) throw new Error(`project ${projectId} not found`)
  return project
}

/** `<exports>/<jobId>.mp4`: the path the download route and retention cleanup expect. */
const outputFile = (ctx: JobContext): string => exportFile(ctx.paths, ctx.job.id)

/** Export handler (exposed for tests and alternative collaborators). */
export async function runExport(
  ctx: JobContext<ExportPayload>,
  deps: RenderDeps = defaultDeps,
): Promise<RenderOutcome> {
  const project = loadProject(ctx, ctx.payload.projectId)
  const settings = ExportSettings.parse(ctx.payload.settings ?? {})
  return renderProject(ctx, { project, settings, output: outputFile(ctx) }, deps)
}

/** Preview handler: a draft-quality, low-resolution render of [start, end). */
export async function runPreview(
  ctx: JobContext<PreviewPayload>,
  deps: RenderDeps = defaultDeps,
): Promise<{ file: string; duration: number; encoder: string }> {
  const project = loadProject(ctx, ctx.payload.projectId)
  const { start, end } = ctx.payload
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0) {
    throw new Error('preview range must be finite and non-negative')
  }
  // Always render at least one frame.
  const minEnd = Math.round(start + frameDuration(project.settings.fps))
  const settings = ExportSettings.parse({
    quality: 'draft',
    normalizeLoudness: true,
    range: { start: Math.round(start), end: Math.max(minEnd, Math.round(end)) },
  })
  const out = await renderProject(
    ctx,
    { project, settings, output: outputFile(ctx), size: PREVIEW_SIZE, preview: true },
    deps,
  )
  return { file: out.file, duration: out.duration, encoder: out.encoder }
}

export const renderJobs: JobDefinition[] = [
  {
    kind: 'export',
    resource: 'gpu-encode',
    defaultPriority: RENDER_PRIORITY.export,
    handler: (ctx) => runExport(ctx as JobContext<ExportPayload>),
  },
  {
    kind: 'preview',
    resource: 'gpu-encode',
    defaultPriority: RENDER_PRIORITY.preview,
    handler: (ctx) => runPreview(ctx as JobContext<PreviewPayload>),
  },
]
