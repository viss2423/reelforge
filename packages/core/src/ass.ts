/**
 * Generates an Advanced SubStation Alpha (.ass) document for all text clips and captions.
 * Rendered by libass in BOTH places: FFmpeg `ass` filter (export) and JASSUB (web preview).
 * STUB — implemented by the core-engine builder.
 */
import type { Project } from './schema.ts'
import type { AnimationPreset } from './packs.ts'

export interface AssContext {
  /** Resolve `<packId>/<animationId>` (or `builtin/<id>`) to an animation preset. */
  resolveAnimation(ref: string): AnimationPreset | undefined
  /** Optional time window (timeline us); events outside are omitted. */
  range?: { start: number; end: number }
}

export function buildAss(project: Project, ctx: AssContext): string {
  void ctx
  throw new Error(`@reelforge/core: buildAss(${project.id}) not implemented yet`)
}
