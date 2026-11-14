/** Flat libass font directory materialised from `<packs>/fonts/<Family>/*`. */
import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../../src/config.ts'
import { flatFontsDir } from '../../src/packs/fonts.ts'
import { realToolchain, tempDir } from '../helpers.ts'

const exec = promisify(execFile)

const writeTree = async (packs: string, files: Record<string, string>): Promise<void> => {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(packs, 'fonts', rel)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
  }
}

describe('flatFontsDir', () => {
  let root: string
  let cleanup: () => Promise<void>
  beforeEach(async () => {
    ;({ dir: root, cleanup } = await tempDir('rf-fonts-'))
  })
  afterEach(() => cleanup())

  it('links every font of every family into one directory, skipping non-fonts', async () => {
    const packs = path.join(root, 'tree-a')
    await writeTree(packs, {
      'Bebas Neue/BebasNeue-Regular.ttf': 'bebas',
      'Bebas Neue/OFL.txt': 'licence',
      'Inter/Inter-Bold.otf': 'inter',
      'Inter/x.TTF': 'x1',
      'Rubik/x.ttf': 'x2', // same file name in another family
      'stray.ttf': 'not inside a family',
    })
    const dir = await flatFontsDir({ root, packs })
    expect(path.dirname(dir)).toBe(path.join(root, 'fonts-flat'))
    const names = (await readdir(dir)).filter((n) => !n.startsWith('.')).toSorted()
    expect(names).toEqual(['BebasNeue-Regular.ttf', 'Inter-Bold.otf', 'Rubik__x.ttf', 'x.TTF'])
    expect(await readFile(path.join(dir, 'Rubik__x.ttf'), 'utf8')).toBe('x2')
    expect(await readFile(path.join(dir, 'x.TTF'), 'utf8')).toBe('x1')
    // Hard links on the same volume: no extra disk space.
    const src = await stat(path.join(packs, 'fonts', 'Inter', 'Inter-Bold.otf'))
    expect((await stat(path.join(dir, 'Inter-Bold.otf'))).ino).toBe(src.ino)
  })

  it('shares concurrent builds and reuses a finished directory', async () => {
    const packs = path.join(root, 'tree-a')
    await writeTree(packs, { 'Inter/Inter.ttf': 'i' })
    const [a, b] = await Promise.all([flatFontsDir({ root, packs }), flatFontsDir({ root, packs })])
    expect(a).toBe(b)
    const t0 = performance.now()
    expect(await flatFontsDir({ root, packs })).toBe(a)
    expect(performance.now() - t0).toBeLessThan(50)
  })

  it('gives each pack tree its own directory and collects ones whose tree is gone', async () => {
    const old = path.join(root, 'tree-old')
    const next = path.join(root, 'tree-new')
    await writeTree(old, { 'Inter/Inter.ttf': 'old' })
    await writeTree(next, { 'Inter/Inter.ttf': 'new' })
    const oldDir = await flatFontsDir({ root, packs: old })
    // The old tree is garbage-collected by the packs service after a sync.
    await rename(old, path.join(root, 'gone'))
    const newDir = await flatFontsDir({ root, packs: next })
    expect(newDir).not.toBe(oldDir)
    expect(await readFile(path.join(newDir, 'Inter.ttf'), 'utf8')).toBe('new')
    expect(await readdir(path.join(root, 'fonts-flat'))).toEqual([path.basename(newDir)])
  })

  it('returns an empty directory when the tree has no fonts', async () => {
    const dir = await flatFontsDir({ root, packs: path.join(root, 'empty') })
    expect((await readdir(dir)).filter((n) => !n.startsWith('.'))).toEqual([])
  })

  it('libass finds the shipped pack fonts through the flat directory', async (ctx) => {
    const tools = await realToolchain()
    if (!tools) {
      console.warn('skipping libass font test: ffmpeg not found')
      return ctx.skip()
    }
    const dir = await flatFontsDir({ root, packs: path.join(REPO_ROOT, 'packs') })
    expect((await readdir(dir)).length).toBeGreaterThan(30)
    const ass = [
      '[Script Info]',
      'ScriptType: v4.00+',
      'PlayResX: 1080',
      'PlayResY: 1920',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, Bold',
      'Style: Default,Bebas Neue,120,&H00FFFFFF,0',
      '[Events]',
      'Format: Layer, Start, End, Style, Text',
      'Dialogue: 0,0:00:00.00,0:00:01.00,Default,HELLO',
    ].join('\n')
    await writeFile(path.join(root, 'test.ass'), ass)
    // Relative paths from cwd sidestep filter-graph escaping of drive colons.
    const { stderr } = await exec(
      tools.ffmpeg,
      [
        '-hide_banner',
        '-v',
        'verbose',
        '-f',
        'lavfi',
        '-i',
        'color=black:s=1080x1920:d=0.1',
        '-vf',
        `ass=test.ass:fontsdir=${path.relative(root, dir).replaceAll('\\', '/')}`,
        '-frames:v',
        '1',
        '-f',
        'null',
        '-',
      ],
      { cwd: root },
    )
    expect(stderr).toMatch(/fontselect: \(Bebas Neue, 400, 0\) -> .*BebasNeue-Regular/)
  })
})
