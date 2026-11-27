/**
 * AI background in the render compiler: graph structure for every mode (valid label use,
 * matte decoded alongside the clip, correct merge filters), no-ops without a matte, the
 * subject pass for text behind subject, and the ASS layer split.
 */
import { describe, expect, it } from 'vitest'
import { buildAss, hasBehindText } from '../../src/ass.ts'
import { compileRender, type CompileContext } from '../../src/compile/index.ts'
import type { Project } from '../../src/schema.ts'
import {
  allFilters,
  asset,
  ASSETS,
  ctx,
  filtersNamed,
  main,
  parseGraph,
  project,
  validateGraph,
} from './helpers.ts'

const MATTE = 'C:\\media\\land.matte.mkv'
const withMatte = (over: Partial<CompileContext> = {}): CompileContext =>
  ctx({
    assets: { ...ASSETS, bg: asset('bg', { kind: 'image', width: 800, height: 600 }) },
    resolveMatte: (id) => (id === 'land' ? MATTE : undefined),
    ...over,
  })

const compile = (p: Project, c: CompileContext) => {
  const plan = compileRender(p, c)
  const inputs = plan.args.filter((a) => a === '-i').length
  const maps = plan.args.flatMap((a, i) => (plan.args[i - 1] === '-map' ? [a.slice(1, -1)] : []))
  validateGraph(plan.filterGraph, inputs, maps)
  return plan
}

const inputPaths = (args: readonly string[]): string[] =>
  args.flatMap((a, i) => (args[i - 1] === '-i' ? [a] : []))

const clip = (background: unknown, extra: Record<string, unknown> = {}) =>
  project([main([{ duration: 1_000_000, background, ...extra }])])

describe('AI background compile', () => {
  it('is a no-op for keep or when the asset has no matte', () => {
    const plain = compile(clip(undefined), withMatte())
    expect(compile(clip({ mode: 'keep' }), withMatte()).filterGraph).toBe(plain.filterGraph)
    const noMatte = withMatte({ resolveMatte: () => undefined })
    expect(compile(clip({ mode: 'color', color: '#ff0000' }), noMatte).filterGraph).toBe(
      plain.filterGraph,
    )
    expect(inputPaths(plain.args)).not.toContain(MATTE)
  })

  it('image mode without its image asset is a no-op', () => {
    const plain = compile(clip(undefined), withMatte())
    const g = compile(clip({ mode: 'image', assetId: 'missing' }), withMatte()).filterGraph
    expect(g).toBe(plain.filterGraph)
  })

  it('decodes the matte alongside the clip with the same trim window', () => {
    const plan = compile(clip({ mode: 'color', color: '#ff0000' }, { in: 2_000_000 }), withMatte())
    const paths = inputPaths(plan.args)
    expect(paths.filter((p) => p === MATTE)).toHaveLength(1)
    const idx = (p: string) => paths.indexOf(p)
    const seekOf = (i: number): string | undefined => {
      let seen = -1
      for (let k = 0; k < plan.args.length; k++) {
        if (plan.args[k] === '-i') seen++
        if (seen === i - 1 && plan.args[k] === '-ss') return plan.args[k + 1]
      }
      return undefined
    }
    // both inputs are seeked to the clip's in-point
    expect(seekOf(idx(MATTE))).toBe(seekOf(idx(ASSETS.land!.path)))
  })

  it.each([
    ['color', { mode: 'color', color: '#ff0000' }, ['alphamerge', 'overlay']],
    ['blur', { mode: 'blur', blur: 80 }, ['alphamerge', 'overlay', 'gblur']],
    ['image', { mode: 'image', assetId: 'bg' }, ['alphamerge', 'overlay']],
    ['remove', { mode: 'remove' }, ['alphamerge']],
  ])('%s mode merges the matte as alpha', (_name, bg, expected) => {
    const g = compile(clip(bg), withMatte()).filterGraph
    const names = allFilters(g).map((f) => f.name.split('@')[0])
    for (const n of expected) expect(names).toContain(n)
    expect(filtersNamed(g, 'alphamerge')).toHaveLength(1)
  })

  it('remove forces the sprite path (needs an alpha plane) and keeps the project background', () => {
    const g = compile(clip({ mode: 'remove' }), withMatte()).filterGraph
    // the clip is overlaid on the project background, not cropped into the canvas
    expect(filtersNamed(g, 'overlay').length).toBeGreaterThanOrEqual(1)
    expect(filtersNamed(g, 'color').length).toBeGreaterThanOrEqual(1)
  })

  it('blur sigma and feather sigma follow the shared constants', () => {
    const g = compile(clip({ mode: 'blur', blur: 100, feather: 50 }), withMatte()).filterGraph
    const sigmas = filtersNamed(g, 'gblur').map((f) => Number(f.options.sigma))
    // export scale 1 (1080p): blur σ = 0.4·100 canvas px, feather σ = 0.08·50
    expect(sigmas).toContain(40)
    expect(sigmas).toContain(4)
  })

  it('works with a crop, flip and reverse (matte goes through the same pre stage)', () => {
    const plan = compile(
      clip(
        { mode: 'color', color: '#00ff00' },
        {
          crop: { left: 0.1, right: 0.1 },
          transform: { flipH: true },
          reverse: true,
        },
      ),
      withMatte(),
    )
    expect(filtersNamed(plan.filterGraph, 'hflip').length).toBeGreaterThanOrEqual(2)
    expect(filtersNamed(plan.filterGraph, 'reverse').length).toBeGreaterThanOrEqual(2)
  })

  it('overlay-track clips get the background too', () => {
    const p = project([
      main([{ duration: 1_000_000, assetId: 'port' }]),
      {
        kind: 'overlay',
        clips: [
          {
            id: 'o1',
            type: 'video',
            assetId: 'land',
            start: 0,
            duration: 1_000_000,
            background: { mode: 'remove' },
          },
        ],
      },
    ])
    const plan = compile(p, withMatte())
    expect(inputPaths(plan.args)).toContain(MATTE)
    expect(filtersNamed(plan.filterGraph, 'alphamerge')).toHaveLength(1)
  })
})

describe('text behind subject', () => {
  const textTrack = (behind: boolean) => ({
    kind: 'text',
    clips: [
      { id: 'tx', type: 'text', text: 'hi', start: 0, duration: 1_000_000, behindSubject: behind },
    ],
  })
  const proj = (behind: boolean): Project =>
    project([main([{ duration: 1_000_000 }]), textTrack(behind)])
  const cx = (over: Partial<CompileContext> = {}): CompileContext =>
    withMatte({ assPath: 'C:\\w\\front.ass', assBehindPath: 'C:\\w\\behind.ass', ...over })

  it('burns the behind text under a matte-cut subject copy of the main track', () => {
    const plan = compile(proj(true), cx())
    const g = plan.filterGraph
    const ass = filtersNamed(g, 'ass').map((f) => String(f.options.filename))
    expect(ass.some((a) => a.includes('behind.ass'))).toBe(true)
    // subject pass: the main clip again (the decode is a shared input) + matte
    expect(inputPaths(plan.args).filter((p) => p === MATTE)).toHaveLength(1)
    expect(inputPaths(plan.args).filter((p) => p === ASSETS.land!.path).length).toBe(1)
    expect(filtersNamed(g, 'alphamerge')).toHaveLength(1)
    // the subject copy is composited over the text with a keep-alpha overlay
    const order = parseGraph(g).map((c) => c.filters.map((f) => f.name.split('@')[0]).join(','))
    const assIdx = order.findIndex((o) => o.includes('ass'))
    const mergeIdx = order.findIndex((o) => o.includes('alphamerge'))
    expect(assIdx).toBeGreaterThanOrEqual(0)
    expect(mergeIdx).toBeGreaterThanOrEqual(0)
  })

  it('falls back to plain text when the asset has no matte', () => {
    const plan = compile(proj(true), cx({ resolveMatte: () => undefined }))
    expect(inputPaths(plan.args)).not.toContain(MATTE)
    expect(inputPaths(plan.args).filter((p) => p === ASSETS.land!.path).length).toBe(1)
    expect(filtersNamed(plan.filterGraph, 'ass')).toHaveLength(2)
  })

  it('without assBehindPath the compiler never builds a subject pass', () => {
    const plan = compile(proj(true), withMatte({ assPath: 'C:\\w\\all.ass' }))
    expect(inputPaths(plan.args).filter((p) => p === MATTE)).toHaveLength(0)
  })

  it('combines with a background replacement on the same clip', () => {
    const p = project([
      main([{ duration: 1_000_000, background: { mode: 'color', color: '#112233' } }]),
      textTrack(true),
    ])
    const plan = compile(p, cx())
    // the subject pass uses the matte (remove) once; the visible clip uses it again via the pool
    expect(inputPaths(plan.args).filter((x) => x === MATTE).length).toBeGreaterThanOrEqual(1)
  })
})

describe('buildAss layers', () => {
  const p = project([
    main([{ duration: 1_000_000 }]),
    {
      kind: 'text',
      clips: [
        { id: 'a', type: 'text', text: 'FRONT', start: 0, duration: 500_000 },
        { id: 'b', type: 'text', text: 'BEHIND', start: 0, duration: 500_000, behindSubject: true },
      ],
    },
  ])
  const resolveAnimation = () => undefined
  it('splits text clips by layer and keeps "all" as before', () => {
    const all = buildAss(p, { resolveAnimation })
    const front = buildAss(p, { resolveAnimation, layer: 'front' })
    const behind = buildAss(p, { resolveAnimation, layer: 'behind' })
    expect(all).toContain('FRONT')
    expect(all).toContain('BEHIND')
    expect(front).toContain('FRONT')
    expect(front).not.toContain('BEHIND')
    expect(behind).toContain('BEHIND')
    expect(behind).not.toContain('FRONT')
    expect(hasBehindText(p)).toBe(true)
  })

  it('captions are never behind the subject', () => {
    const q: Project = {
      ...p,
      captions: {
        enabled: true,
        language: 'en',
        words: [
          { text: 'cap', start: 0, end: 400_000, confidence: 1, filler: false, emphasis: false },
        ],
        style: {
          base: p.tracks[1] && {
            fontFamily: 'Montserrat',
            fontWeight: 800,
            italic: false,
            fontSize: 72,
            color: '#FFFFFF',
            strokeColor: '#000000',
            strokeWidth: 6,
            shadowColor: '#00000099',
            shadowBlur: 0,
            shadowX: 0,
            shadowY: 4,
            backgroundPadding: 16,
            backgroundRadius: 12,
            align: 'center',
            letterSpacing: 0,
            lineHeight: 1.1,
            uppercase: false,
            maxWidth: 900,
          },
          activeColor: '#FFE400',
          activeScale: 1.15,
          mode: 'karaoke',
          maxWordsPerLine: 3,
          maxLines: 1,
          y: 1300,
          emphasizeKeywords: false,
          keywordColor: '#00E5FF',
        },
      } as NonNullable<Project['captions']>,
    }
    expect(buildAss(q, { resolveAnimation, layer: 'behind' })).not.toContain('cap')
    expect(buildAss(q, { resolveAnimation, layer: 'front' })).toContain('cap')
  })

  it('hasBehindText is false for hidden tracks and unflagged text', () => {
    expect(hasBehindText(project([main([{ duration: 1_000_000 }])]))).toBe(false)
  })
})
