/**
 * Easing + keyframe evaluation shared by the web preview and the export compiler.
 * STUB — implemented by the core-engine builder. Signatures are the contract.
 */
import type { Animatable, Easing, Keyframe } from './schema.ts'
import type { AnimationPreset } from './packs.ts'

const notImplemented = (name: string): never => {
  throw new Error(`@reelforge/core: ${name} not implemented yet`)
}

/** Map progress 0..1 through an easing curve. */
export function ease(easing: Easing, p: number): number {
  void easing
  void p
  return notImplemented('ease')
}

/** Value of a keyframe list at time t (clip-relative us). Before first/after last → hold. */
export function evaluateKeyframes(
  keyframes: readonly Keyframe[],
  t: number,
  fallback: number,
): number {
  void keyframes
  void t
  void fallback
  return notImplemented('evaluateKeyframes')
}

/** Value of an Animatable at clip-relative time t. */
export function evaluate(a: Animatable, t: number): number {
  void a
  void t
  return notImplemented('evaluate')
}

export interface AnimatedProps {
  opacity: number
  scale: number
  /** px offset */
  x: number
  /** px offset */
  y: number
  /** degrees */
  rotation: number
}

/** Evaluate a pack animation at normalised progress p (0..1). Missing tracks → identity. */
export function evaluatePreset(preset: AnimationPreset, p: number): AnimatedProps {
  void preset
  void p
  return notImplemented('evaluatePreset')
}
