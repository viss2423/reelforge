import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { CaptionStylePreset, TemplatePreset, TextPreset } from '@reelforge/core'
import { PackManifest } from '@reelforge/core'
import { describe, expect, it } from 'vitest'
import { activeLocalDir, localPacksRoot, readLocalPack } from '../../src/packs/local.ts'
import { loadPackResolvers } from '../../src/render/packs.ts'
import { buildCatalogue } from '../../src/trends/catalogue.ts'
import { extractSignals } from '../../src/trends/extract.ts'
import { llmGenerate, remixTemplates } from '../../src/trends/generate.ts'
import { buildLivePack, sanityErrors } from '../../src/trends/livepack.ts'
import { parseRedditListing } from '../../src/trends/sources/reddit.ts'
import { realToolchain, tempDir } from '../helpers.ts'
import { BUNDLED, bundledPacks, fakeLlm, fixture } from './helpers.ts'

const NOV = new Date('2026-11-20T12:00:00')

const generated = async () => {
  const { manifests, index } = await bundledPacks()
  const cat = buildCatalogue(manifests, index)
  const signals = extractSignals(
    [{ source: 'reddit', items: parseRedditListing(fixture('reddit-top.json')) }],
    NOV,
  )
  const taken = new Set<string>()
  const gen = await llmGenerate({
    llm: fakeLlm(),
    cat,
    signals,
    taken,
    signal: new AbortController().signal,
  })
  const remixed = remixTemplates(cat, signals, taken, 1)
  return {
    manifests,
    index,
    fresh: {
      captionStyles: gen.captionStyles.map((g) => g.item),
      textPresets: gen.textPresets.map((g) => g.item),
      templates: [...gen.templates.map((g) => g.item), ...remixed.map((r) => r.item)],
    },
  }
}

describe('live pack', () => {
  it('validates, localises refs, drops bad items and swaps atomically', async () => {
    const { dir, cleanup } = await tempDir('rf-live-')
    try {
      const { manifests, index, fresh } = await generated()
      const root = localPacksRoot(dir)
      const res = await buildLivePack({
        root,
        base: { manifests, index, dir: BUNDLED },
        createdAt: new Map(),
        fresh,
        now: NOV,
        ffmpeg: 'ffmpeg',
        skipThumbs: true,
      })
      const m = res.manifest
      expect(m.id).toBe('trending-live')
      expect(m.version).toBe('2026.11.20')
      expect(m.curatedAt).toBe('2026-11-20')
      // "Way Too Short" is a 0.67 s template: rejected with a reason.
      expect(res.dropped).toEqual(
        expect.arrayContaining([expect.objectContaining({ ref: 'trending-live/way-too-short' })]),
      )
      expect(m.templates.map((t) => t.id)).toContain('snow-day-dump')
      expect(m.templates.every((t) => t.tags[0] === 'new')).toBe(true)
      // Every ref stays inside trending-live / essentials / builtin.
      const refs = [
        ...m.textPresets.flatMap((t) => [t.animationIn, t.animationOut, t.animationLoop]),
        ...m.templates.flatMap((t) => [
          t.captionStyle,
          ...t.slots.flatMap((s) => [s.filter, s.text?.preset, ...s.effects]),
        ]),
      ].filter((r): r is string => !!r)
      for (const r of refs) expect(r).toMatch(/^(trending-live|essentials|builtin)\//)
      // Borrowed items were copied in, LUT file included and hashed.
      expect(m.animations.map((a) => a.id)).toContain('punch-in')
      expect(m.effects.map((e) => e.id)).toContain('beat-punch')
      const frost = m.filters.find((f) => f.id === 'winter-frost')!
      expect(frost.lut).toBe('luts/winter-frost.cube')
      expect(m.files.map((f) => f.path)).toContain('luts/winter-frost.cube')
      // On disk behind the pointer, loadable like any pack.
      const active = await activeLocalDir(root)
      expect(active && res.dir.startsWith(active)).toBe(true)
      expect(await readLocalPack(active!, 'trending-live')).toEqual(m)
      expect(
        PackManifest.parse(JSON.parse(await readFile(path.join(res.dir, 'pack.json'), 'utf8'))),
      ).toEqual(m)
      // The export pipeline resolves live refs through the local tree.
      const resolvers = await loadPackResolvers(
        BUNDLED,
        ['trending-live/winter-frost'],
        undefined,
        [active!],
      )
      expect(resolvers.resolveLut('trending-live/winter-frost')).toBe(
        path.join(res.dir, 'luts', 'winter-frost.cube'),
      )
      expect(resolvers.resolveEffect('trending-live/beat-punch')?.effect).toBe('beatZoom')

      // Second run: previous items carried (no "new" tag), duplicates dropped, old tree gone.
      const createdAt = new Map(
        [...m.templates, ...m.textPresets, ...m.captionStyles].map((i) => [
          `trending-live/${i.id}`,
          NOV.toISOString(),
        ]),
      )
      const next = new Date(NOV.getTime() + 86_400_000)
      const res2 = await buildLivePack({
        root,
        base: { manifests, index, dir: BUNDLED },
        previous: m,
        previousDir: res.dir,
        createdAt,
        fresh: { captionStyles: [], textPresets: [], templates: [] },
        now: next,
        ffmpeg: 'ffmpeg',
        skipThumbs: true,
      })
      expect(res2.manifest.templates.map((t) => t.id)).toEqual(m.templates.map((t) => t.id))
      expect(res2.manifest.templates.some((t) => t.tags.includes('new'))).toBe(false)
      expect(res2.added).toEqual([])
      const dirs = (await readdir(root)).filter((d) => d.startsWith('v-'))
      expect(dirs).toHaveLength(1)
      expect(existsSync(res.dir)).toBe(false)

      // Items older than the carry window age out.
      const later = new Date(NOV.getTime() + 20 * 86_400_000)
      const res3 = await buildLivePack({
        root,
        base: { manifests, index, dir: BUNDLED },
        previous: res2.manifest,
        createdAt,
        fresh: { captionStyles: [], textPresets: [], templates: [] },
        now: later,
        ffmpeg: 'ffmpeg',
        skipThumbs: true,
      })
      expect(res3.manifest.templates).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('rejects duplicates of existing items and invalid refs/fonts', async () => {
    const { dir, cleanup } = await tempDir('rf-live-')
    try {
      const { manifests, index } = await bundledPacks()
      const trend = manifests.find((m) => m.id === 'trending-2026-11')!
      const copy = structuredClone(trend.captionStyles[0]!) as CaptionStylePreset
      const sameName = { ...structuredClone(trend.templates[1]!), id: 'other' } as TemplatePreset
      const badFont: TextPreset = {
        ...structuredClone(trend.textPresets[0]!),
        id: 'bad-font',
        name: 'Bad Font',
        style: { ...trend.textPresets[0]!.style, fontFamily: 'Nope Sans' },
      }
      const badRef: TemplatePreset = {
        ...structuredClone(trend.templates[0]!),
        id: 'bad-ref',
        name: 'Bad Ref',
        slots: trend.templates[0]!.slots.map((s) => ({
          ...s,
          effects: ['essentials/does-not-exist'],
        })),
      }
      const res = await buildLivePack({
        root: localPacksRoot(dir),
        base: { manifests, index, dir: BUNDLED },
        createdAt: new Map(),
        fresh: { captionStyles: [copy], textPresets: [badFont], templates: [sameName, badRef] },
        now: NOV,
        ffmpeg: 'ffmpeg',
        skipThumbs: true,
      })
      const reasons = Object.fromEntries(res.dropped.map((d) => [d.ref, d.reason]))
      expect(reasons[`trending-live/${copy.id}`]).toMatch(/duplicate/)
      expect(reasons['trending-live/other']).toMatch(/duplicate/)
      expect(reasons['trending-live/bad-font']).toMatch(/font/)
      expect(reasons['trending-live/bad-ref']).toMatch(/unresolved/)
      expect(res.added).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('sanity rules', () => {
    const m = PackManifest.parse({
      id: 'trending-live',
      version: '1.0.0',
      name: 'x',
      curatedAt: '2026-11-20',
      templates: [{ id: 't', name: 'T', slots: [{ duration: 100_000 }] }],
    })
    expect(sanityErrors(m).length).toBe(2)
  })
})

describe('live pack thumbnails (real FFmpeg)', async () => {
  const tools = await realToolchain()
  it.skipIf(!tools)('renders a thumbnail for every generated item', async () => {
    const { dir, cleanup } = await tempDir('rf-live-')
    try {
      const { manifests, index, fresh } = await generated()
      const t0 = performance.now()
      const res = await buildLivePack({
        root: localPacksRoot(dir),
        base: { manifests, index, dir: BUNDLED },
        createdAt: new Map(),
        fresh,
        now: NOV,
        ffmpeg: tools!.ffmpeg,
      })
      const ms = performance.now() - t0
      const m = res.manifest
      const thumbed = [...m.templates, ...m.textPresets, ...m.captionStyles, ...m.filters]
      expect(thumbed.length).toBeGreaterThan(4)
      for (const item of thumbed) {
        expect(item.thumb).toBeDefined()
        expect(existsSync(path.join(res.dir, item.thumb!))).toBe(true)
      }
      console.warn(
        `live pack with ${thumbed.length} thumbs in ${Math.round(ms)} ms (thumbs ${res.ms.thumbs} ms)`,
      )
    } finally {
      await cleanup()
    }
  })
})
