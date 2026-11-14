/**
 * Clip effects (pack `EffectPreset`s) evaluated on the CPU once per layer per frame.
 *
 * Every effect is a closed-form function of the time since the effect window started, so the
 * same expressions can be written as FFmpeg filter expressions (`crop`/`overlay` x/y, `zoompan`
 * z, `geq`, `eq` with `eval=frame`) by the render compiler. The formulas below are the
 * reference for both renderers; see README "Effects" for the parameter table.
 *
 * Output is written into a caller-owned {@link EffectState} so the per-frame path never
 * allocates.
 */
import type { EffectPreset, EffectRef } from '@reelforge/core'

/** Default parameters per effect (overridable by the preset's `params`). */
export const EFFECT_DEFAULTS = {
  /** px amplitude in canvas space, Hz */
  shake: { amplitude: 24, frequency: 12 },
  /** relative scale amount, Hz */
  zoomPulse: { amount: 0.08, frequency: 2 },
  /** canvas px horizontal channel offset */
  rgbSplit: { amount: 12 },
  /** seconds to fade from white */
  flash: { fade: 0.3 },
  /** seconds to sharpen, Gaussian sigma (canvas px) at the start */
  blurIn: { duration: 0.5, sigma: 30 },
  /** channel offset px, scanline darkness, noise amplitude, desaturation */
  vhs: { offset: 4, scanlines: 0.15, noise: 0.08, desaturate: 0.25 },
  /** blur sigma (canvas px), additive strength */
  glow: { sigma: 12, strength: 0.6 },
  /** beats per minute, scale amount, exponential decay per second */
  beatZoom: { bpm: 120, amount: 0.1, decay: 8 },
  /** flashes per second, white mix while "on" */
  strobe: { frequency: 8, mix: 0.7 },
  /** luma noise amplitude 0..1 */
  filmGrain: { amount: 0.12 },
} as const satisfies Record<EffectPreset['effect'], Record<string, number>>

export type EffectKind = EffectPreset['effect']

/** Accumulated effect outputs for one layer at one instant. */
export interface EffectState {
  /** Canvas-px translation. */
  dx: number
  dy: number
  /** Multiplicative scale. */
  scale: number
  /** Horizontal RGB split in canvas px (red right, blue left). */
  rgbSplit: number
  /** White mix 0..1 (flash + strobe). */
  white: number
  /** Gaussian sigma in canvas px (blurIn). */
  blur: number
  /** Glow: sigma (canvas px) and strength. */
  glowSigma: number
  glowStrength: number
  /** VHS: scanline darkness, noise amplitude, desaturation. */
  scanlines: number
  noise: number
  desaturate: number
  /** Film grain amplitude 0..1 (added to the adjustment grain). */
  grain: number
}

export function createEffectState(): EffectState {
  return {
    dx: 0,
    dy: 0,
    scale: 1,
    rgbSplit: 0,
    white: 0,
    blur: 0,
    glowSigma: 0,
    glowStrength: 0,
    scanlines: 0,
    noise: 0,
    desaturate: 0,
    grain: 0,
  }
}

export function resetEffectState(s: EffectState): EffectState {
  s.dx = 0
  s.dy = 0
  s.scale = 1
  s.rgbSplit = 0
  s.white = 0
  s.blur = 0
  s.glowSigma = 0
  s.glowStrength = 0
  s.scanlines = 0
  s.noise = 0
  s.desaturate = 0
  s.grain = 0
  return s
}

const TAU = Math.PI * 2

const param = (preset: EffectPreset, key: string, fallback: number): number => {
  const v = preset.params[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/**
 * Add one effect's contribution at `t` seconds after the effect window start, with
 * `intensity` 0..1, into `s`. Effects compose: translations add, scales multiply, mixes take
 * the max (so overlapping flashes never exceed white).
 */
export function applyEffect(
  preset: EffectPreset,
  t: number,
  intensity: number,
  s: EffectState,
): void {
  const I = intensity
  switch (preset.effect) {
    case 'shake': {
      const d = EFFECT_DEFAULTS.shake
      const A = param(preset, 'amplitude', d.amplitude) * I
      const f = param(preset, 'frequency', d.frequency)
      s.dx += A * (0.6 * Math.sin(TAU * f * t) + 0.4 * Math.sin(TAU * f * 1.7 * t + 1.3))
      s.dy +=
        A * (0.6 * Math.sin(TAU * f * 1.3 * t + 0.7) + 0.4 * Math.sin(TAU * f * 2.1 * t + 2.1))
      break
    }
    case 'zoomPulse': {
      const d = EFFECT_DEFAULTS.zoomPulse
      const a = param(preset, 'amount', d.amount) * I
      const f = param(preset, 'frequency', d.frequency)
      s.scale *= 1 + a * (0.5 - 0.5 * Math.cos(TAU * f * t))
      break
    }
    case 'beatZoom': {
      const d = EFFECT_DEFAULTS.beatZoom
      const bpm = Math.max(1, param(preset, 'bpm', d.bpm))
      const a = param(preset, 'amount', d.amount) * I
      const k = param(preset, 'decay', d.decay)
      const period = 60 / bpm
      const since = t - Math.floor(t / period) * period
      s.scale *= 1 + a * Math.exp(-k * since)
      break
    }
    case 'rgbSplit':
      s.rgbSplit += param(preset, 'amount', EFFECT_DEFAULTS.rgbSplit.amount) * I
      break
    case 'flash': {
      const fade = Math.max(1e-3, param(preset, 'fade', EFFECT_DEFAULTS.flash.fade))
      s.white = Math.max(s.white, I * Math.max(0, 1 - t / fade))
      break
    }
    case 'strobe': {
      const d = EFFECT_DEFAULTS.strobe
      const f = param(preset, 'frequency', d.frequency)
      const on = Math.floor(t * f * 2) % 2 === 0
      if (on) s.white = Math.max(s.white, param(preset, 'mix', d.mix) * I)
      break
    }
    case 'blurIn': {
      const d = EFFECT_DEFAULTS.blurIn
      const dur = Math.max(1e-3, param(preset, 'duration', d.duration))
      s.blur = Math.max(s.blur, param(preset, 'sigma', d.sigma) * I * Math.max(0, 1 - t / dur))
      break
    }
    case 'vhs': {
      const d = EFFECT_DEFAULTS.vhs
      s.rgbSplit += param(preset, 'offset', d.offset) * I
      s.scanlines = Math.max(s.scanlines, param(preset, 'scanlines', d.scanlines) * I)
      s.noise = Math.max(s.noise, param(preset, 'noise', d.noise) * I)
      s.desaturate = Math.max(s.desaturate, param(preset, 'desaturate', d.desaturate) * I)
      break
    }
    case 'glow': {
      const d = EFFECT_DEFAULTS.glow
      s.glowSigma = Math.max(s.glowSigma, param(preset, 'sigma', d.sigma))
      s.glowStrength += param(preset, 'strength', d.strength) * I
      break
    }
    case 'filmGrain':
      s.grain += param(preset, 'amount', EFFECT_DEFAULTS.filmGrain.amount) * I
      break
  }
}

/**
 * Evaluate all of a clip's effects at clip-local time `local` (us) into `s` (reset first).
 * Effects outside their window contribute nothing. Unknown refs are skipped.
 */
export function evaluateEffects(
  effects: readonly EffectRef[],
  local: number,
  clipDuration: number,
  resolve: ((ref: string) => EffectPreset | undefined) | undefined,
  s: EffectState,
): EffectState {
  resetEffectState(s)
  if (!resolve) return s
  for (let i = 0; i < effects.length; i++) {
    const e = effects[i]!
    const end = e.duration === undefined ? clipDuration : e.start + e.duration
    if (local < e.start || local >= end) continue
    const preset = resolve(e.ref)
    if (preset) applyEffect(preset, (local - e.start) / 1e6, e.intensity, s)
  }
  return s
}
