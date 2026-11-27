/**
 * The whole product on real media, end to end, driven through the UI against the real
 * server, real FFmpeg and real whisper.cpp:
 *
 *   upload two picture clips + a spoken clip (SAPI TTS) → main track; split + trim; text
 *   preset, transition and LUT filter; music upload; auto captions (whisper) → remove
 *   silences → beat sync; preview playback paints real pixels; 1080p GPU (AMF/NVENC/QSV when
 *   verified, else CPU) export → download → ffprobe (1080×1920, duration, audio, -14 LUFS)
 *   → captions and text are burned into the frames.
 *
 * One test per device project with steps (not serial tests), so a retry starts over with a
 * fresh project and fresh upload names instead of tripping over the first attempt's state.
 * Chromium projects only: Playwright's WebKit on Windows has no AudioContext/WebCodecs, so
 * the iPhone project gets the editor smoke test at the bottom instead.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { existsSync } from 'node:fs'
import type { APIRequestContext, Page, TestInfo } from '@playwright/test'
import { mainTrackLayout, projectDuration } from '@reelforge/core'
import type { Clip, Job, Project, Track } from '@reelforge/core'
import { openTool } from './dock.ts'
import { FLOW_MEDIA } from './env.ts'
import { createProject, expect, isDesktop, openMediaLibrary, test } from './fixtures.ts'
import { brightFraction, grayFrameAt, grayPng, integratedLoudness, probe } from './media.ts'
import { isTouch, pointer } from './pointer.ts'
import { aiUnavailable } from './tools.ts'

const US = 1_000_000

/* ------------------------------------------------------------------ API reads */

const getProject = async (request: APIRequestContext, id: string): Promise<Project> => {
  const res = await request.get(`/api/projects/${id}`)
  expect(res.ok(), `GET project → ${res.status()}`).toBe(true)
  return (await res.json()) as Project
}

const track = (p: Project, kind: Track['kind']): Track | undefined =>
  p.tracks.find((t) => t.kind === kind)
const mainClips = (p: Project): Clip[] => track(p, 'main')?.clips ?? []
const allClips = (p: Project, kind: Track['kind']): Clip[] =>
  p.tracks.filter((t) => t.kind === kind).flatMap((t) => t.clips)
const assetOf = (c: Clip): string | undefined => ('assetId' in c ? c.assetId : undefined)
const end = (c: Clip) => c.start + c.duration
/** Playback spans (transition overlaps applied) of the main-track pieces of one asset. */
const spansOf = (p: Project, assetId: string) =>
  mainTrackLayout(p).filter((e) => assetOf(e.clip) === assetId)

/** Waits until the editor has autosaved, then returns the server's copy of the project. */
const saved = async (page: Page, id: string): Promise<Project> => {
  await expect(page.getByTestId('sync')).toHaveAttribute('data-status', 'saved')
  return getProject(page.request, id)
}

/**
 * Polls the stored project until `check` holds (AI results land asynchronously). With
 * `task`, fails fast with the AI task's error instead of waiting out the timeout.
 */
const until = async (
  page: Page,
  id: string,
  what: string,
  check: (p: Project) => boolean,
  { timeout = 60_000, task }: { timeout?: number; task?: string } = {},
): Promise<Project> => {
  let last: Project | undefined
  await expect
    .poll(
      async () => {
        if (task) {
          const card = page.getByTestId(`task-${task}`)
          if ((await card.count()) && (await card.getAttribute('role')) === 'alert')
            throw new Error(`AI task ${task} failed: ${await card.innerText()}`)
        }
        last = await getProject(page.request, id)
        return check(last)
      },
      { message: what, timeout, intervals: [250, 500, 1000] },
    )
    .toBe(true)
  return last!
}

/* ------------------------------------------------------------------ UI helpers */

const unique = (info: TestInfo, base: string): string => {
  const ext = path.extname(base)
  const tag = `${info.project.name.replace(/\W+/g, '-').toLowerCase()}-r${info.retry}`
  return `${path.basename(base, ext)}-${tag}${ext}`
}

const fileFor = async (file: string, name: string, mimeType: string) => ({
  name,
  mimeType,
  buffer: await readFile(file),
})

/** Uploads through the media library and waits until the host has probed and proxied it. */
const uploadMedia = async (page: Page, file: string, name: string) => {
  const library = await openMediaLibrary(page)
  await library.getByTestId('library-upload').setInputFiles(await fileFor(file, name, 'video/mp4'))
  const tile = library.getByRole('button', { name: `Add ${name} to timeline` })
  await expect(tile).toHaveAttribute('data-ready', 'true', { timeout: 60_000 })
  await expect(tile).toHaveAttribute('data-proxy', 'ready', { timeout: 90_000 })
  return tile
}

/** Puts a library asset at the end of the main track. */
const appendToTimeline = async (page: Page, name: string) => {
  await page.keyboard.press('End') // the main track inserts at the playhead
  const library = await openMediaLibrary(page)
  await library.getByRole('button', { name: `Add ${name} to timeline` }).click()
  // Phones close the sheet once the clip is placed; let it finish before the next step.
  if (!isDesktop(page)) await expect(library).toBeHidden()
}

const tool = (page: Page, id: string) =>
  page.getByRole('toolbar', { name: 'Tools' }).locator(`[data-tool="${id}"]`)

/** Back to the root tools (clears the selection) when a clip is selected. */
const deselect = async (page: Page) => {
  // Phones show clip panels as sheets over the tool bar: Escape closes the open one first.
  if (!isDesktop(page)) await page.keyboard.press('Escape')
  const done = page.getByRole('toolbar', { name: 'Tools' }).getByRole('button', { name: 'Done' })
  if (await done.isVisible()) await done.click()
  await expect(tool(page, 'ai')).toBeVisible()
}

const clipEl = (page: Page, id: string) =>
  page.locator(`[data-testid="timeline-clip"][data-clip-id="${id}"]`)

/** Pans the timeline (wheel) until clip `id` is on screen. */
const reveal = async (page: Page, id: string) => {
  const vp = page.getByTestId('timeline-viewport')
  // The timeline only mounts clips near the view: pan (right, then back left) until it is.
  const v0 = (await vp.boundingBox())!
  const y0 = v0.y + v0.height / 2
  const touch = isTouch(page)
  if (!touch) await page.mouse.move(v0.x + v0.width / 2, y0)
  for (let i = 0; i < 30 && (await clipEl(page, id).count()) === 0; i++) {
    const dx = (i < 10 ? 1 : -1) * v0.width * 0.6
    // Phones pan with a finger (wheel is a mouse gesture), desktops with the wheel.
    if (touch) {
      const cx = v0.x + v0.width / 2
      await pointer(page, true).drag([cx + dx / 2, y0], [cx - dx / 2, y0])
    } else await page.mouse.wheel(dx, 0)
    await page.waitForTimeout(150)
  }
  for (let i = 0; i < 12; i++) {
    const v = (await vp.boundingBox())!
    const b = (await clipEl(page, id).boundingBox())!
    if (b.x >= v.x && b.x + b.width <= v.x + v.width) return
    const dx = b.x + b.width / 2 - (v.x + v.width / 2)
    if (b.width > v.width && Math.abs(dx) < 10) return
    await page.mouse.move(v.x + v.width / 2, v.y + v.height / 2)
    await page.mouse.wheel(dx, 0)
    await page.waitForTimeout(100)
  }
}

/** Selects a timeline clip with the platform's pointer (touch on phones). */
const selectClip = async (page: Page, id: string) => {
  const el = clipEl(page, id)
  await reveal(page, id)
  const b = (await el.boundingBox())!
  await pointer(page, isTouch(page)).tap(b.x + b.width / 2, b.y + b.height / 2)
  await expect(el).toHaveAttribute('data-selected', 'true')
}

/** Seeks by tapping the ruler above `fraction` of clip `id`'s span. */
const seekInto = async (page: Page, id: string, fraction: number) => {
  await reveal(page, id)
  const b = (await clipEl(page, id).boundingBox())!
  const ruler = (await page.getByTestId('timeline-ruler').boundingBox())!
  await pointer(page, isTouch(page)).tap(b.x + b.width * fraction, ruler.y + ruler.height / 2)
}

/** The Magic tile that holds each tool's start button. */
const MAGIC_TILE: Record<string, string> = {
  'Generate captions': 'Captions',
  'Find silences': 'Silences',
  'Sync to beat': 'Beat sync',
}

/**
 * Opens the Magic panel, opens the tool's tile and starts it; returns the task's row (which
 * fails fast with the task's error in `until`).
 */
const runAiTask = async (page: Page, button: string, task: string) => {
  await deselect(page)
  if ((await tool(page, 'ai').getAttribute('aria-pressed')) !== 'true')
    await tool(page, 'ai').click()
  const back = page.getByRole('button', { name: 'Back to Magic' })
  if (await back.isVisible()) await back.click()
  await page
    .getByRole('region', { name: 'Magic tools' })
    .getByRole('button', { name: MAGIC_TILE[button]!, exact: true })
    .click()
  await page.getByRole('button', { name: button, exact: true }).click()
  return page.getByTestId(`task-${task}`)
}

/* ------------------------------------------------------------------ the flow */

test.describe('full flow on real media', () => {
  test.skip(({ browserName }) => browserName === 'webkit', 'Chromium projects run the full flow')

  test('edit, AI, export and verify the MP4', async ({ pairedPage: page }, info) => {
    const missing =
      aiUnavailable() ??
      (existsSync(FLOW_MEDIA.speech) ? undefined : 'speech fixture needs Windows SAPI TTS')
    test.skip(missing !== undefined, missing)
    test.setTimeout(15 * 60_000)

    const names = {
      a: unique(info, 'flow-a.mp4'),
      b: unique(info, 'flow-b.mp4'),
      speech: unique(info, 'flow-speech.mp4'),
      music: unique(info, 'flow-music.m4a'),
    }
    const id = await createProject(page)
    const assetIds: Record<'a' | 'b' | 'speech', string> = { a: '', b: '', speech: '' }

    await test.step('upload two clips and a spoken clip; main track = speech, A, B', async () => {
      for (const k of ['speech', 'a', 'b'] as const) {
        const file = { a: FLOW_MEDIA.clipA, b: FLOW_MEDIA.clipB, speech: FLOW_MEDIA.speech }[k]
        await uploadMedia(page, file, names[k])
        // The library sheet stays open on phones after an upload; adding closes it.
        await appendToTimeline(page, names[k])
      }
      const p = await saved(page, id)
      const assets = (await (await page.request.get('/api/assets')).json()) as {
        id: string
        name: string
      }[]
      for (const k of ['a', 'b', 'speech'] as const)
        assetIds[k] = assets.find((a) => a.name === names[k])!.id
      expect(mainClips(p).map(assetOf)).toEqual([assetIds.speech, assetIds.a, assetIds.b])
      await expect(page.getByTestId('timeline-clip')).toHaveCount(3)
    })

    await test.step('preview paints real frames while playing', async () => {
      const a = mainClips(await getProject(page.request, id))[1]!
      await seekInto(page, a.id, 0.25)
      await page.getByTestId('play-toggle').click()
      await page.waitForTimeout(1200)
      const canvas = page.getByTestId('preview-canvas')
      await expect(page.getByTestId('preview-fallback')).toHaveCount(0)
      const shot = await grayPng(await canvas.screenshot(), 90, 160)
      await page.getByTestId('play-toggle').click()
      // testsrc2 is bright and colourful: most of a correctly drawn frame is far from black.
      expect(brightFraction(shot, 0, shot.height, 40)).toBeGreaterThan(0.3)
    })

    await test.step('split clip B at its middle and trim the tail', async () => {
      let p = await saved(page, id)
      const b = mainClips(p)[2]!
      await selectClip(page, b.id)
      await seekInto(page, b.id, 0.5)
      await tool(page, 'split').click()
      p = await until(page, id, 'B split in two', (q) => mainClips(q).length === 4)
      const tail = mainClips(p)[3]!
      expect(assetOf(tail)).toBe(assetIds.b)
      await deselect(page)

      await selectClip(page, tail.id)
      const box = (await clipEl(page, tail.id).boundingBox())!
      const y = box.y + box.height / 2
      const handle = box.x + box.width - 4
      await pointer(page, isTouch(page)).drag([handle, y], [handle - box.width * 0.4, y])
      p = await until(
        page,
        id,
        'tail trimmed',
        (q) => (mainClips(q)[3]?.duration ?? Infinity) < tail.duration - 0.2 * US,
      )
      await deselect(page)
    })

    await test.step('text preset over the speech, transition and filter on clip A', async () => {
      await page.keyboard.press('Home')
      await tool(page, 'text').click()
      const preset = page.locator('[data-testid^="text-preset-"]').first()
      await preset.click()
      let p = await until(page, id, 'text clip added', (q) => allClips(q, 'text').length === 1)
      expect(allClips(p, 'text')[0]).toMatchObject({ start: 0, presetRef: expect.any(String) })
      await deselect(page)

      const a = mainClips(p)[1]!
      await selectClip(page, a.id)
      await openTool(page, 'transition') // behind More on phones
      await page
        .getByRole('group', { name: 'Transitions' })
        .getByRole('button')
        .filter({ hasNotText: /none/i })
        .nth(1)
        .click()
      if (!isDesktop(page)) await page.keyboard.press('Escape') // the transition sheet
      await openTool(page, 'filter')
      await page
        .getByRole('group', { name: 'Filters' })
        .getByRole('button')
        .nth(1) // the first tile is "None"
        .click()
      p = await until(page, id, 'transition + filter on A', (q) => {
        const c = mainClips(q)[1]
        return !!c && 'filter' in c && !!c.filter && 'transitionIn' in c && !!c.transitionIn
      })
      await deselect(page)
    })

    await test.step('upload music to the audio track', async () => {
      await page.keyboard.press('Home')
      await tool(page, 'audio').click()
      await page.getByRole('tab', { name: 'Mine' }).click()
      await page
        .getByTestId('upload-music')
        .setInputFiles(await fileFor(FLOW_MEDIA.music, names.music, 'audio/mp4'))
      await until(
        page,
        id,
        'music clip on the timeline',
        (q) => allClips(q, 'audio').some((c) => c.type === 'audio' && c.role === 'music'),
        { timeout: 120_000 },
      )
      await deselect(page)
    })

    await test.step('auto captions with whisper.cpp', async () => {
      await runAiTask(page, 'Generate captions', 'captions')
      const p = await until(
        page,
        id,
        'captions generated',
        (q) => (q.captions?.words.length ?? 0) >= 10,
        { timeout: 300_000, task: 'captions' },
      )
      const text = p.captions!.words.map((w) => w.text.toLowerCase()).join(' ')
      // The TTS script's own words, recognised by whisper.
      expect(text).toMatch(/caption/)
      expect(text).toMatch(/music/)
    })

    let beforeSilence = 0
    await test.step('remove silences (review, then apply)', async () => {
      const p0 = await getProject(page.request, id)
      beforeSilence = projectDuration(p0)
      const card = await runAiTask(page, 'Find silences', 'silence')
      await expect(card.getByRole('button', { name: 'Apply' })).toBeVisible({ timeout: 120_000 })
      await card.getByRole('button', { name: 'Apply' }).click()
      const p = await until(
        page,
        id,
        'silences cut from the speech',
        (q) => mainClips(q).filter((c) => assetOf(c) === assetIds.speech).length >= 2,
      )
      // Two 1.5 s pauses (less the padding kept around speech) are gone.
      const speech = (q: Project) =>
        mainClips(q)
          .filter((c) => assetOf(c) === assetIds.speech)
          .reduce((n, c) => n + c.duration, 0)
      expect(speech(p0) - speech(p)).toBeGreaterThan(1.5 * US)
      // Captions follow the cut: none falls past the end of the last speech piece.
      const lastSpeech = spansOf(p, assetIds.speech).at(-1)!
      expect(Math.max(...p.captions!.words.map((w) => w.end))).toBeLessThanOrEqual(lastSpeech.end)
    })

    await test.step('beat sync to the music', async () => {
      await runAiTask(page, 'Sync to beat', 'beats')
      const p = await until(
        page,
        id,
        'beat markers and synced cuts',
        (q) => q.markers.filter((m) => m.kind === 'beat').length >= 8,
        { timeout: 120_000, task: 'beats' },
      )
      const beats = p.markers.filter((m) => m.kind === 'beat').map((m) => m.t)
      // 120 BPM click track: beats every 0.5 s.
      const gaps = beats.slice(1).map((t, i) => t - beats[i]!)
      const median = gaps.toSorted((x, y) => x - y)[gaps.length >> 1]!
      expect(Math.abs(median - 0.5 * US)).toBeLessThan(40_000)
      // Each cut (the transition midpoint where there is one) moved back onto a beat — except
      // past the end of the music, or in a piece too short to hold one.
      const frame = US / p.settings.fps
      const lastBeat = beats.at(-1)!
      const layout = mainTrackLayout(p)
      const cuts = layout.slice(0, -1).flatMap((e, k) => {
        const half = layout[k + 1]!.overlap / 2
        const cut = e.end - half
        const room = e.end - e.start - Math.max(frame, e.overlap) - 2 * half
        return cut <= lastBeat && room >= 0.6 * US ? [cut] : []
      })
      expect(cuts.length).toBeGreaterThan(0)
      for (const cut of cuts)
        expect(Math.min(...beats.map((t) => Math.abs(t - cut)))).toBeLessThanOrEqual(frame)
      // Cuts only ever shorten clips.
      expect(projectDuration(p)).toBeLessThan(beforeSilence)
    })

    const dir = await mkdtemp(path.join(tmpdir(), 'rf-flow-'))
    try {
      const final = await saved(page, id)
      const mp4 = path.join(dir, 'export.mp4')
      let jobId = ''
      const system = (await (await page.request.get('/api/system')).json()) as {
        toolchain: { hwEncoders?: Record<string, string | undefined> }
      }
      // The verified GPU encoder when the host has one (h264_amf on the reference laptop).
      const hwH264 = system.toolchain.hwEncoders?.h264

      await test.step('export 1080p on the GPU and download it', async () => {
        await deselect(page)
        await page.getByTestId('export-open').click()
        // Resolution, encoder and loudness live under Advanced.
        await page.getByRole('button', { name: 'Advanced', expanded: false }).click()
        await page.getByRole('radiogroup', { name: 'Resolution' }).getByText('1080p').click()
        const encoder = page.getByRole('radiogroup', { name: 'Encoder' })
        const gpu = encoder.getByRole('radio', { name: 'GPU' })
        if (hwH264) {
          await expect(page.getByText(`GPU encoding available (${hwH264})`)).toBeVisible()
          await gpu.click()
          await expect(gpu).toHaveAttribute('aria-checked', 'true')
        } else {
          await expect(page.getByText('This codec encodes on the CPU (slower)')).toBeVisible()
          await expect(gpu).toBeDisabled()
        }
        const loud = page.getByRole('checkbox', { name: /Normalize loudness/ })
        if (!(await loud.isChecked())) await loud.check()
        await page.getByTestId('export-start').click()
        const failed = page.getByTestId('export-failed')
        await expect(page.getByTestId('export-done').or(failed)).toBeVisible({ timeout: 300_000 })
        if (await failed.isVisible()) throw new Error(`export failed: ${await failed.innerText()}`)
        const href = (await page.getByTestId('export-download').getAttribute('href'))!
        jobId = /\/api\/exports\/([^/]+)\/file/.exec(href)![1]!
        const res = await page.request.get(href)
        expect(res.status()).toBe(200)
        await writeFile(mp4, await res.body())
      })

      await test.step('ffprobe: 1080×1920, duration, audio, loudness, encoder', async () => {
        const job = (await (await page.request.get(`/api/jobs/${jobId}`)).json()) as Job
        const result = job.result as { encoder?: string }
        expect(result.encoder).toBe(hwH264 ?? 'libx264')

        const meta = await probe(mp4)
        expect(meta.video).toMatchObject({ codec: 'h264', width: 1080, height: 1920 })
        expect(Math.abs(meta.duration - projectDuration(final) / US)).toBeLessThan(0.15)
        expect(meta.audio?.codec).toBe('aac')
        const lufs = await integratedLoudness(mp4)
        // Measurements for the run log (like the timeline perf spec).
        console.log(
          `full flow (${info.project.name}): ${JSON.stringify({ encoder: result.encoder, lufs, seconds: meta.duration })}`,
        )
        // The export default (and what the dialog promises): -14 LUFS, like Reels and TikTok.
        expect(Math.abs(lufs - -14)).toBeLessThan(1.5)
      })

      await test.step('captions and text are burned into the frames', async () => {
        // Clear of transitions: inside a speech piece, away from its edges.
        const speech = spansOf(final, assetIds.speech)
        const overSpeech = (t: number) =>
          speech.some((e) => t > e.start + 0.25 * US && t < e.end - 0.25 * US)
        const textClip = allClips(final, 'text')[0]!
        const inText = (t: number) => t >= textClip.start && t < end(textClip)
        // A caption word over the black speech picture, clear of the text clip.
        const word = final.captions!.words.find((w) => {
          const mid = (w.start + w.end) / 2
          return w.end - w.start > 150_000 && overSpeech(mid) && !inText(mid)
        })
        expect(word, 'a caption word over the speech, after the text clip').toBeDefined()
        const captionAt = (word!.start + word!.end) / 2 / US
        const y = final.captions!.style.y
        const cap = await grayFrameAt(mp4, captionAt, 270, 480)
        const band = (f: typeof cap, cy: number, half: number) =>
          brightFraction(f, ((cy - half) / 1920) * f.height, ((cy + half) / 1920) * f.height)
        // Black picture: anything bright in the caption band is the burned-in caption.
        expect(band(cap, y, 120)).toBeGreaterThan(0.01)
        // …and the top of the frame (no overlays there) stays black.
        expect(brightFraction(cap, 0, cap.height * 0.2)).toBeLessThan(0.002)

        // The text preset sits mid-frame over the speech in its first seconds.
        const textAt = Math.min(end(textClip), speech[0]!.end) / 2 / US
        const txt = await grayFrameAt(mp4, textAt, 270, 480)
        expect(band(txt, 960, 300)).toBeGreaterThan(0.005)
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

/* ------------------------------------------------------------------ WebKit smoke */

test.describe('editor on WebKit', () => {
  test.skip(({ browserName }) => browserName !== 'webkit', 'WebKit-only smoke test')

  test('loads the editor with media without page errors', async ({ pairedPage: page }, info) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => {
      // WebKit doesn't know the `interactive-widget` viewport key (Chromium's keyboard
      // resize mode) and says so; it is ignored there by design.
      if (m.type() === 'error' && !m.text().includes('interactive-widget')) errors.push(m.text())
    })
    page.on('response', (r) => {
      if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`)
    })
    await createProject(page)
    const name = unique(info, 'flow-a.mp4')
    await uploadMedia(page, FLOW_MEDIA.clipA, name)
    await appendToTimeline(page, name)
    await expect(page.getByTestId('timeline-clip')).toHaveCount(1)
    await expect(page.getByTestId('sync')).toHaveAttribute('data-status', 'saved')
    await page.reload()
    await expect(page.getByTestId('timeline-clip')).toHaveCount(1)
    await expect(page.getByTestId('preview-canvas')).toBeVisible()
    if (isDesktop(page)) await expect(page.getByRole('region', { name: 'Media' })).toBeVisible()
    // Playwright's Windows WebKit build ships without Web Audio (real Safari has it); the
    // preview reports that one limitation, anything else is a bug.
    const unexpected = errors.filter((e) => !/AudioContext|webkitAudioContext/.test(e))
    expect(unexpected).toEqual([])
  })
})
