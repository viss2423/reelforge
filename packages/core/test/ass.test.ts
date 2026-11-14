import { describe, expect, it } from 'vitest'
import {
  AnimationPreset,
  BUILTIN_ANIMATIONS,
  CaptionStyle,
  Word,
  addTrack,
  buildAss,
  insertTextClip,
} from '../src/index.ts'
import { project } from './helpers.ts'
import {
  ass,
  captionProject,
  captionWords,
  checkAss,
  cs,
  dialogues,
  plainText,
  resolve,
  textProject,
} from './ass-fixtures.ts'

const MODES = CaptionStyle.shape.mode.unwrap().options

describe('document', () => {
  it('has the required script info and is valid for an empty project', () => {
    const out = ass(project())
    expect(out.startsWith('[Script Info]\n')).toBe(true)
    expect(checkAss(out)).toEqual([])
    expect(dialogues(out)).toEqual([])
    expect(out).toContain('Title: Test')
  })

  it('makes the title field-safe', () => {
    const p = project()
    p.name = 'a,b\nc'
    expect(ass(p)).toContain('Title: a b c')
  })

  it('is deterministic', () => {
    const { p, clip } = textProject({ text: 'Spin me' })
    clip.animationIn = { ref: 'builtin/spin', duration: 500_000 }
    p.captions = captionProject().captions
    expect(ass(p)).toBe(ass(structuredClone(p)))
  })
})

describe('text clips', () => {
  it('a static clip is one event per line and pass, centred with \\pos', () => {
    const { p } = textProject({ text: 'Hello' })
    const ds = dialogues(ass(p))
    expect(ds).toHaveLength(1)
    expect(ds[0]).toMatchObject({ start: '0:00:00.00', end: '0:00:02.00' })
    expect(ds[0]!.text).toBe('{\\q2\\pos(540,960)\\xshad0\\yshad4}Hello')
  })

  it('wraps long text into separately positioned lines spaced by lineHeight', () => {
    const { p } = textProject({
      text: 'This sentence is definitely far too long for one line',
      style: { fontSize: 100, lineHeight: 1.2, maxWidth: 600 },
    })
    const ds = dialogues(ass(p))
    expect(ds.length).toBeGreaterThan(2)
    const ys = ds.map((d) => Number(/\\pos\(540,([\d.]+)\)/.exec(d.text)![1]))
    for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!).toBeCloseTo(120, 6)
    expect((ys[0]! + ys.at(-1)!) / 2).toBeCloseTo(960, 6)
  })

  it('emits box, soft shadow and main passes on consecutive layers', () => {
    const { p } = textProject({
      style: { backgroundColor: '#000000AA', shadowBlur: 6, shadowX: 3, shadowY: 3 },
    })
    const out = ass(p)
    const ds = dialogues(out)
    expect(ds.map((d) => d.layer)).toEqual([3, 4, 5])
    expect(ds[0]!.text).not.toContain('\\clip') // single line: no band clip
    expect(ds[1]!.text).toContain('\\pos(543,963)') // shadow offset
    expect(ds[1]!.text).toContain('\\blur')
    expect(out).toMatch(
      /Style: S1,Montserrat,72,&HFF000000,&HFF000000,&H55000000,&HFF000000,800,0,0,0,100,100,0,0,3,16,/,
    )
  })

  it('maps alignment to the anchor and left/right edges of the block', () => {
    const left = dialogues(ass(textProject({ style: { align: 'left' } }).p))[0]!.text
    const right = dialogues(ass(textProject({ style: { align: 'right' } }).p))[0]!.text
    const lx = Number(/\\pos\(([\d.]+),/.exec(left)![1])
    const rx = Number(/\\pos\(([\d.]+),/.exec(right)![1])
    expect(lx).toBeLessThan(540)
    expect(rx).toBeGreaterThan(540)
    expect(lx + rx).toBeCloseTo(1080, 6)
  })

  it('uppercases and escapes user text', () => {
    const { p } = textProject({ text: 'hi {there} \\N', style: { uppercase: true } })
    expect(plainText(dialogues(ass(p))[0]!.text)).toBe('HI {THERE} \\N')
  })

  it('animates transform keyframes with \\move and \\t, with \\org for rotation', () => {
    const { p, clip } = textProject()
    clip.transform.x.keyframes = [
      { t: 0, value: 340, easing: 'linear' },
      { t: 1_000_000, value: 740, easing: 'linear' },
    ]
    clip.transform.rotation.keyframes = [
      { t: 0, value: 0, easing: 'linear' },
      { t: 1_000_000, value: 90, easing: 'linear' },
    ]
    clip.transform.scale.keyframes = [
      { t: 0, value: 1, easing: 'linear' },
      { t: 1_000_000, value: 2, easing: 'linear' },
    ]
    const ds = dialogues(ass(p))
    const first = ds[0]!
    expect(first.text).toMatch(/\\move\(340,960,/)
    expect(first.text).toContain('\\org(')
    expect(first.text).toMatch(
      /\\t\(\\fscx[\d.]+\\fscy[\d.]+\\bord[\d.]+\\xshad[\d.]+\\yshad[\d.]+\\frz-[\d.]+\)/,
    )
    const last = ds.at(-1)!
    expect(last.text).toContain('\\pos(740,960)')
    expect(last.text).toContain('\\frz-90')
    expect(last.text).toContain('\\fscx200\\fscy200')
    // Slices tile the clip exactly.
    for (let i = 1; i < ds.length; i++) expect(ds[i]!.start).toBe(ds[i - 1]!.end)
    expect(checkAss(ass(p))).toEqual([])
  })

  it('applies flips, opacity and keeps linear motion in a single event', () => {
    const { p, clip } = textProject()
    clip.transform.flipH = true
    clip.transform.flipV = true
    clip.transform.opacity.value = 0.5
    clip.transform.y.keyframes = [
      { t: 0, value: 0, easing: 'linear' },
      { t: 2_000_000, value: 1920, easing: 'linear' },
    ]
    const ds = dialogues(ass(p))
    expect(ds).toHaveLength(1)
    expect(ds[0]!.text).toContain('\\fry180\\frx180')
    expect(ds[0]!.text).toContain('\\1a&H7F&')
    expect(ds[0]!.text).toContain('\\move(540,0,540,1920)')
  })

  it('follows eased curves closely with few slices', () => {
    const { p, clip } = textProject()
    clip.transform.y.keyframes = [
      { t: 0, value: 1500, easing: 'linear' },
      { t: 1_000_000, value: 500, easing: 'easeOutElastic' },
    ]
    const ds = dialogues(ass(p))
    expect(ds.length).toBeGreaterThan(5)
    expect(ds.length).toBeLessThan(80)
  })

  it('skips hidden tracks, empty text and orders layers by track', () => {
    const p = project()
    insertTextClip(p, { at: 0, text: 'bottom' })
    const top = addTrack(p, 'text')
    insertTextClip(p, { at: 0, text: 'top', trackId: top.id })
    insertTextClip(p, { at: 3_000_000, text: '   ', trackId: top.id })
    const hidden = addTrack(p, 'text')
    hidden.hidden = true
    insertTextClip(p, { at: 0, text: 'hidden', trackId: hidden.id })
    const ds = dialogues(ass(p))
    expect(ds.map((d) => [plainText(d.text), d.layer])).toEqual([
      ['bottom', 5],
      ['top', 11],
    ])
  })

  it('drops events outside the requested range', () => {
    const p = project()
    insertTextClip(p, { at: 0, duration: 1_000_000, text: 'early' })
    insertTextClip(p, { at: 5_000_000, duration: 1_000_000, text: 'late' })
    const out = buildAss(p, { ...resolve, range: { start: 4_000_000, end: 10_000_000 } })
    expect(dialogues(out).map((d) => plainText(d.text))).toEqual(['late'])
  })

  it('ignores clips shorter than a centisecond and unknown animation refs', () => {
    const { p, clip } = textProject()
    clip.duration = 4_000
    expect(dialogues(ass(p))).toEqual([])
    clip.duration = 1_000_000
    clip.animationIn = { ref: 'nope/x', duration: 300_000 }
    expect(dialogues(ass(p))).toHaveLength(1)
  })

  it.each(BUILTIN_ANIMATIONS.map((a) => a.id))(
    'builtin/%s produces a valid animated document',
    (id) => {
      const preset = BUILTIN_ANIMATIONS.find((a) => a.id === id)!
      const { p, clip } = textProject({
        text: 'Make it pop\nline two',
        style: { backgroundColor: '#00000080' },
      })
      const anim = { ref: `builtin/${id}`, duration: 500_000 }
      if (preset.kind === 'loop') clip.animationLoop = anim
      else {
        clip.animationIn = anim
        clip.animationOut = anim
      }
      const out = ass(p)
      expect(checkAss(out)).toEqual([])
      const ds = dialogues(out)
      expect(ds.length).toBeGreaterThan(3)
      // Slices of one layer are either the same interval (another line) or disjoint, and stay
      // inside the clip.
      const byLayer = new Map<number, Array<[number, number]>>()
      for (const d of ds) {
        const list = byLayer.get(d.layer) ?? []
        list.push([cs(d.start), cs(d.end)])
        byLayer.set(d.layer, list)
      }
      for (const list of byLayer.values()) {
        for (const [a, b] of list) {
          expect(a).toBeGreaterThanOrEqual(0)
          expect(b).toBeLessThanOrEqual(200)
          for (const [c, d] of list) {
            expect((a === c && b === d) || b <= c || d <= a).toBe(true)
          }
        }
      }
    },
  )

  it('typewriter reveals characters one by one inside the event', () => {
    const { p, clip } = textProject({ text: 'abc' })
    clip.animationIn = { ref: 'builtin/typewriter', duration: 300_000 }
    const first = dialogues(ass(p))[0]!
    // Every character is hidden first and switched visible at its own time.
    const reveals = [...first.text.matchAll(/\\t\((\d+),(\d+),\\1a&H00&/g)].map((m) => Number(m[2]))
    expect(reveals).toHaveLength(3)
    expect(reveals[0]).toBeLessThan(reveals[1]!)
    expect(reveals[1]).toBeLessThan(reveals[2]!)
    expect(plainText(first.text)).toBe('abc')
  })

  it('supports pack animations with custom tracks', () => {
    const preset = AnimationPreset.parse({
      id: 'drop',
      name: 'Drop',
      kind: 'in',
      tracks: {
        y: [
          { t: 0, value: -300 },
          { t: 1, value: 0, easing: 'easeOutBack' },
        ],
        rotation: [
          { t: 0, value: -20 },
          { t: 1, value: 0 },
        ],
      },
    })
    const { p, clip } = textProject()
    clip.animationIn = { ref: 'pack/drop', duration: 600_000 }
    const out = buildAss(p, {
      resolveAnimation: (ref) => (ref === 'pack/drop' ? preset : undefined),
    })
    expect(checkAss(out)).toEqual([])
    const ds = dialogues(out)
    expect(ds[0]!.text).toMatch(/\\move\(540,660,/)
    expect(ds[0]!.text).toContain('\\frz20')
    expect(ds.at(-1)!.text).toContain('\\pos(540,960)')
  })
})

describe('captions', () => {
  it('renders nothing when disabled or empty', () => {
    const p = captionProject()
    p.captions!.enabled = false
    expect(dialogues(ass(p))).toEqual([])
    p.captions!.enabled = true
    p.captions!.words = []
    expect(dialogues(ass(p))).toEqual([])
  })

  it('sits above every track at the caption y anchor', () => {
    const p = captionProject({ y: 1500 })
    addTrack(p, 'overlay')
    const ds = dialogues(ass(p))
    expect(new Set(ds.map((d) => d.layer))).toEqual(new Set([p.tracks.length * 3 + 2]))
    expect(ds[0]!.text).toContain('\\pos(540,1500)')
  })

  it('karaoke: the whole page is visible and the active word is coloured and scaled', () => {
    const ds = dialogues(ass(captionProject({ mode: 'karaoke', emphasizeKeywords: true })))
    expect(ds.slice(0, 3).map((d) => [d.start, d.end])).toEqual([
      ['0:00:00.00', '0:00:00.30'],
      ['0:00:00.30', '0:00:00.60'],
      ['0:00:00.60', '0:00:00.90'],
    ])
    expect(plainText(ds[0]!.text)).toBe('This is SO')
    expect(ds[0]!.text).toContain('{\\1c&H00E4FF&\\fscx115\\fscy115}This')
    // Keyword colour (#00E5FF) on SO when it is not active, active colour when it is.
    expect(ds[0]!.text).toContain('{\\1c&HFFE500&}SO')
    expect(ds[2]!.text).toContain('{\\1c&H00E4FF&\\fscx115\\fscy115}SO')
  })

  it('adjacent events never gap or overlap', () => {
    for (const mode of MODES) {
      const ds = dialogues(ass(captionProject({ mode })))
      const times = ds.map((d) => [cs(d.start), cs(d.end)] as const)
      for (let i = 1; i < times.length; i++) {
        const [s, e] = times[i]!
        const [ps, pe] = times[i - 1]!
        // Either the same interval (another line/pass) or exactly adjacent / later.
        expect(s === ps && e === pe ? true : s >= pe).toBe(true)
      }
    }
  })

  it('word-by-word and pop hide words that are not yet spoken', () => {
    for (const mode of ['word-by-word', 'pop'] as const) {
      const first = dialogues(ass(captionProject({ mode })))[0]!
      expect(plainText(first.text)).toBe('This is SO')
      expect(first.text).toMatch(/is.*\\1a&HFF&|\\1a&HFF&.*is/)
    }
    const pop = dialogues(ass(captionProject({ mode: 'pop' })))[0]!
    expect(pop.text).toMatch(
      /\\fscx63.25\\fscy63.25\\t\(0,90,\\fscx135.7\\fscy135.7\)\\t\(90,160,\\fscx115\\fscy115\)/,
    )
  })

  it('bounce oscillates the active word scale', () => {
    const first = dialogues(ass(captionProject({ mode: 'bounce' })))[0]!
    expect((first.text.match(/\\t\(/g) ?? []).length).toBe(4)
  })

  it('line mode shows each page as one event without highlight', () => {
    const ds = dialogues(ass(captionProject({ mode: 'line' })))
    expect(ds.map((d) => plainText(d.text))).toEqual(['This is SO', 'cool! 🔥', 'Watch this now'])
    expect(ds.every((d) => !d.text.includes('\\fscx115'))).toBe(true)
  })

  it('typewriter reveals the characters of each word across its duration', () => {
    const first = dialogues(ass(captionProject({ mode: 'typewriter' })))[0]!
    const reveals = [...first.text.matchAll(/\\t\((\d+),(\d+),/g)].map((m) => Number(m[2]))
    expect(reveals).toEqual(reveals.toSorted((a, b) => a - b))
    expect(reveals.length).toBe(3) // "This": the first character is visible immediately
    expect(Math.max(...reveals)).toBeLessThanOrEqual(250)
  })

  it('appends emojis and uppercases', () => {
    const ds = dialogues(ass(captionProject({ mode: 'line', base: { uppercase: true } })))
    expect(plainText(ds[1]!.text)).toBe('COOL! 🔥')
  })

  it('draws base and active boxes in the box pass with band clips for multi-line pages', () => {
    const p = captionProject({
      maxLines: 2,
      activeBackgroundColor: '#FF0000',
      base: { backgroundColor: '#000000AA' },
    })
    const ds = dialogues(ass(p)).filter((d) => d.start === '0:00:00.00')
    const box = ds.filter((d) => d.layer === p.tracks.length * 3)
    expect(box).toHaveLength(2)
    expect(box[0]!.text).toContain('\\clip(')
    expect(box[0]!.text).toContain('\\3c&H0000FF&')
    expect(box[0]!.text).toContain('\\3c&H000000&')
  })

  it('an active box alone (no base box) still uses the box pass', () => {
    const p = captionProject({ activeBackgroundColor: '#FF0000' })
    const layers = new Set(dialogues(ass(p)).map((d) => d.layer))
    expect(layers.has(p.tracks.length * 3)).toBe(true)
  })

  it('soft shadows get their own pass offset by the shadow vector', () => {
    const p = captionProject({ base: { shadowBlur: 10, shadowX: 4, shadowY: 6 } })
    const shadow = dialogues(ass(p)).find((d) => d.layer === p.tracks.length * 3 + 1)!
    expect(shadow.text).toContain('\\pos(544,1306)')
  })

  it('left-aligned pages anchor at the block edge', () => {
    const d = dialogues(ass(captionProject({ base: { align: 'left' } })))[0]!
    expect(Number(/\\pos\(([\d.]+),/.exec(d.text)![1])).toBeLessThan(540)
  })

  it('skips filler words', () => {
    const words = captionWords()
    words[1] = Word.parse({ ...words[1]!, filler: true })
    const first = dialogues(ass(captionProject({ mode: 'line' }, 'Montserrat', words)))[0]!
    expect(plainText(first.text)).toBe('This SO cool! 🔥')
  })
})

describe('snapshots', () => {
  it('text clip with box, shadow and pop/fade animations', () => {
    const { p, clip } = textProject({
      text: 'Snapshot me\nplease',
      style: { backgroundColor: '#000000AA', shadowBlur: 4, letterSpacing: 2 },
    })
    clip.animationIn = { ref: 'builtin/pop', duration: 300_000 }
    clip.animationOut = { ref: 'builtin/fade', duration: 300_000 }
    expect(ass(p)).toMatchSnapshot()
  })

  it.each(MODES)('captions in %s mode', (mode) => {
    expect(
      ass(captionProject({ mode, maxLines: 2, activeBackgroundColor: '#FF00FF80' })),
    ).toMatchSnapshot()
  })
})
