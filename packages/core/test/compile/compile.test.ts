/**
 * compileRender / compileLoudnessAnalysis: argv shape, graph validity (every label produced
 * and consumed exactly once) and graph structure for many project shapes, plus snapshots
 * of representative graphs.
 */
import { describe, expect, it } from 'vitest'
import { TransitionType } from '../../src/schema.ts'
import {
  CompileError,
  compileLoudnessAnalysis,
  compileRender,
  exportSize,
  type CompileContext,
  type RenderPlan,
} from '../../src/compile/index.ts'
import type { Project } from '../../src/schema.ts'
import { hwaccelFor } from '../../src/compile/types.ts'
import {
  allFilters,
  argAfter,
  ctx,
  filtersNamed,
  main,
  parseGraph,
  project,
  validateGraph,
} from './helpers.ts'

/** Compile and assert structural validity of the graph + argv. */
function compile(p: Project, c: CompileContext = ctx()): RenderPlan {
  const plan = compileRender(p, c)
  const inputs = plan.args.filter((a) => a === '-i').length
  const maps = plan.args.flatMap((a, i) => (plan.args[i - 1] === '-map' ? [a.slice(1, -1)] : []))
  expect(maps).toHaveLength(2)
  validateGraph(plan.filterGraph, inputs, maps)
  return plan
}

const names = (graph: string): string[] => allFilters(graph).map((f) => f.name.split('@')[0]!)

/** Graph of a two-clip project joined by a `type` transition. */
const transitionGraph = (type: string): string =>
  compile(
    project([
      main([
        { duration: 1_000_000 },
        { duration: 1_000_000, transitionIn: { type, duration: 400_000 } },
      ]),
    ]),
  ).filterGraph

/** Graph of a clip with one effect windowed to 0.5–1.5 s. */
const fx = (effect: string): string =>
  compile(
    project([
      main([
        {
          duration: 2_000_000,
          effects: [
            { id: 'e', ref: `fx/${effect}`, start: 500_000, duration: 1_000_000, intensity: 0.8 },
          ],
        },
      ]),
    ]),
  ).filterGraph

const overlay = (clips: unknown[]) => ({ kind: 'overlay', clips })
const audioTrack = (clips: unknown[]) => ({ kind: 'audio', clips })

/** Snapshot-friendly view of a compiled plan. */
const snap = (p: Project, c: CompileContext = ctx()) => {
  const plan = compile(p, c)
  return { args: plan.args, graph: plan.filterGraph.split('\n') }
}

describe('compileRender argv', () => {
  const plan = compile(project([main([{ duration: 2_000_000 }])]))

  it('reads the graph from a file and maps video + audio', () => {
    expect(argAfter(plan.args, '-/filter_complex')).toBe('C:\\tmp\\graph.txt')
    expect(plan.filterGraphPath).toBe('C:\\tmp\\graph.txt')
    expect(plan.args).not.toContain('-filter_complex')
    expect(plan.args.at(-1)).toBe('C:\\out\\job.mp4.part')
  })

  it('tags BT.709, CFR, faststart and AAC-LC 320k 48 kHz stereo', () => {
    const a = plan.args
    expect(argAfter(a, '-color_primaries')).toBe('bt709')
    expect(argAfter(a, '-color_trc')).toBe('bt709')
    expect(argAfter(a, '-colorspace')).toBe('bt709')
    expect(argAfter(a, '-fps_mode')).toBe('cfr')
    expect(argAfter(a, '-movflags')).toBe('+faststart')
    expect(argAfter(a, '-c:a')).toBe('aac')
    expect(argAfter(a, '-profile:a')).toBe('aac_low')
    expect(argAfter(a, '-b:a')).toBe('320k')
    expect(argAfter(a, '-ar')).toBe('48000')
    expect(argAfter(a, '-ac')).toBe('2')
    expect(argAfter(a, '-c:v')).toBe('libx264')
    expect(a.join(' ')).toContain('-preset medium -crf 19')
    expect(a[a.lastIndexOf('-t') + 1]).toBe('2')
  })

  it('reports duration, frames and output size', () => {
    expect(plan).toMatchObject({ duration: 2_000_000, frames: 60, width: 1080, height: 1920 })
  })

  it('seeks inputs on the input side', () => {
    const p = project([main([{ duration: 1_000_000, in: 2_500_000 }])])
    const a = compile(p).args
    const i = a.indexOf('-i')
    expect(a.slice(i - 4, i)).toEqual(['-ss', '2.5', '-t', '1.1'])
  })

  it('ends the graph with the encoder pixel format and colour params', () => {
    const last = parseGraph(plan.filterGraph).find((c) =>
      c.filters.some((f) => f.name === 'setparams'),
    )!
    expect(last.filters.map((f) => f.name)).toEqual(['format', 'setparams'])
    expect(last.filters[0]!.positional).toEqual(['yuv420p'])
    const nv12 = compile(
      project([main([{ duration: 500_000 }])]),
      ctx({ encoder: { video: 'h264_amf', args: [], pixFmt: 'nv12' } }),
    )
    expect(filtersNamed(nv12.filterGraph, 'format').at(-1)!.positional).toEqual(['nv12'])
  })

  it('adds -hwaccel to video inputs when requested', () => {
    const a = compile(project([main([{ duration: 500_000 }])]), ctx({ hwaccel: 'd3d11va' })).args
    expect(argAfter(a, '-hwaccel')).toBe('d3d11va')
  })

  it('limits -hwaccel to the listed source codecs', () => {
    const p = project([main([{ duration: 500_000 }])])
    const off = compile(p, ctx({ hwaccel: 'd3d11va', hwaccelCodecs: ['hevc'] })).args
    expect(off).not.toContain('-hwaccel')
    const assetId = (p.tracks[0]!.clips[0] as { assetId: string }).assetId
    const base = ctx({ hwaccel: 'd3d11va', hwaccelCodecs: ['hevc'] })
    const hevc = {
      ...base,
      assets: { ...base.assets, [assetId]: { ...base.assets[assetId]!, videoCodec: 'hevc' } },
    }
    expect(argAfter(compile(p, hevc).args, '-hwaccel')).toBe('d3d11va')
    expect(hwaccelFor({}, { videoCodec: 'hevc' })).toBeUndefined()
    expect(hwaccelFor({ hwaccel: 'vt' }, undefined)).toBe('vt')
  })
})

describe('export size and scaling', () => {
  it('maps resolutions to 9:16 sizes', () => {
    expect(exportSize('720p')).toEqual({ width: 720, height: 1280 })
    expect(exportSize('1080p')).toEqual({ width: 1080, height: 1920 })
    expect(exportSize('1440p')).toEqual({ width: 1440, height: 2560 })
    expect(exportSize('2160p')).toEqual({ width: 2160, height: 3840 })
  })

  it('scales each source once, straight to the export size, with the quality scaler', () => {
    const p = project([main([{ duration: 500_000 }])])
    for (const [quality, flags] of [
      ['draft', 'bilinear'],
      ['high', 'lanczos'],
      ['max', 'lanczos+accurate_rnd+full_chroma_int'],
    ] as const) {
      const plan = compile(p, ctx({ settings: { ...ctx().settings, resolution: '720p', quality } }))
      const scales = filtersNamed(plan.filterGraph, 'scale')
      expect(scales).toHaveLength(1)
      // 1920×1080 cover-fit into 9:16: only the centre 31.6 % of the width can reach the
      // canvas, so it is cropped first and that window alone is scaled to 720×1280.
      expect(scales[0]!.options).toMatchObject({ w: '720', h: '1280', flags })
      expect(filtersNamed(plan.filterGraph, 'crop')[0]!.options).toEqual({
        w: 'iw*0.316406',
        h: 'ih*1',
        x: 'iw*0.341797',
        y: 'ih*0',
      })
      const chain = allFilters(plan.filterGraph).map((f) => f.name)
      expect(chain.indexOf('crop')).toBeLessThan(chain.indexOf('scale'))
      expect(plan.width).toBe(720)
    }
  })

  it('honours a size override (previews) and the settings fps', () => {
    const plan = compile(
      project([main([{ duration: 1_000_000 }])]),
      ctx({ size: { width: 540, height: 960 }, settings: { ...ctx().settings, fps: 60 } }),
    )
    expect(plan).toMatchObject({ width: 540, height: 960, frames: 60 })
    expect(filtersNamed(plan.filterGraph, 'fps')[0]!.positional).toEqual(['60'])
  })

  it('fits portrait sources exactly (no crop) and swaps rotated dimensions', () => {
    const port = compile(project([main([{ duration: 500_000, assetId: 'port' }])]))
    expect(filtersNamed(port.filterGraph, 'crop')).toHaveLength(0)
    expect(filtersNamed(port.filterGraph, 'scale')[0]!.options).toMatchObject({
      w: '1080',
      h: '1920',
    })
    // rotation 90 → 1080×1920 display size → exact fit too.
    const rot = compile(project([main([{ duration: 500_000, assetId: 'rot' }])]))
    expect(filtersNamed(rot.filterGraph, 'crop')).toHaveLength(0)
  })
})

describe('graph minimality', () => {
  it('a plain clip has no look, effect, overlay or text filters', () => {
    const plan = compile(project([main([{ duration: 1_000_000, assetId: 'port' }])]))
    const ns = names(plan.filterGraph)
    for (const n of ['lutyuv', 'lut3d', 'overlay', 'xfade', 'ass', 'perspective', 'eq', 'zscale']) {
      expect(ns).not.toContain(n)
    }
  })

  it('contains exactly the filters for non-neutral adjustments', () => {
    const plan = compile(
      project([main([{ duration: 500_000, adjustments: { contrast: 20, sharpen: 30 } }])]),
    )
    const ns = names(plan.filterGraph)
    expect(ns).toContain('lutyuv')
    expect(ns).toContain('unsharp')
    expect(ns).not.toContain('gblur')
    expect(ns).not.toContain('vignette')
  })
})

describe('main track', () => {
  it('concatenates hard cuts', () => {
    const plan = compile(
      project([main([{ duration: 1_000_000 }, { duration: 1_000_000, assetId: 'port' }])]),
    )
    expect(filtersNamed(plan.filterGraph, 'concat')[0]!.options).toMatchObject({
      n: '2',
      v: '1',
      a: '0',
    })
    expect(plan.frames).toBe(60)
  })

  it('joins transitions with xfade at overlap-adjusted offsets', () => {
    const p = project([
      main([
        { duration: 2_000_000 },
        { duration: 2_000_000, transitionIn: { type: 'fade', duration: 500_000 } },
        { duration: 1_000_000, transitionIn: { type: 'circleopen', duration: 300_000 } },
      ]),
    ])
    const plan = compile(p)
    expect(plan.duration).toBe(4_200_000)
    expect(plan.frames).toBe(126)
    const x = filtersNamed(plan.filterGraph, 'xfade')
    expect(x.map((f) => f.options)).toEqual([
      { transition: 'fade', duration: '0.5', offset: '1.5' },
      { transition: 'circleopen', duration: '0.3', offset: '3.2' },
    ])
  })

  it.each(TransitionType.options)('compiles the %s transition', (type) => {
    const plan = compile(
      project([
        main([
          { duration: 1_000_000 },
          { duration: 1_000_000, transitionIn: { type, duration: 400_000 } },
        ]),
      ]),
    )
    const x = filtersNamed(plan.filterGraph, 'xfade')
    expect(x).toHaveLength(1)
    expect(plan.duration).toBe(1_600_000)
  })

  it('custom transitions post-process only the overlap window', () => {
    const enable = 'between(t,0.6,1)'
    expect(filtersNamed(transitionGraph('whip'), 'gblur')[0]!.options.enable).toBe(enable)
    expect(filtersNamed(transitionGraph('whip'), 'sendcmd')).toHaveLength(1)
    expect(filtersNamed(transitionGraph('flash'), 'eq')[0]!.options).toMatchObject({
      eval: 'frame',
      enable,
    })
    expect(filtersNamed(transitionGraph('glitch'), 'chromashift')[0]!.options.enable).toBe(enable)
    expect(filtersNamed(transitionGraph('glitch'), 'xfade')[0]!.options.transition).toBe('hlslice')
    expect(filtersNamed(transitionGraph('spin'), 'perspective')[0]!.options.enable).toBe(enable)
  })

  it('pads with the background when other tracks run longer', () => {
    const p = project(
      [
        main([{ duration: 1_000_000 }]),
        {
          kind: 'audio',
          clips: [{ id: 'a', type: 'audio', assetId: 'music', start: 0, duration: 2_000_000 }],
        },
      ],
      { settings: { background: '#112233' } },
    )
    const plan = compile(p)
    expect(plan.frames).toBe(60)
    expect(filtersNamed(plan.filterGraph, 'tpad').at(-1)!.options).toMatchObject({
      stop_mode: 'add',
      stop: '30',
      color: '0x112233',
    })
  })

  it('renders the background colour when the main track is empty or hidden', () => {
    const audioOnly = {
      kind: 'audio',
      clips: [{ id: 'a', type: 'audio', assetId: 'music', start: 0, duration: 1_000_000 }],
    }
    const plan = compile(project([audioOnly], { settings: { background: '#FF0000' } }))
    expect(filtersNamed(plan.filterGraph, 'color')[0]!.options).toMatchObject({
      c: '0xFF0000',
      s: '1080x1920',
      r: '30',
    })
    const hidden = compile(
      project([{ ...main([{ duration: 1_000_000 }]), hidden: true }, audioOnly]),
    )
    expect(names(hidden.filterGraph)).not.toContain('scale')
  })

  it('substitutes the background for clips whose asset is missing', () => {
    const plan = compile(
      project([main([{ duration: 1_000_000, assetId: 'gone' }, { duration: 1_000_000 }])]),
    )
    expect(filtersNamed(plan.filterGraph, 'color')).toHaveLength(1)
    expect(plan.frames).toBe(60)
  })

  it('rejects empty projects and empty ranges', () => {
    expect(() => compileRender(project([main([])]), ctx())).toThrow(CompileError)
    expect(() =>
      compileRender(
        project([main([{ duration: 1_000_000 }])]),
        ctx({ settings: { ...ctx().settings, range: { start: 2_000_000, end: 3_000_000 } } }),
      ),
    ).toThrow(/range/)
  })
})

describe('clip processing', () => {
  it('speed: setpts divides time; 2× audio uses rubberband at high quality, atempo at draft', () => {
    const p = project([main([{ duration: 1_000_000, speed: 2 }])])
    const hq = compile(p)
    expect(hq.filterGraph).toContain('setpts=(PTS-STARTPTS)/2')
    expect(filtersNamed(hq.filterGraph, 'rubberband')[0]!.options.tempo).toBe('2')
    expect(hq.args[hq.args.lastIndexOf('-t') + 1]).toBe('1')
    // Input reads 2 s of source (+ margin).
    expect(argAfter(hq.args, '-t', 0)).toBe('2.1')
    const draft = compile(p, ctx({ settings: { ...ctx().settings, quality: 'draft' } }))
    expect(filtersNamed(draft.filterGraph, 'atempo')[0]!.positional).toEqual(['2'])
  })

  it('speed ramps use a piecewise setpts expression and tempo segments', () => {
    const plan = compile(
      project([
        main([
          {
            duration: 2_000_000,
            speedRamp: [
              { t: 0, value: 1, easing: 'linear' },
              { t: 2_000_000, value: 3, easing: 'linear' },
            ],
          },
        ]),
      ]),
    )
    expect(
      filtersNamed(plan.filterGraph, 'setpts').some((f) => f.options.expr?.includes('if(lt(')),
    ).toBe(true)
    expect(filtersNamed(plan.filterGraph, 'asplit').length).toBeGreaterThan(0)
  })

  it('reverse: chunked reverse of the mirrored source range + areverse', () => {
    const plan = compile(project([main([{ duration: 5_000_000, in: 1_000_000, reverse: true }])]))
    expect(filtersNamed(plan.filterGraph, 'reverse')).toHaveLength(3) // 2 s chunks
    expect(filtersNamed(plan.filterGraph, 'areverse')).toHaveLength(1)
    const seeks = plan.args.flatMap((a, i) => (plan.args[i - 1] === '-ss' ? [Number(a)] : []))
    // Chunks read source [4,6), [2,4), [1,2) — newest first.
    expect(seeks.slice(0, 3)).toEqual([4, 2, 1])
  })

  it('crop, flips and HDR tone mapping (HLG and PQ)', () => {
    const plan = compile(
      project([
        main([
          {
            duration: 500_000,
            assetId: 'hdr',
            crop: { left: 0.2 },
            transform: { flipH: true, flipV: true },
          },
          { duration: 500_000, assetId: 'pq' },
        ]),
      ]),
    )
    // The canvas window (centre 39.55 % of the cropped frame) folded into the clip crop.
    expect(filtersNamed(plan.filterGraph, 'crop')[0]!.options).toMatchObject({
      w: 'iw*0.316406',
      x: 'iw*0.441797',
    })
    expect(names(plan.filterGraph)).toEqual(expect.arrayContaining(['hflip', 'vflip', 'tonemap']))
    const z = filtersNamed(plan.filterGraph, 'zscale')
      .map((f) => f.options.tin)
      .filter(Boolean)
    expect(z).toEqual(['arib-std-b67', 'smpte2084'])
  })

  it('static cover zoom crops the canvas window, then scales it once (no per-frame warp)', () => {
    const plan = compile(
      project([
        main([
          {
            duration: 500_000,
            assetId: 'port',
            transform: { scale: { value: 1.5 }, x: { value: 600 } },
          },
        ]),
      ]),
    )
    expect(names(plan.filterGraph)).not.toContain('perspective')
    expect(filtersNamed(plan.filterGraph, 'scale')[0]!.options).toMatchObject({
      w: '1080',
      h: '1920',
    })
    // Zoomed frame 1620×2880; x: 1620/2 − 600 = 210, y: (2880 − 1920)/2 = 480.
    expect(filtersNamed(plan.filterGraph, 'crop')[0]!.options).toEqual({
      w: 'iw*0.666667',
      h: 'ih*0.666667',
      x: 'iw*0.12963',
      y: 'ih*0.166667',
    })
  })

  it('keyframed zoom uses one perspective warp whose zoom follows the keyframes', () => {
    const plan = compile(
      project([
        main([
          {
            duration: 2_000_000,
            assetId: 'port',
            transform: {
              scale: {
                value: 1,
                keyframes: [
                  { t: 0, value: 1, easing: 'linear' },
                  { t: 2_000_000, value: 2, easing: 'easeInOut' },
                ],
              },
            },
          },
        ]),
      ]),
    )
    const [p] = filtersNamed(plan.filterGraph, 'perspective')
    expect(p).toBeDefined()
    expect(p!.options.eval).toBe('frame')
    expect(p!.options.x0).toContain('pow(')
    expect(names(plan.filterGraph)).not.toContain('zoompan')
  })

  it('contain fit composites a sprite over the background (or a blurred fill)', () => {
    const contain = compile(
      project([main([{ duration: 500_000, fit: 'contain' }])], {
        settings: { background: '#0000FF' },
      }),
    )
    expect(filtersNamed(contain.filterGraph, 'overlay')).toHaveLength(1)
    expect(filtersNamed(contain.filterGraph, 'color')[0]!.options.c).toBe('0x0000FF')
    const blur = compile(
      project([main([{ duration: 500_000, fit: 'contain' }])], {
        settings: { backgroundBlur: true },
      }),
    )
    expect(names(blur.filterGraph)).toEqual(expect.arrayContaining(['split', 'boxblur', 'overlay']))
    expect(names(blur.filterGraph)).not.toContain('color')
  })

  it('opacity: static alpha LUT; animated alpha driven by sendcmd (no geq)', () => {
    const stat = compile(
      project([main([{ duration: 500_000, transform: { opacity: { value: 0.5 } } }])]),
    )
    expect(filtersNamed(stat.filterGraph, 'lut')[0]!.options.a).toBe('val*0.5')
    const anim = compile(
      project([
        main([
          {
            duration: 1_000_000,
            transform: {
              opacity: {
                value: 1,
                keyframes: [
                  { t: 0, value: 0 },
                  { t: 1_000_000, value: 1, easing: 'linear' },
                ],
              },
            },
          },
        ]),
      ]),
    )
    expect(filtersNamed(anim.filterGraph, 'sendcmd')).toHaveLength(1)
    expect(names(anim.filterGraph)).not.toContain('geq')
  })

  it('rotation uses rotate (static) and keeps the canvas covered by the background', () => {
    const plan = compile(
      project([main([{ duration: 500_000, transform: { rotation: { value: 10 } } }])]),
    )
    expect(filtersNamed(plan.filterGraph, 'rotate')).toHaveLength(1)
    expect(filtersNamed(plan.filterGraph, 'overlay')).toHaveLength(1)
  })

  it('LUT filters: full intensity lut3d, partial via baked cube or blend mix', () => {
    const full = compile(
      project([main([{ duration: 500_000, filter: { ref: 'pack/teal', intensity: 1 } }])]),
    )
    const [l] = filtersNamed(full.filterGraph, 'lut3d')
    expect(l!.options).toEqual({ file: 'C:/packs/pack/luts/teal.cube', interp: 'tetrahedral' })
    const half = project([
      main([{ duration: 500_000, filter: { ref: 'pack/teal', intensity: 0.4 } }]),
    ])
    const mixed = compile(half)
    expect(filtersNamed(mixed.filterGraph, 'blend')[0]!.options).toMatchObject({
      all_mode: 'normal',
      all_opacity: '0.4',
    })
    const baked = compile(
      half,
      ctx({ resolveLutMix: (r, k) => `C:\\cache\\${r.replace('/', '_')}_${k}.cube` }),
    )
    expect(filtersNamed(baked.filterGraph, 'blend')).toHaveLength(0)
    expect(filtersNamed(baked.filterGraph, 'lut3d')[0]!.options.file).toBe(
      'C:/cache/pack_teal_0.4.cube',
    )
    // Unknown LUT refs are skipped.
    const unknown = compile(
      project([main([{ duration: 500_000, filter: { ref: 'pack/none', intensity: 1 } }])]),
    )
    expect(filtersNamed(unknown.filterGraph, 'lut3d')).toHaveLength(0)
  })

  it('chroma key produces an alpha sprite over the background', () => {
    const plan = compile(
      project([
        main([
          { duration: 500_000, chromaKey: { enabled: true, color: '#00FF00', similarity: 0.2 } },
        ]),
      ]),
    )
    expect(filtersNamed(plan.filterGraph, 'chromakey')[0]!.options).toMatchObject({
      color: '0x00FF00',
      similarity: '0.2',
    })
    expect(filtersNamed(plan.filterGraph, 'overlay')).toHaveLength(1)
  })

  it('image Ken Burns uses a perspective warp over a looped still (no zoompan)', () => {
    for (const autoMotion of ['zoomIn', 'zoomOut', 'panLeft', 'panRight']) {
      const plan = compile(
        project([main([{ duration: 2_000_000, type: 'image', assetId: 'img', autoMotion }])]),
      )
      const ns = names(plan.filterGraph)
      expect(ns).toContain('perspective')
      expect(ns).toContain('loop')
      expect(ns).not.toContain('zoompan')
      expect(plan.args.filter((a) => a === '-ss')).toHaveLength(0)
    }
  })
})

describe('effects', () => {
  it.each([
    ['rgbSplit', 'chromashift'],
    ['flash', 'eq'],
    ['blurIn', 'gblur'],
    ['vhs', 'noise'],
    ['glow', 'blend'],
    ['strobe', 'eq'],
    ['filmGrain', 'noise'],
  ])('%s → %s limited to its window', (effect, filterName) => {
    const g = fx(effect)
    const fs = filtersNamed(g, filterName)
    expect(fs.length).toBeGreaterThan(0)
    expect(fs.some((f) => f.options.enable === 'between(t,0.5,1.5)')).toBe(true)
  })

  it.each(['shake', 'zoomPulse', 'beatZoom'])('%s is folded into one geometry warp', (effect) => {
    const g = fx(effect)
    expect(filtersNamed(g, 'perspective')).toHaveLength(1)
  })

  it('unknown effect refs and zero intensity are ignored', () => {
    const g = compile(
      project([
        main([
          {
            duration: 1_000_000,
            assetId: 'port',
            effects: [
              { id: 'a', ref: 'fx/nope' },
              { id: 'b', ref: 'fx/rgbSplit', intensity: 0 },
            ],
          },
        ]),
      ]),
    ).filterGraph
    expect(names(g)).not.toContain('chromashift')
  })
})

describe('overlay tracks', () => {
  it('overlays a PiP with a frame-exact enable window and animated position', () => {
    const plan = compile(
      project([
        main([{ duration: 3_000_000, assetId: 'port' }]),
        overlay([
          {
            id: 'o',
            type: 'video',
            assetId: 'land',
            start: 1_000_000,
            duration: 1_000_000,
            transform: {
              scale: { value: 0.4 },
              x: {
                value: 540,
                keyframes: [
                  { t: 0, value: 300 },
                  { t: 1_000_000, value: 700 },
                ],
              },
            },
          },
        ]),
      ]),
    )
    const [o] = filtersNamed(plan.filterGraph, 'overlay')
    expect(o!.options).toMatchObject({
      enable: 'between(n,30,59)',
      eval: 'frame',
      eof_action: 'pass',
    })
    expect(plan.filterGraph).toContain('setpts=PTS+1/TB')
  })

  it.each(['screen', 'multiply', 'overlay', 'lighten', 'darken', 'add'])(
    'blend mode %s blends only inside the clip window',
    (blendMode) => {
      const plan = compile(
        project([
          main([{ duration: 3_000_000, assetId: 'port' }]),
          overlay([
            {
              id: 'o',
              type: 'video',
              assetId: 'land',
              start: 1_000_000,
              duration: 1_000_000,
              blendMode,
            },
          ]),
        ]),
      )
      const [b] = filtersNamed(plan.filterGraph, 'blend')
      expect(b!.options.all_mode).toBe(blendMode === 'add' ? 'addition' : blendMode)
      expect(filtersNamed(plan.filterGraph, 'concat').at(-1)!.options.n).toBe('3')
    },
  )

  it('places pack stickers and user stickers; unknown stickers are skipped', () => {
    const plan = compile(
      project([
        main([{ duration: 2_000_000, assetId: 'port' }]),
        overlay([
          { id: 's1', type: 'sticker', ref: 'pack/star', start: 0, duration: 1_000_000 },
          { id: 's2', type: 'sticker', assetId: 'img', start: 1_000_000, duration: 1_000_000 },
          { id: 's3', type: 'sticker', ref: 'pack/unknown', start: 0, duration: 1_000_000 },
        ]),
      ]),
    )
    expect(plan.args).toContain('C:\\packs\\pack\\stickers\\star.png')
    expect(filtersNamed(plan.filterGraph, 'overlay')).toHaveLength(2)
    expect(filtersNamed(plan.filterGraph, 'pad').length).toBeGreaterThanOrEqual(2)
  })

  it('applies sticker in/out animations from resolveAnimation', () => {
    const plan = compile(
      project([
        main([{ duration: 2_000_000, assetId: 'port' }]),
        overlay([
          {
            id: 's',
            type: 'sticker',
            ref: 'pack/star',
            start: 0,
            duration: 2_000_000,
            animationIn: { ref: 'builtin/pop', duration: 400_000 },
          },
        ]),
      ]),
      ctx({
        resolveAnimation: (r) =>
          r === 'builtin/pop'
            ? {
                id: 'pop',
                name: 'Pop',
                kind: 'in',
                trendScore: 50,
                tags: [],
                perCharacter: false,
                tracks: {
                  scale: [
                    { t: 0, value: 0, easing: 'linear' },
                    { t: 1, value: 1, easing: 'easeOutBack' },
                  ],
                  opacity: [
                    { t: 0, value: 0, easing: 'linear' },
                    { t: 1, value: 1, easing: 'linear' },
                  ],
                },
              }
            : undefined,
      }),
    )
    expect(filtersNamed(plan.filterGraph, 'perspective')).toHaveLength(1)
    expect(filtersNamed(plan.filterGraph, 'sendcmd')).toHaveLength(1)
  })

  it('hidden overlay tracks are skipped; overlay audio is mixed', () => {
    const plan = compile(
      project([
        main([{ duration: 2_000_000, assetId: 'port' }]),
        {
          ...overlay([{ id: 'o', type: 'video', assetId: 'land', start: 0, duration: 1_000_000 }]),
          hidden: true,
        },
      ]),
    )
    expect(filtersNamed(plan.filterGraph, 'overlay')).toHaveLength(0)
    // Main + overlay video audio → amix of 2.
    expect(filtersNamed(plan.filterGraph, 'amix')[0]!.options.inputs).toBe('2')
  })
})

describe('text and captions', () => {
  it('burns the ASS file with escaped Windows paths', () => {
    const plan = compile(
      project([main([{ duration: 1_000_000 }])]),
      ctx({ assPath: "C:\\Users\\O'Neil\\data dir\\tmp\\text.ass", fontsDir: 'C:\\packs\\fonts' }),
    )
    const [ass] = filtersNamed(plan.filterGraph, 'ass')
    expect(ass!.options).toEqual({
      filename: "C:/Users/O'Neil/data dir/tmp/text.ass",
      fontsdir: 'C:/packs/fonts',
    })
    expect(plan.filterGraph).toContain("filename='C\\:/Users/O\\'\\''Neil/data dir/tmp/text.ass'")
  })

  it('range exports shift the stream to timeline time around libass', () => {
    const plan = compile(
      project([main([{ duration: 3_000_000 }])]),
      ctx({
        assPath: 'C:\\t.ass',
        settings: { ...ctx().settings, range: { start: 1_000_000, end: 2_000_000 } },
      }),
    )
    const chain = parseGraph(plan.filterGraph).find((c) => c.filters.some((f) => f.name === 'ass'))!
    expect(chain.filters.map((f) => f.name)).toEqual(['setpts', 'ass', 'setpts'])
    expect(chain.filters[0]!.positional).toEqual(['PTS+1/TB'])
    expect(plan).toMatchObject({ duration: 1_000_000, frames: 30 })
  })

  it('no assPath → no ass filter', () => {
    expect(names(compile(project([main([{ duration: 500_000 }])])).filterGraph)).not.toContain(
      'ass',
    )
  })
})

describe('range export', () => {
  it('only decodes clips inside the range and seeks into cut clips', () => {
    const plan = compile(
      project([
        main([{ duration: 2_000_000 }, { duration: 2_000_000, assetId: 'port', in: 1_000_000 }]),
      ]),
      ctx({ settings: { ...ctx().settings, range: { start: 2_500_000, end: 3_500_000 } } }),
    )
    expect(plan.args).not.toContain('C:\\media\\land.bin')
    // port clip head cut by 0.5 s → source 1.5 s.
    expect(argAfter(plan.args, '-ss')).toBe('1.5')
    expect(plan.frames).toBe(30)
  })
})

describe('audio', () => {
  it('normalises to 48 kHz stereo and ends in single-pass loudnorm', () => {
    const plan = compile(project([main([{ duration: 1_000_000 }])]))
    const [ln] = filtersNamed(plan.filterGraph, 'loudnorm')
    expect(ln!.options).toEqual({ I: '-14', TP: '-1.5', LRA: '11' })
    expect(filtersNamed(plan.filterGraph, 'aformat').at(-1)!.options).toMatchObject({
      sample_rates: '48000',
      channel_layouts: 'stereo',
    })
  })

  it('uses measured values for a linear second pass', () => {
    const plan = compile(
      project([main([{ duration: 1_000_000 }])]),
      ctx({ loudness: { I: -23.4, TP: -6.1, LRA: 14.2, thresh: -33.9, offset: 0.3 } }),
    )
    expect(filtersNamed(plan.filterGraph, 'loudnorm')[0]!.options).toEqual({
      I: '-14',
      TP: '-1.5',
      LRA: '15',
      measured_I: '-23.4',
      measured_TP: '-6.1',
      measured_LRA: '14.2',
      measured_thresh: '-33.9',
      offset: '0.3',
      linear: '1',
    })
  })

  it('skips loudnorm when normalisation is off', () => {
    const plan = compile(
      project([main([{ duration: 1_000_000 }])]),
      ctx({ settings: { ...ctx().settings, normalizeLoudness: false } }),
    )
    expect(filtersNamed(plan.filterGraph, 'loudnorm')).toHaveLength(0)
  })

  it('generates silence for projects without audio', () => {
    const plan = compile(
      project([
        main([
          { duration: 1_000_000, assetId: 'silent' },
          { duration: 1_000_000, type: 'image', assetId: 'img' },
        ]),
      ]),
    )
    const [src] = filtersNamed(plan.filterGraph, 'anullsrc')
    expect(src!.options).toMatchObject({ r: '48000', cl: 'stereo' })
    expect(filtersNamed(plan.filterGraph, 'atrim').at(-1)!.options.end_sample).toBe('96000')
    expect(filtersNamed(plan.filterGraph, 'loudnorm')).toHaveLength(0)
  })

  it('honours muted clips and muted tracks', () => {
    const plan = compile(
      project([
        main([{ duration: 1_000_000, audio: { muted: true } }]),
        {
          ...audioTrack([
            { id: 'a', type: 'audio', assetId: 'music', start: 0, duration: 1_000_000 },
          ]),
          muted: true,
        },
      ]),
    )
    expect(filtersNamed(plan.filterGraph, 'anullsrc')).toHaveLength(1)
  })

  it('per-clip volume, fades, denoise (afftdn / arnndn) and voice enhance', () => {
    const p = project([
      main([
        {
          duration: 2_000_000,
          audio: {
            volume: 1.5,
            fadeIn: 500_000,
            fadeOut: 250_000,
            denoise: true,
            enhanceVoice: true,
          },
        },
      ]),
    ])
    const g = compile(p).filterGraph
    expect(filtersNamed(g, 'volume')[0]!.positional).toEqual(['1.5'])
    expect(filtersNamed(g, 'afade').map((f) => f.options)).toEqual([
      { t: 'in', st: '0', d: '0.5' },
      { t: 'out', st: '1.75', d: '0.25' },
    ])
    expect(names(g)).toEqual(
      expect.arrayContaining(['afftdn', 'highpass', 'equalizer', 'acompressor']),
    )
    const rn = compile(p, ctx({ rnnoiseModel: 'C:\\models\\rnnoise\\sh.rnnn' })).filterGraph
    expect(filtersNamed(rn, 'arnndn')[0]!.options.m).toBe('C:/models/rnnoise/sh.rnnn')
    expect(names(rn)).not.toContain('afftdn')
  })

  it('crossfades main-track audio across transitions (equal power)', () => {
    const g = compile(
      project([
        main([
          { duration: 1_000_000 },
          { duration: 1_000_000, transitionIn: { type: 'fade', duration: 400_000 } },
        ]),
      ]),
    ).filterGraph
    const fades = filtersNamed(g, 'afade')
    expect(fades.map((f) => [f.options.t, f.options.curve])).toEqual([
      ['out', 'qsin'],
      ['in', 'qsin'],
    ])
    expect(filtersNamed(g, 'adelay')[0]!.options).toMatchObject({ delays: '28800S', all: '1' })
  })

  it('ducks music under voice with a sidechain compressor and mixes with normalize=0', () => {
    const g = compile(
      project([
        main([{ duration: 2_000_000 }]),
        audioTrack([
          {
            id: 'mus',
            type: 'audio',
            assetId: 'music',
            start: 0,
            duration: 2_000_000,
            duckUnderVoice: true,
          },
        ]),
        audioTrack([
          {
            id: 'vo',
            type: 'audio',
            assetId: 'voice',
            start: 500_000,
            duration: 1_000_000,
            role: 'voiceover',
            speed: 1.25,
          },
        ]),
      ]),
    ).filterGraph
    expect(filtersNamed(g, 'sidechaincompress')).toHaveLength(1)
    const amix = filtersNamed(g, 'amix')
    expect(amix.every((f) => f.options.normalize === '0')).toBe(true)
    expect(filtersNamed(g, 'rubberband')[0]!.options.tempo).toBe('1.25')
  })

  it('audio-only inputs are opened with -vn', () => {
    const plan = compile(
      project([
        main([{ duration: 1_000_000, assetId: 'port' }]),
        audioTrack([{ id: 'a', type: 'audio', assetId: 'music', start: 0, duration: 1_000_000 }]),
      ]),
    )
    const i = plan.args.indexOf('C:\\media\\music.bin')
    expect(plan.args[i - 2]).toBe('-vn')
  })
})

describe('compileLoudnessAnalysis', () => {
  it('opens only audio and prints loudnorm JSON to a null muxer', () => {
    const p = project([
      main([{ duration: 2_000_000 }]),
      {
        kind: 'audio',
        clips: [{ id: 'a', type: 'audio', assetId: 'music', start: 0, duration: 2_000_000 }],
      },
    ])
    const plan = compileLoudnessAnalysis(p, ctx())!
    expect(plan.args.slice(-3)).toEqual(['-f', 'null', '-'])
    expect(plan.args.filter((a) => a === '-vn')).toHaveLength(2)
    expect(plan.args).not.toContain('-c:v')
    const [ln] = filtersNamed(plan.filterGraph, 'loudnorm')
    expect(ln!.options.print_format).toBe('json')
    expect(plan.duration).toBe(2_000_000)
    const final = plan.args[plan.args.indexOf('-map') + 1]!.slice(1, -1)
    validateGraph(plan.filterGraph, 2, [final])
  })

  it('returns undefined when nothing is audible', () => {
    expect(
      compileLoudnessAnalysis(project([main([{ duration: 1_000_000, assetId: 'silent' }])]), ctx()),
    ).toBeUndefined()
  })
})

describe('graph snapshots', () => {
  it('a typical reel: clips, transitions, image Ken Burns, LUT, text, music', () => {
    expect(
      snap(
        project([
          main([
            { duration: 2_000_000, adjustments: { contrast: 15, saturation: 10 } },
            {
              duration: 2_000_000,
              assetId: 'port',
              transitionIn: { type: 'slideleft', duration: 300_000 },
              filter: { ref: 'pack/teal', intensity: 1 },
            },
            {
              duration: 1_500_000,
              type: 'image',
              assetId: 'img',
              autoMotion: 'zoomIn',
              transitionIn: { type: 'whip', duration: 400_000 },
            },
          ]),
          {
            kind: 'audio',
            clips: [
              {
                id: 'm',
                type: 'audio',
                assetId: 'music',
                start: 0,
                duration: 4_800_000,
                duckUnderVoice: true,
                audio: { fadeOut: 1_000_000 },
              },
            ],
          },
        ]),
        ctx({ assPath: 'C:\\tmp\\text.ass' }),
      ),
    ).toMatchSnapshot()
  })

  it('overlay with blend mode, sticker and range', () => {
    expect(
      snap(
        project([
          main([{ duration: 3_000_000, assetId: 'port' }]),
          {
            kind: 'overlay',
            clips: [
              {
                id: 'o',
                type: 'video',
                assetId: 'land',
                start: 500_000,
                duration: 1_500_000,
                blendMode: 'screen',
                transform: { scale: { value: 0.5 } },
              },
              {
                id: 's',
                type: 'sticker',
                ref: 'pack/star',
                start: 1_000_000,
                duration: 1_000_000,
                transform: { rotation: { value: 15 } },
              },
            ],
          },
        ]),
        ctx({
          settings: {
            ...ctx().settings,
            resolution: '720p',
            range: { start: 500_000, end: 2_500_000 },
          },
        }),
      ),
    ).toMatchSnapshot()
  })
})
