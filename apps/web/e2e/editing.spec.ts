/**
 * Pro editing UX in real browsers (Pixel 9 + iPhone 16 touch, desktop Chrome mouse) against
 * the mocked API: on-canvas move / scale / rotate / pinch, crop mode, safe zones, inline
 * text editing, and the timeline's slip, roll, ripple trim, box selection and copy/paste.
 * Edits are read back from the autosave `PUT` bodies; the desktop run also measures the
 * overlay's per-frame cost during a drag.
 */
import { expect, test, type Page } from '@playwright/test'
import { Asset, Project, sec, type Clip } from '@reelforge/core'
import { enableEditMode, stageOption } from './dock.ts'
import { isTouch, pointer } from './pointer.ts'

const PROJECT_ID = 'edit-e2e'

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
  proxy: 'ready',
})

/** Main: three 2 s clips (in 0 / 5 / 10 s); overlay: a 512 px sticker; text near the top. */
const makeProject = () =>
  Project.parse({
    id: PROJECT_ID,
    name: 'Editing e2e',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    revision: 1,
    tracks: [
      {
        id: 'main',
        kind: 'main',
        clips: [0, 1, 2].map((i) => ({
          id: `m${i}`,
          type: 'video',
          assetId: 'a1',
          start: sec(2 * i),
          duration: sec(2),
          in: sec(5 * i),
        })),
      },
      {
        id: 'ov',
        kind: 'overlay',
        clips: [{ id: 'st', type: 'sticker', ref: 'pack/s', start: 0, duration: sec(6) }],
      },
      {
        id: 'tt',
        kind: 'text',
        clips: [
          {
            id: 'tx',
            type: 'text',
            text: 'Hello',
            start: sec(1),
            duration: sec(2),
            transform: { y: { value: 300 } },
          },
          { id: 'ty', type: 'text', text: 'Later', start: sec(4), duration: sec(1) },
        ],
      },
      { id: 'au', kind: 'audio', clips: [] },
    ],
  })

interface Mock {
  saves: Project[]
}

const mockApi = async (page: Page, project: Project, perf = false): Promise<Mock> => {
  const mock: Mock = { saves: [] }
  let revision = project.revision
  await page.addInitScript((enablePerf) => {
    localStorage.setItem('rf.token', 'e2e-token')
    localStorage.setItem('rf.deviceId', 'e2e-device')
    if (enablePerf) (globalThis as { __RF_PERF__?: boolean }).__RF_PERF__ = true
  }, perf)
  await page.routeWebSocket(/\/api\/events/, () => undefined)
  await page.route(/\/api\//, async (route) => {
    const req = route.request()
    const { pathname } = new URL(req.url())
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (pathname === `/api/projects/${PROJECT_ID}`) {
      if (req.method() === 'PUT') {
        mock.saves.push((req.postDataJSON() as { project: Project }).project)
        return json({ revision: ++revision })
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

test.use({ serviceWorkers: 'block' })

const open = async (page: Page, perf = false) => {
  const mock = await mockApi(page, makeProject(), perf)
  await page.goto(`/p/${PROJECT_ID}`)
  await expect(page.getByTestId('transform-overlay')).toBeVisible()
  await expect(page.locator('[data-clip-id="m0"]').first()).toBeVisible()
  return mock
}

const last = (m: Mock) => m.saves.at(-1)
const find = (p: Project | undefined, id: string): Clip | undefined =>
  p?.tracks.flatMap((t) => t.clips).find((c) => c.id === id)
const transformOf = (m: Mock, id: string) => {
  const c = find(last(m), id)
  return c && c.type !== 'audio' ? c.transform : undefined
}

/** Screen point of a canvas point (1080×1920) on the overlay. */
const canvas = async (page: Page) => {
  const b = (await page.getByTestId('transform-overlay').boundingBox())!
  const k = b.width / 1080
  return (x: number, y: number): [number, number] => [b.x + x * k, b.y + y * k]
}

const ov = (page: Page) => pointer(page, isTouch(page), 'transform-overlay')

test.describe('on-canvas transform', () => {
  test('tap selects, drag moves the sticker (one save, snapped to centre)', async ({ page }) => {
    const mock = await open(page)
    const at = await canvas(page)
    await ov(page).tap(...at(540, 960))
    await expect(page.getByTestId('transform-frame')).toHaveAttribute('data-clip-id', 'st')
    await ov(page).drag(at(540, 960), at(540, 1300))
    await expect.poll(() => transformOf(mock, 'st')?.y.value).toBeGreaterThan(1200)
    // Moving straight down keeps the centre on the vertical guide.
    expect(transformOf(mock, 'st')?.x.value).toBe(540)
  })

  test('scales with a corner (desktop) or pinches and twists (touch)', async ({ page }) => {
    const mock = await open(page)
    const at = await canvas(page)
    await ov(page).tap(...at(540, 960))
    await expect(page.getByTestId('transform-frame')).toBeVisible()
    if (isTouch(page)) {
      const p = ov(page)
      const [x, y] = at(540, 960)
      await p.down(x - 20, y, 1)
      await p.down(x + 20, y, 2)
      for (let i = 1; i <= 8; i++) {
        await p.move(x - 20 - i * 8, y - i * 3, 1)
        await p.move(x + 20 + i * 8, y + i * 3, 2)
      }
      await p.up(x + 84, y + 24, 2)
      await p.up(x - 84, y - 24, 1)
      await expect.poll(() => transformOf(mock, 'st')?.scale.value ?? 1).toBeGreaterThan(2.5)
      expect(Math.abs(transformOf(mock, 'st')!.rotation.value)).toBeGreaterThan(5)
    } else {
      const h = (await page.getByTestId('handle-se').boundingBox())!
      const from: [number, number] = [h.x + h.width / 2, h.y + h.height / 2]
      await ov(page).drag(from, [from[0] + 60, from[1] + 107])
      await expect.poll(() => transformOf(mock, 'st')?.scale.value ?? 1).toBeGreaterThan(1.3)
      const r = (await page.getByTestId('handle-rot').boundingBox())!
      const [cx, cy] = at(540, 960)
      await ov(page).drag([r.x + r.width / 2, r.y + r.height / 2], [cx + 300, cy + 4])
      await expect.poll(() => transformOf(mock, 'st')?.rotation.value).toBe(90)
    }
  })

  test('safe zones and crop mode', async ({ page }) => {
    const mock = await open(page)
    await stageOption(page, 'safe-zones-toggle')
    await expect(page.getByTestId('safe-zones')).toBeVisible()
    const at = await canvas(page)
    // Below the sticker: the main clip.
    await ov(page).tap(...at(540, 1700))
    await expect(page.getByTestId('transform-frame')).toHaveAttribute('data-clip-id', 'm0')
    await stageOption(page, 'crop-toggle')
    await expect(page.getByTestId('crop-frame')).toBeVisible()
    const h = (await page.getByTestId('crop-left').boundingBox())!
    const [x] = at(270, 0)
    const from: [number, number] = [h.x + h.width / 2, h.y + h.height / 2]
    if (isTouch(page)) {
      // Synthetic touch events fire on the element they are dispatched to: use the handle.
      const ptr = (type: string, px: number) =>
        page.getByTestId('crop-left').dispatchEvent(type, {
          pointerId: 1,
          pointerType: 'touch',
          isPrimary: true,
          clientX: px,
          clientY: from[1],
          bubbles: true,
          cancelable: true,
        })
      await ptr('pointerdown', from[0])
      for (let i = 1; i <= 8; i++) await ptr('pointermove', from[0] + ((x - from[0]) * i) / 8)
      await ptr('pointerup', x)
    } else {
      await ov(page).drag(from, [x, from[1]])
    }
    await expect
      .poll(() => {
        const c = find(last(mock), 'm0')
        return c?.type === 'video' ? c.crop.left : 0
      })
      .toBeGreaterThan(0.15)
  })

  test('double-tap edits text in place', async ({ page }) => {
    const mock = await open(page)
    await page.getByTestId('timeline-ruler').click({ position: { x: 16 + 180, y: 10 } })
    const at = await canvas(page)
    const p = ov(page)
    await p.tap(...at(540, 300))
    await p.tap(...at(540, 300))
    const editor = page.getByTestId('inline-text-editor')
    await expect(editor).toBeVisible()
    await editor.fill('Edited on canvas')
    await editor.press('Control+Enter')
    await expect
      .poll(() => {
        const c = find(last(mock), 'tx')
        return c?.type === 'text' ? c.text : ''
      })
      .toBe('Edited on canvas')
  })
})

test.describe('timeline pro edits', () => {
  const clipBox = async (page: Page, id: string) =>
    (await page.locator(`[data-testid="timeline-clip"][data-clip-id="${id}"]`).boundingBox())!

  test('roll mode moves the cut between two main clips', async ({ page }) => {
    const mock = await open(page)
    const touch = isTouch(page)
    await enableEditMode(page, 'roll-toggle')
    const b = await clipBox(page, 'm1')
    const y = b.y + b.height / 2
    const p = pointer(page, touch)
    // Select first: handles show on selected clips only, and the transition button that
    // sits on an unselected cut hides.
    await p.tap(b.x + b.width / 2, y)
    const from = b.x + 6
    await p.drag([from, y], [from + b.width / 4, y])
    await expect.poll(() => find(last(mock), 'm0')?.duration ?? 0).toBeGreaterThan(sec(2.2))
    const m0 = find(last(mock), 'm0')!
    const m1 = find(last(mock), 'm1')!
    expect(m0.duration + m1.duration).toBe(sec(4))
    expect(find(last(mock), 'm2')!.start).toBe(sec(4))
  })

  test('slip: Alt+drag (desktop) or hold-and-drag (touch) shifts the in-point', async ({
    page,
  }) => {
    const mock = await open(page)
    const touch = isTouch(page)
    const b = await clipBox(page, 'm1')
    const y = b.y + b.height / 2
    const x = b.x + b.width / 2
    if (touch) {
      await pointer(page, true).drag([x, y], [x - b.width / 4, y], { hold: 1100 })
    } else {
      await page.keyboard.down('Alt')
      await pointer(page, false).drag([x, y], [x - b.width / 4, y])
      await page.keyboard.up('Alt')
    }
    await expect
      .poll(() => {
        const c = find(last(mock), 'm1')
        return c?.type === 'video' ? c.in : 0
      })
      .toBeGreaterThan(sec(5.2))
    expect(find(last(mock), 'm1')!.start).toBe(sec(2))
    expect(find(last(mock), 'm1')!.duration).toBe(sec(2))
  })

  test('ripple trim shifts later clips on a free track', async ({ page }) => {
    const mock = await open(page)
    const touch = isTouch(page)
    await enableEditMode(page, 'ripple-toggle')
    const b = await clipBox(page, 'tx')
    const y = b.y + b.height / 2
    const p = pointer(page, touch)
    if (touch) await p.tap(b.x + b.width / 2, y)
    const from = b.x + b.width - (touch ? 6 : 2)
    await p.drag([from, y], [from + b.width / 2, y])
    await expect.poll(() => find(last(mock), 'ty')?.start ?? 0).toBeGreaterThan(sec(4.3))
    const tx = find(last(mock), 'tx')!
    expect(find(last(mock), 'ty')!.start - (tx.start + tx.duration)).toBe(sec(1))
  })

  test('box selection then copy / paste', async ({ page }) => {
    const mock = await open(page)
    const touch = isTouch(page)
    const m0 = await clipBox(page, 'm0')
    const tx = await clipBox(page, 'tx')
    // From the (empty) audio lane under m0 up-right across m0, m1 and the text clip.
    const start: [number, number] = [m0.x + 70, m0.y + m0.height + 22]
    const end: [number, number] = [m0.x + 270, tx.y + tx.height / 2]
    if (touch) {
      const p = pointer(page, true)
      const d = 50
      await p.down(start[0] - d, start[1], 1)
      await p.down(start[0] + d, start[1], 2)
      const steps = 48
      for (let i = 1; i <= steps; i++) {
        const dx = ((end[0] - start[0]) * i) / steps
        const dy = ((end[1] - start[1]) * i) / steps
        await p.move(start[0] - d + dx, start[1] + dy, 1)
        await p.move(start[0] + d + dx, start[1] + dy, 2)
      }
      await p.up(end[0] + d, end[1], 2)
      await p.up(end[0] - d, end[1], 1)
    } else {
      await pointer(page, false).drag(start, end)
    }
    const selected = page.locator('[data-testid="timeline-clip"][data-selected="true"]')
    await expect(selected).not.toHaveCount(0)
    await expect(page.locator('[data-clip-id="tx"][data-selected="true"]')).toHaveCount(1)
    await expect(page.locator('[data-clip-id="ty"][data-selected="true"]')).toHaveCount(0)
    const n = await selected.count()
    await page.keyboard.press('ControlOrMeta+c')
    await page.keyboard.press('ControlOrMeta+v')
    await expect.poll(() => last(mock)?.tracks.flatMap((t) => t.clips).length ?? 0).toBe(6 + n)
  })
})

test.describe('overlay performance', () => {
  test('drag frame cost stays within budget', async ({ page }, info) => {
    test.skip(isTouch(page), 'measured once, on desktop')
    await open(page, true)
    const at = await canvas(page)
    await ov(page).tap(...at(540, 960))
    await page.evaluate(() => performance.clearMeasures())
    const [x, y] = at(540, 960)
    await page.mouse.move(x, y)
    await page.mouse.down()
    for (let i = 1; i <= 60; i++) await page.mouse.move(x + i * 3, y + Math.sin(i / 5) * 40)
    await page.mouse.up()
    const stats = await page.evaluate(() => {
      const d = performance
        .getEntriesByName('ov:gesture-frame', 'measure')
        .map((e) => e.duration)
        .toSorted((a, b) => a - b)
      return {
        n: d.length,
        avg: d.reduce((a, b) => a + b, 0) / Math.max(1, d.length),
        p95: d[Math.floor(d.length * 0.95)] ?? 0,
        max: d.at(-1) ?? 0,
      }
    })
    console.log(`overlay perf: ${JSON.stringify(stats)}`)
    info.annotations.push({ type: 'perf', description: JSON.stringify(stats) })
    expect(stats.n).toBeGreaterThan(10)
    expect(stats.p95).toBeLessThan(8)
  })
})
