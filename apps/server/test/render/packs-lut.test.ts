import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bakeLutMix,
  formatCube,
  mixWithIdentity,
  parseCube,
  quantizeIntensity,
} from '../../src/render/lut.ts'
import {
  BUNDLED_PACKS,
  loadPackResolvers,
  parseRef,
  projectRefs,
  resolvePacksRoot,
} from '../../src/render/packs.ts'
import { projectAssetIds } from '../../src/render/assets.ts'
import { hasText } from '../../src/render/pipeline.ts'
import { cube, makeProject } from './harness.ts'

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'rf-packs-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('cube LUTs', () => {
  const invert = cube(3, (r, g, b) => [1 - r, 1 - g, 1 - b])

  it('parses size, domain and data in .cube order', () => {
    const lut = parseCube(`TITLE "x"\n# comment\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n${invert}`)
    expect(lut.size).toBe(3)
    expect(lut.data).toHaveLength(81)
    expect(Array.from(lut.data.subarray(0, 3))).toEqual([1, 1, 1])
    // index 1 = r=0.5
    expect(Array.from(lut.data.subarray(3, 6))).toEqual([0.5, 1, 1])
  })

  it('rejects malformed files', () => {
    expect(() => parseCube('0 0 0\n')).toThrow(/before LUT_3D_SIZE/)
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0 0\n')).toThrow(/incomplete/)
    expect(() => parseCube('LUT_3D_SIZE 1\n')).toThrow(/bad size/)
    expect(() => parseCube('LUT_1D_SIZE 16\n')).toThrow(/1D/)
    expect(() => parseCube(`LUT_3D_SIZE 2\n${'0 0 x\n'.repeat(8)}`)).toThrow(/non-numeric/)
  })

  it('mixes with identity linearly (0 = identity, 1 = LUT)', () => {
    const lut = parseCube(invert)
    const id = mixWithIdentity(lut, 0)
    const half = mixWithIdentity(lut, 0.5)
    const full = mixWithIdentity(lut, 1)
    expect([...full.data]).toEqual([...lut.data])
    // identity at r=0.5,g=0,b=0 (index 1)
    expect(Array.from(id.data.subarray(3, 6))).toEqual([0.5, 0, 0])
    for (const v of half.data) expect(v).toBeCloseTo(0.5, 6)
  })

  it('honours custom domains', () => {
    const lut = parseCube(
      `LUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2\n${'0 0 0\n'.repeat(8)}`,
    )
    const id = mixWithIdentity(lut, 0)
    expect(Array.from(id.data.subarray(-3))).toEqual([2, 2, 2])
  })

  it('formats and re-parses losslessly (6 decimals)', () => {
    const lut = mixWithIdentity(parseCube(invert), 0.3)
    const again = parseCube(formatCube(lut))
    expect(again.size).toBe(3)
    for (let i = 0; i < lut.data.length; i++) expect(again.data[i]).toBeCloseTo(lut.data[i]!, 5)
  })

  it('quantises intensity to 1 %', () => {
    expect(quantizeIntensity(0.504)).toBe(0.5)
    expect(quantizeIntensity(0.505)).toBe(0.51)
  })

  it('bakes once per (source, mtime, intensity) and re-bakes edited LUTs', async () => {
    const src = path.join(dir, 'inv.cube')
    const cache = path.join(dir, 'cache')
    await writeFile(src, invert)
    const a = await bakeLutMix(src, 0.5, cache)
    const b = await bakeLutMix(src, 0.501, cache)
    expect(b).toBe(a)
    const baked = parseCube(await readFile(a, 'utf8'))
    for (const v of baked.data) expect(v).toBeCloseTo(0.5, 5)
    await utimes(src, new Date(), new Date(Date.now() + 5000))
    const c = await bakeLutMix(src, 0.5, cache)
    expect(c).not.toBe(a)
    expect((await readdir(cache)).filter((f) => f.endsWith('.part'))).toEqual([])
  })
})

describe('pack refs and resolvers', () => {
  it('parses refs safely', () => {
    expect(parseRef('trend-2026/teal')).toEqual({ packId: 'trend-2026', itemId: 'teal' })
    expect(parseRef('a/b/c')).toEqual({ packId: 'a', itemId: 'b/c' })
    expect(parseRef('noslash')).toBeUndefined()
    expect(parseRef('/x')).toBeUndefined()
    expect(parseRef('a/')).toBeUndefined()
    expect(parseRef('../x/y')).toBeUndefined()
  })

  it('collects every ref, asset id and text presence from a project', () => {
    const p = makeProject([
      {
        kind: 'main',
        clips: [
          {
            id: 'c',
            type: 'video',
            assetId: 'v1',
            start: 0,
            duration: 1,
            filter: { ref: 'p/lut' },
            effects: [{ id: 'e', ref: 'p/shake' }],
          },
        ],
      },
      {
        kind: 'overlay',
        clips: [
          {
            id: 's',
            type: 'sticker',
            ref: 'p/star',
            start: 0,
            duration: 1,
            animationIn: { ref: 'builtin/pop' },
          },
          { id: 's2', type: 'sticker', assetId: 'img1', start: 1, duration: 1 },
        ],
      },
      {
        kind: 'text',
        clips: [
          {
            id: 't',
            type: 'text',
            text: '  ',
            start: 0,
            duration: 1,
            animationLoop: { ref: 'q/wiggle' },
          },
        ],
      },
      { kind: 'audio', clips: [{ id: 'a', type: 'audio', assetId: 'm1', start: 0, duration: 1 }] },
    ])
    expect([...projectRefs(p)].toSorted()).toEqual([
      'builtin/pop',
      'p/lut',
      'p/shake',
      'p/star',
      'q/wiggle',
    ])
    expect([...projectAssetIds(p)].toSorted()).toEqual(['img1', 'm1', 'v1'])
    expect(hasText(p)).toBe(false) // whitespace-only text draws nothing
    const withCaptions = makeProject([], {
      captions: { words: [{ text: 'hi', start: 0, end: 1 }], style: { base: {} } },
    })
    expect(hasText(withCaptions)).toBe(true)
  })

  it('resolves LUTs, stickers, effects and animations from pack manifests', async () => {
    const root = path.join(dir, 'packs1')
    await mkdir(path.join(root, 'p'), { recursive: true })
    await mkdir(path.join(root, 'fonts'), { recursive: true })
    await writeFile(
      path.join(root, 'p', 'pack.json'),
      JSON.stringify({
        id: 'p',
        version: '1.0.0',
        name: 'P',
        curatedAt: '2026-01-01',
        filters: [
          { id: 'lut', name: 'L', lut: 'luts/l.cube' },
          { id: 'evil', name: 'E', lut: '../../../etc/passwd' },
        ],
        stickers: [{ id: 'star', name: 'S', file: 'stickers/star.png', width: 10, height: 10 }],
        effects: [{ id: 'shake', name: 'Shake', effect: 'shake', params: { amplitude: 30 } }],
        animations: [
          { id: 'pop', name: 'Pop', kind: 'in', tracks: { scale: [{ t: 0, value: 0 }] } },
        ],
      }),
    )
    await mkdir(path.join(root, 'broken'), { recursive: true })
    await writeFile(path.join(root, 'broken', 'pack.json'), '{"id": 5}')
    const warnings: unknown[] = []
    const log = { info() {}, debug() {}, error() {}, warn: (o: unknown) => warnings.push(o) }
    const r = await loadPackResolvers(root, ['p/lut', 'broken/x', 'missing/y', 'builtin/fade'], log)
    expect(r.root).toBe(root)
    expect(r.resolveLut('p/lut')).toBe(path.join(root, 'p', 'luts', 'l.cube'))
    expect(r.resolveLut('p/evil')).toBeUndefined()
    expect(r.resolveLut('p/none')).toBeUndefined()
    expect(r.resolveSticker('p/star')).toBe(path.join(root, 'p', 'stickers', 'star.png'))
    expect(r.resolveEffect('p/shake')).toMatchObject({ effect: 'shake', params: { amplitude: 30 } })
    expect(r.resolveAnimation('p/pop')).toMatchObject({ kind: 'in' })
    expect(r.resolveAnimation('builtin/fade')).toMatchObject({ id: 'fade', kind: 'in' })
    expect(r.resolveAnimation('builtin/nope')).toBeUndefined()
    expect(r.resolveLut('broken/x')).toBeUndefined()
    expect(r.resolveLut('missing/y')).toBeUndefined()
    // Invalid and missing manifests are logged, never fatal.
    expect(warnings).toHaveLength(2)
  })

  it('picks the active synced tree, the given tree, or the bundled packs', async () => {
    const synced = path.join(dir, 'synced')
    await mkdir(path.join(synced, 'v2', 'fonts'), { recursive: true })
    await writeFile(path.join(synced, 'active.json'), JSON.stringify({ dir: 'v2' }))
    expect(await resolvePacksRoot(synced)).toBe(path.join(synced, 'v2'))
    // Pointer escaping the dir is ignored.
    const evil = path.join(dir, 'evil')
    await mkdir(path.join(evil, 'fonts'), { recursive: true })
    await writeFile(path.join(evil, 'active.json'), JSON.stringify({ dir: '../synced' }))
    expect(await resolvePacksRoot(evil)).toBe(evil)
    const empty = path.join(dir, 'empty')
    await mkdir(empty)
    const fallback = await resolvePacksRoot(empty)
    expect([BUNDLED_PACKS, empty]).toContain(fallback)
  })
})
