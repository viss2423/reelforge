/**
 * Timeline gestures in real browsers on every form factor: select, trim, reorder, split and
 * zoom (mouse + ctrl-wheel on desktop, touch + long-press + pinch on phones), plus a 200-clip
 * performance budget measured with the Performance API.
 *
 * The API is mocked with `page.route` / `page.routeWebSocket` (only the static app is needed
 * from the server), so these specs exercise the web app and the core ops it bundles, and
 * read edits back from the autosave `PUT` bodies.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { Asset, Project, sec, type Clip } from '@reelforge/core'
import { isTouch, pointer } from './pointer.ts'

const PROJECT_ID = 'tl-e2e'

const asset = Asset.parse({
  id: 'a1',
  kind: 'video',
  name: 'clip.mp4',
  size: 1000,
  mime: 'video/mp4',
  createdAt: '2026-01-01T00:00:00.000Z',
  duration: sec(20),
  width: 1080,
  height: 1920,
  hasVideo: true,
  hasAudio: false,
  proxy: 'ready',
})

/** A project whose main track holds `count` back-to-back 1 s clips (ids m0, m1, …). */
const makeProject = (count: number) =>
  Project.parse({
    id: PROJECT_ID,
    name: 'Timeline e2e',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    revision: 1,
    tracks: [
      {
        id: 'main',
        kind: 'main',
        clips: Array.from({ length: count }, (_, i) => ({
          id: `m${i}`,
          type: 'video',
          assetId: 'a1',
          start: sec(i),
          duration: sec(1),
          in: sec(i % 10),
        })),
      },
      { id: 'text', kind: 'text', clips: [] },
      { id: 'audio', kind: 'audio', clips: [] },
    ],
  })

interface Mock {
  /** Projects received by autosave, oldest first. */
  saves: Project[]
}

/** Serves the editor API for one project from memory. */
const mockApi = async (page: Page, project: Project, perf = false): Promise<Mock> => {
  const mock: Mock = { saves: [] }
  let revision = project.revision
  await page.addInitScript((enablePerf) => {
    localStorage.setItem('rf.token', 'e2e-token')
    localStorage.setItem('rf.deviceId', 'e2e-device')
    if (enablePerf) (globalThis as { __RF_PERF__?: boolean }).__RF_PERF__ = true
  }, perf)
  // Live-sync socket: accepted, never pushes (no other devices).
  await page.routeWebSocket(/\/api\/events/, () => undefined)
  await page.route(/\/api\//, async (route) => {
    const req = route.request()
    const { pathname } = new URL(req.url())
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (pathname === `/api/projects/${PROJECT_ID}`) {
      if (req.method() === 'PUT') {
        const body = req.postDataJSON() as { project: Project }
        mock.saves.push(body.project)
        revision++
        return json({ revision })
      }
      return json({ ...project, revision })
    }
    if (pathname === '/api/health') return json({ ok: true, version: 'e2e' })
    if (pathname === '/api/assets') return json([asset])
    if (pathname === '/api/assets/a1') return json(asset)
    if (pathname === '/api/projects' || pathname === '/api/jobs') return json([])
    if (pathname === '/api/packs')
      return json({
        index: { version: '1', updatedAt: '2026-01-01T00:00:00.000Z', packs: [], fonts: [] },
        manifests: [],
      })
    return json({ error: 'not found' }, 404)
  })
  return mock
}

const openEditor = async (page: Page) => {
  await page.goto(`/p/${PROJECT_ID}`)
  await expect(page.getByTestId('timeline')).toBeVisible()
  await expect(clip(page, 'm0')).toBeVisible()
}

const clip = (page: Page, id: string): Locator =>
  page.locator(`[data-testid="timeline-clip"][data-clip-id="${id}"]`)

const box = async (l: Locator) => {
  const b = await l.boundingBox()
  expect(b).not.toBeNull()
  return b!
}

const lastSave = (mock: Mock) => mock.saves.at(-1)
const mainClipsOf = (p: Project | undefined): Clip[] =>
  p?.tracks.find((t) => t.kind === 'main')?.clips ?? []

// A service worker that claims the page would serve `/api` itself, bypassing `page.route`.
test.use({ serviceWorkers: 'block' })

test.describe('timeline', () => {
  test('renders clips, ruler, playhead and track headers', async ({ page }) => {
    await mockApi(page, makeProject(3))
    await openEditor(page)
    await expect(page.locator('[data-testid="timeline-clip"]')).toHaveCount(3)
    await expect(page.getByTestId('timeline-ruler')).toBeVisible()
    await expect(page.getByTestId('timeline-playhead')).toBeAttached()
    await expect(page.getByRole('group', { name: 'Main track' })).toBeVisible()
    await expect(page.getByTestId('track-headers')).toBeVisible()
  })

  test('tap selects a clip and its end handle trims it', async ({ page }) => {
    const mock = await mockApi(page, makeProject(3))
    await openEditor(page)
    const p = pointer(page, isTouch(page))
    const b = await box(clip(page, 'm0'))
    const y = b.y + b.height / 2
    await p.tap(b.x + b.width / 2, y)
    await expect(clip(page, 'm0')).toHaveAttribute('data-selected', 'true')
    // Grab the (now visible) end handle and drag it half the clip to the left.
    const handleX = b.x + b.width - 4
    await p.drag([handleX, y], [handleX - b.width / 2, y])
    await expect.poll(() => mainClipsOf(lastSave(mock))[0]?.duration).toBeLessThan(sec(0.6))
    const d = mainClipsOf(lastSave(mock))[0]!.duration
    expect(Math.abs(d - sec(0.5))).toBeLessThanOrEqual(34_000)
    expect(d % 1).toBe(0)
    // Magnetic: the next clip now starts where the trimmed one ends.
    expect(mainClipsOf(lastSave(mock))[1]!.start).toBe(d)
  })

  test('dragging a main clip reorders the magnetic track', async ({ page }) => {
    const mock = await mockApi(page, makeProject(3))
    await openEditor(page)
    const touch = isTouch(page)
    const b0 = await box(clip(page, 'm0'))
    const b2 = await box(clip(page, 'm2'))
    const y = b0.y + b0.height / 2
    // Drop between m1 and m2 (left of m2's midpoint, right of m1's).
    const target = b2.x + b2.width * 0.25
    // Phones lift the clip with a long press first; a plain touch drag would pan.
    await pointer(page, touch).drag([b0.x + b0.width / 2, y], [target, y], {
      hold: touch ? 500 : 0,
    })
    await expect
      .poll(() => mainClipsOf(lastSave(mock)).map((c) => c.id))
      .toEqual(['m1', 'm0', 'm2'])
  })

  test('split at the playhead after seeking on the ruler', async ({ page }) => {
    const mock = await mockApi(page, makeProject(3))
    await openEditor(page)
    const b1 = await box(clip(page, 'm1'))
    const ruler = await box(page.getByTestId('timeline-ruler'))
    await pointer(page, isTouch(page)).tap(b1.x + b1.width / 2, ruler.y + ruler.height / 2)
    await page.keyboard.press('s')
    await expect(page.locator('[data-testid="timeline-clip"]')).toHaveCount(4)
    await expect.poll(() => mainClipsOf(lastSave(mock)).length).toBe(4)
    const durations = mainClipsOf(lastSave(mock)).map((c) => c.duration)
    expect(durations[1]! + durations[2]!).toBe(sec(1))
  })

  test('zooms with ctrl-wheel (desktop) or pinch (touch)', async ({ page }) => {
    await mockApi(page, makeProject(3))
    await openEditor(page)
    const before = (await box(clip(page, 'm0'))).width
    const vp = await box(page.getByTestId('timeline-viewport'))
    const cy = vp.y + vp.height - 12 // below the tracks: pinching empty space
    if (isTouch(page)) {
      const p = pointer(page, true)
      const cx = vp.x + vp.width / 2
      await p.down(cx - 30, cy, 1)
      await p.down(cx + 30, cy, 2)
      for (let i = 1; i <= 6; i++) {
        await p.move(cx - 30 - i * 10, cy, 1)
        await p.move(cx + 30 + i * 10, cy, 2)
      }
      await p.up(cx - 90, cy, 1)
      await p.up(cx + 90, cy, 2)
    } else {
      await page.mouse.move(vp.x + 200, cy)
      await page.keyboard.down('Control')
      for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -100)
      await page.keyboard.up('Control')
    }
    await expect.poll(async () => (await box(clip(page, 'm0'))).width).toBeGreaterThan(before * 1.5)
  })

  test('keyboard: focus a clip and nudge it with the arrow keys', async ({ page }) => {
    const mock = await mockApi(page, makeProject(3))
    await openEditor(page)
    await clip(page, 'm0').focus()
    await page.keyboard.press('ArrowRight')
    await expect
      .poll(() => mainClipsOf(lastSave(mock)).map((c) => c.id))
      .toEqual(['m1', 'm0', 'm2'])
  })
})

test.describe('timeline performance', () => {
  test('200 clips: mount, drag and scroll stay within frame budget', async ({ page }, info) => {
    test.skip(isTouch(page), 'measured once, on the desktop project')
    await mockApi(page, makeProject(200), true)
    const t0 = Date.now()
    await openEditor(page)
    const mountMs = Date.now() - t0
    const mounted = await page.locator('[data-testid="timeline-clip"]').count()
    expect(mounted).toBeLessThan(80) // virtualised

    // A long drag with edge auto-scroll, then a wheel pan across the project.
    const b = await box(clip(page, 'm2'))
    const vp = await box(page.getByTestId('timeline-viewport'))
    const y = b.y + b.height / 2
    await page.evaluate(() => performance.clearMeasures())
    await page.mouse.move(b.x + b.width / 2, y)
    await page.mouse.down()
    await page.mouse.move(vp.x + vp.width - 10, y, { steps: 60 })
    await page.waitForTimeout(500) // auto-scrolling
    await page.keyboard.press('Escape')
    await page.mouse.up()
    for (let i = 0; i < 30; i++) await page.mouse.wheel(400, 0)
    await page.waitForTimeout(200)

    const stats = await page.evaluate(() => {
      const pick = (name: string) => {
        const d = performance
          .getEntriesByName(name, 'measure')
          .map((e) => e.duration)
          .toSorted((a, b) => a - b)
        const q = (p: number) => d[Math.min(d.length - 1, Math.floor(d.length * p))] ?? 0
        return {
          n: d.length,
          avg: d.reduce((a, b) => a + b, 0) / Math.max(1, d.length),
          p95: q(0.95),
          max: d.at(-1) ?? 0,
        }
      }
      return { move: pick('tl:pointermove'), frame: pick('tl:frame') }
    })
    const report = { mountMs, mountedClips: mounted, ...stats }
    console.log(`timeline perf (200 clips): ${JSON.stringify(report)}`)
    info.annotations.push({ type: 'perf', description: JSON.stringify(report) })
    expect(stats.move.n).toBeGreaterThan(30)
    expect(stats.frame.n).toBeGreaterThan(10)
    expect(stats.move.p95).toBeLessThan(4)
    expect(stats.frame.p95).toBeLessThan(12)
  })
})
