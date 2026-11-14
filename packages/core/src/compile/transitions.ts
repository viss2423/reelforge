/**
 * Main-track transitions.
 *
 * Built-in types map 1:1 onto FFmpeg `xfade` transitions (SIMD/threaded, no expressions).
 * The four "trend" transitions are an xfade base plus a post-process restricted to the
 * overlap window with `enable` (filters are bypassed outside it, so they cost nothing for
 * the rest of the reel):
 * - whip   smoothleft slide + horizontal motion blur peaking at the cut;
 * - flash  dissolve + exposure bloom to near-white peaking at the cut;
 * - glitch horizontal-slice reveal + chroma split + temporal noise;
 * - spin   dissolve + 360° eased rotation with a zoom punch (perspective warp).
 */
import type { TransitionType } from '../schema.ts'
import { sampledCommands, sendcmdFilter } from './cmd.ts'
import { num } from './expr.ts'
import { filter } from './escape.ts'
import { perspectiveFilter, rotateZoomInverse } from './geometry.ts'

type BuiltinTransition = Exclude<TransitionType, 'whip' | 'flash' | 'glitch' | 'spin'>

/** TransitionType → xfade transition name (identical names; listed for explicitness). */
export const XFADE_TRANSITIONS: Readonly<Record<BuiltinTransition, string>> = {
  fade: 'fade',
  fadeblack: 'fadeblack',
  fadewhite: 'fadewhite',
  dissolve: 'dissolve',
  wipeleft: 'wipeleft',
  wiperight: 'wiperight',
  wipeup: 'wipeup',
  wipedown: 'wipedown',
  slideleft: 'slideleft',
  slideright: 'slideright',
  slideup: 'slideup',
  slidedown: 'slidedown',
  smoothleft: 'smoothleft',
  smoothright: 'smoothright',
  smoothup: 'smoothup',
  smoothdown: 'smoothdown',
  circleopen: 'circleopen',
  circleclose: 'circleclose',
  zoomin: 'zoomin',
  pixelize: 'pixelize',
  radial: 'radial',
  hblur: 'hblur',
  squeezeh: 'squeezeh',
  squeezev: 'squeezev',
}

/** xfade base used by each custom transition. */
export const CUSTOM_TRANSITION_BASE: Readonly<
  Record<Exclude<TransitionType, BuiltinTransition>, string>
> = {
  whip: 'smoothleft',
  flash: 'fade',
  glitch: 'hlslice',
  spin: 'fade',
}

type CustomTransition = Exclude<TransitionType, BuiltinTransition>

const isCustom = (t: TransitionType): t is CustomTransition =>
  Object.hasOwn(CUSTOM_TRANSITION_BASE, t)

export interface TransitionPlan {
  /** The xfade filter joining the accumulated stream and the incoming clip. */
  xfade: string
  /** Filters applied to the xfade output (time = accumulated stream time). */
  post: string[]
}

/**
 * Plan a transition starting at `offsetUs` (accumulated-stream time) lasting `durationUs`
 * on a w×h canvas at `fps`. `scale` = export width / 1080 (sizes are authored at 1080p);
 * `uid` names filter instances targeted by `sendcmd` (unique per graph).
 */
export function planTransition(
  type: TransitionType,
  offsetUs: number,
  durationUs: number,
  o: { w: number; h: number; fps: number; scale: number; uid: string },
): TransitionPlan {
  const base = isCustom(type) ? CUSTOM_TRANSITION_BASE[type] : XFADE_TRANSITIONS[type]
  const xfade = filter('xfade', {
    transition: base,
    duration: num(durationUs / 1e6),
    offset: num(offsetUs / 1e6),
  })
  const a = offsetUs / 1e6
  const d = durationUs / 1e6
  const enable = `between(t,${num(a)},${num(a + d)})`
  // Triangular envelope 0→1→0 across the window, peaking at the cut.
  const tri = `max(0,1-abs(2*(t-${num(a)})/${num(d)}-1))`
  switch (type) {
    case 'whip': {
      const id = `gblur@${o.uid}`
      const peak = 60 * o.scale
      const cmds = sampledCommands({
        target: id,
        command: 'sigma',
        signal: {
          constant: undefined,
          expr: () => '0',
          at: (us) => Math.max(0.01, peak * Math.sin(Math.PI * Math.min(1, us / durationUs))),
        },
        fromUs: 0,
        toUs: durationUs,
        fps: o.fps,
        offsetUs,
        format: (v) => num(v, 2),
      })
      return {
        xfade,
        post: [sendcmdFilter(cmds)!, filter(id, { sigma: 0.01, sigmaV: 0.01, steps: 2, enable })],
      }
    }
    case 'flash':
      return {
        xfade,
        post: [
          filter('eq', {
            brightness: `0.85*pow(${tri},2)`,
            saturation: `1-0.8*${tri}`,
            eval: 'frame',
            enable,
          }),
        ],
      }
    case 'glitch': {
      const shift = Math.max(2, Math.round(14 * o.scale))
      return {
        xfade,
        post: [
          filter('chromashift', { cbh: -shift, crh: shift, cbv: Math.round(shift / 3), enable }),
          filter('noise', { alls: 28, allf: 't+u', enable }),
        ],
      }
    }
    case 'spin': {
      const p = `((in/${num(o.fps)}-${num(a)})/${num(d)})`
      const pc = `clip(${p},0,1)`
      // easeInOut(p) * 2π: fastest rotation at the cut.
      const theta = `(2*PI*if(lt(${pc},0.5),4*pow(${pc},3),1-pow(2-2*${pc},3)/2))`
      const z = `(1+0.6*sin(PI*${pc}))`
      const cx = num(o.w / 2)
      const cy = num(o.h / 2)
      return {
        xfade,
        post: [
          perspectiveFilter(
            o.w,
            o.h,
            rotateZoomInverse({ ocx: cx, ocy: cy, scx: cx, scy: cy, z, theta }),
            { enable },
          ),
        ],
      }
    }
    default:
      return { xfade, post: [] }
  }
}
