/**
 * AI background UI on every form factor, against a mocked API: choose Remove / Blur / Colour /
 * Image on a clip, watch the host `matte` job's progress, see the subject-separated state
 * arrive over the live-sync socket, and flip "Behind subject" on a text clip. Edits are read
 * back from the autosave `PUT` bodies.
 */
import { expect, test, type Locator, type Page, type WebSocketRoute } from '@playwright/test'
import { Asset, Job, Project, sec, type Clip } from '@reelforge/core'
import { openTool } from './dock.ts'

const PROJECT_ID = 'bg-e2e'
const NOW = '2026-01-01T00:00:00.000Z'

const video = Asset.parse({
  id: 'a1',
  kind: 'video',
  name: 'clip.mp4',
  size: 1000,
  mime: 'video/mp4',
  createdAt: NOW,
  duration: sec(10),
  width: 1080,
  height: 1920,
  hasVideo: true,
  hasAudio: false,
  proxy: 'ready',
})
const photo = Asset.parse({
  id: 'a2',
  kind: 'image',
  name: 'beach.jpg',
  size: 1000,
  mime: 'image/jpeg',
  createdAt: NOW,
  width: 1200,
  height: 800,
  hasVideo: false,
  hasAudio: false,
  proxy: 'not-needed',
})

const project = Project.parse({
  id: PROJECT_ID,
  name: 'Background e2e',
  createdAt: NOW,
  updatedAt: NOW,
  revision: 1,
  tracks: [
    {
      id: 'main',
      kind: 'main',
      clips: [{ id: 'm0', type: 'video', assetId: 'a1', start: 0, duration: sec(5) }],
    },
    {
      id: 'text',
      kind: 'text',
      clips: [
        { id: 't0', type: 'text', text: 'HELLO', start: 0, duration: sec(3), name: 'Headline' },
      ],
    },
    { id: 'audio', kind: 'audio', clips: [] },
  ],
})

interface Mock {
  saves: Project[]
  jobs: Array<{ kind: string; payload: Record<string, unknown> }>
  /** Push a server event to the page. */
  push(event: unknown): void
}

const mockApi = async (page: Page): Promise<Mock> => {
  let socket: WebSocketRoute | undefined
  const mock: Mock = {
    saves: [],
    jobs: [],
    push: (e) => socket?.send(JSON.stringify(e)),
  }
  let revision = project.revision
  await page.addInitScript(() => {
    localStorage.setItem('rf.token', 'e2e-token')
    localStorage.setItem('rf.deviceId', 'e2e-device')
  })
  await page.routeWebSocket(/\/api\/events/, (ws) => {
    socket = ws
    ws.send(JSON.stringify({ type: 'hello', serverVersion: 'e2e', deviceId: 'e2e-device' }))
  })
  await page.route(/\/api\//, async (route) => {
    const req = route.request()
    const { pathname } = new URL(req.url())
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (pathname === `/api/projects/${PROJECT_ID}`) {
      if (req.method() === 'PUT') {
        mock.saves.push((req.postDataJSON() as { project: Project }).project)
        revision++
        return json({ revision })
      }
      return json({ ...project, revision })
    }
    if (pathname === '/api/health') return json({ ok: true, version: 'e2e' })
    if (pathname === '/api/assets') return json([video, photo])
    if (pathname === '/api/assets/a1') return json(video)
    if (pathname === '/api/assets/a2') return json(photo)
    if (pathname === '/api/jobs' && req.method() === 'POST') {
      const body = req.postDataJSON() as { kind: string; payload: Record<string, unknown> }
      mock.jobs.push(body)
      return json(
        Job.parse({ id: 'job1', kind: 'matte', status: 'running', progress: 0, createdAt: NOW }),
      )
    }
    if (pathname === '/api/jobs' || pathname === '/api/projects') return json([])
    if (pathname.startsWith('/api/assets/a2/poster')) return route.fulfill({ status: 404 })
    if (pathname === '/api/packs')
      return json({
        index: { version: '1', updatedAt: NOW, packs: [], fonts: [] },
        manifests: [],
      })
    return json({ error: 'not found' }, 404)
  })
  return mock
}

const clipEl = (page: Page, id: string): Locator =>
  page.locator(`[data-testid="timeline-clip"][data-clip-id="${id}"]`)

const lastMain = (mock: Mock): Clip | undefined =>
  mock.saves.at(-1)?.tracks.find((t) => t.kind === 'main')?.clips[0]

// A service worker that claims the page would serve `/api` itself, bypassing `page.route`.
test.use({ serviceWorkers: 'block' })

test.describe('AI background', () => {
  test('remove → matte job with progress → separated; blur / colour / image options', async ({
    page,
  }) => {
    const mock = await mockApi(page)
    await page.goto(`/p/${PROJECT_ID}`)
    await expect(clipEl(page, 'm0')).toBeVisible()
    await clipEl(page, 'm0').click()
    await openTool(page, 'background')

    const modes = page.getByRole('radiogroup', { name: 'Background' })
    await expect(modes).toBeVisible()
    await modes.getByRole('radio', { name: 'Remove' }).click()

    // The first use starts the host job with the fast model.
    await expect.poll(() => mock.jobs.length).toBe(1)
    expect(mock.jobs[0]).toMatchObject({
      kind: 'matte',
      payload: { assetId: 'a1', model: 'modnet' },
    })
    await expect
      .poll(() => (lastMain(mock) as { background?: { mode: string } })?.background?.mode)
      .toBe('remove')

    // Live progress from the host.
    mock.push({
      type: 'job',
      job: Job.parse({
        id: 'job1',
        kind: 'matte',
        status: 'running',
        progress: 0.5,
        createdAt: NOW,
      }),
    })
    const ring = page.getByRole('progressbar', { name: 'Separating subject' })
    await expect(ring).toBeVisible()
    await expect(ring).toHaveAttribute('aria-valuenow', '50')

    // Done: the asset now carries its matte → the status turns to "separated".
    mock.push({
      type: 'asset',
      asset: {
        ...video,
        matte: { status: 'ready', model: 'modnet', width: 720, height: 1280, fps: 30, version: 1 },
      },
    })
    mock.push({
      type: 'job',
      job: Job.parse({
        id: 'job1',
        kind: 'matte',
        status: 'done',
        progress: 1,
        createdAt: NOW,
      }),
    })
    await expect(page.getByText('Subject separated.')).toBeVisible()
    await expect(ring).toHaveCount(0)

    // Blur exposes its strength; the value is saved on the clip.
    await modes.getByRole('radio', { name: 'Blur' }).click()
    await expect(page.getByRole('slider', { name: 'Blur' })).toBeVisible()
    await expect
      .poll(() => (lastMain(mock) as { background?: { mode: string } })?.background?.mode)
      .toBe('blur')

    // Colour exposes a picker.
    await modes.getByRole('radio', { name: 'Colour' }).click()
    await expect(page.getByRole('group', { name: 'Background colour' })).toBeVisible()
    await expect
      .poll(() => (lastMain(mock) as { background?: { mode: string } })?.background?.mode)
      .toBe('color')

    // Image lists the image assets of the library; choosing one saves its id.
    await modes.getByRole('radio', { name: 'Image' }).click()
    await page.getByRole('button', { name: 'beach.jpg', exact: true }).click()
    await expect
      .poll(() => (lastMain(mock) as { background?: { assetId?: string } })?.background?.assetId)
      .toBe('a2')

    // Off removes the controls but keeps the cached matte (no second job).
    await modes.getByRole('radio', { name: 'Off' }).click()
    await expect(page.getByText('Subject separated.')).toHaveCount(0)
    expect(mock.jobs).toHaveLength(1)
  })

  test('a failed matte job shows the error and can be retried', async ({ page }) => {
    const mock = await mockApi(page)
    await page.goto(`/p/${PROJECT_ID}`)
    await clipEl(page, 'm0').click()
    await openTool(page, 'background')
    await page
      .getByRole('radiogroup', { name: 'Background' })
      .getByRole('radio', { name: 'Blur' })
      .click()
    await expect.poll(() => mock.jobs.length).toBe(1)
    mock.push({
      type: 'job',
      job: Job.parse({
        id: 'job1',
        kind: 'matte',
        status: 'failed',
        progress: 0,
        createdAt: NOW,
        error: 'Fast (MODNet) model is not installed — run `pnpm bootstrap`',
      }),
    })
    await expect(page.getByRole('alert')).toContainText('model is not installed')
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect.poll(() => mock.jobs.length).toBe(2)
    expect(mock.jobs[1]?.payload).toMatchObject({ assetId: 'a1', force: true })
  })

  test('text "Behind subject" toggles on the text clip', async ({ page }) => {
    const mock = await mockApi(page)
    await page.goto(`/p/${PROJECT_ID}`)
    await clipEl(page, 't0').click()
    await openTool(page, 'text')
    const toggle = page.getByRole('switch', { name: /Behind subject/ })
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect
      .poll(() => {
        const t = mock.saves.at(-1)?.tracks.find((x) => x.kind === 'text')?.clips[0]
        return (t as { behindSubject?: boolean } | undefined)?.behindSubject
      })
      .toBe(true)
    await toggle.click()
    await expect
      .poll(() => {
        const t = mock.saves.at(-1)?.tracks.find((x) => x.kind === 'text')?.clips[0]
        return (t as { behindSubject?: boolean } | undefined)?.behindSubject
      })
      .toBeUndefined()
  })
})
