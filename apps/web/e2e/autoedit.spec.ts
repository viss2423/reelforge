/**
 * Auto Edit in real browsers with a mocked API: (1) Home → Auto edit sheet → pick clips →
 * the editor opens, the clips upload, and Auto edit runs on its own; (2) the AI panel's
 * "Auto edit this project" and its variant switcher, plus the LLM-less hint. Jobs finish
 * immediately with canned host results; edits are read back from autosave PUT bodies.
 */
import { expect, test, type Page } from '@playwright/test'
import { Asset, Project, sec } from '@reelforge/core'
import { dockTool } from './dock.ts'

const PROJECT_ID = 'ae-e2e'
const NOW = '2026-01-01T00:00:00.000Z'

const video = (id: string) =>
  Asset.parse({
    id,
    kind: 'video',
    name: `${id}.mp4`,
    size: 1000,
    mime: 'video/mp4',
    createdAt: NOW,
    duration: sec(12),
    width: 1080,
    height: 1920,
    hasVideo: true,
    hasAudio: false,
    proxy: 'ready',
    thumbnails: 'ready',
    waveform: 'not-needed',
  })

const emptyProject = () =>
  Project.parse({
    id: PROJECT_ID,
    name: 'Auto edit e2e',
    createdAt: NOW,
    updatedAt: NOW,
    revision: 1,
    tracks: [
      { id: 'main', kind: 'main', clips: [] },
      { id: 'text', kind: 'text', clips: [] },
      { id: 'audio', kind: 'audio', clips: [] },
    ],
  })

const projectWith = (ids: string[]) => {
  const p = emptyProject()
  p.tracks[0]!.clips = ids.map((id, i) => ({
    id: `m${i}`,
    type: 'video',
    assetId: id,
    start: sec(i * 6),
    duration: sec(6),
    in: 0,
    speed: 1,
    speedRamp: [],
    reverse: false,
    fit: 'cover',
  })) as never
  return Project.parse(p)
}

const highlights = {
  ranker: 'heuristic',
  variants: [
    {
      id: 'story',
      label: 'Story',
      moments: [
        { assetId: 'a2', start: sec(2), end: sec(4), role: 'hook', reason: 'eye-catching shot' },
        { assetId: 'a1', start: 0, end: sec(3), role: 'value', reason: 'strong visual' },
        { assetId: 'a2', start: sec(6), end: sec(8), role: 'payoff', reason: 'strong visual' },
      ],
    },
    {
      id: 'chrono',
      label: 'In order',
      moments: [
        { assetId: 'a1', start: 0, end: sec(3), role: 'hook', reason: 'strong visual' },
        { assetId: 'a2', start: sec(2), end: sec(4), role: 'value', reason: 'strong visual' },
      ],
    },
  ],
}

interface Mock {
  saves: Project[]
  jobKinds: string[]
  llm: boolean
}

const mockApi = async (
  page: Page,
  opts: { project?: Project; assets: Asset[]; llm?: boolean },
): Promise<Mock> => {
  const mock: Mock = { saves: [], jobKinds: [], llm: opts.llm ?? false }
  let project = opts.project
  const assets = [...opts.assets]
  let revision = 1
  let jobSeq = 0
  await page.addInitScript(() => {
    localStorage.setItem('rf.token', 'e2e-token')
    localStorage.setItem('rf.deviceId', 'e2e-device')
  })
  await page.routeWebSocket(/\/api\/events/, () => undefined)
  await page.route(/\/api\//, async (route) => {
    const req = route.request()
    const { pathname } = new URL(req.url())
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (pathname === '/api/health') return json({ ok: true, version: 'e2e' })
    if (pathname === '/api/system')
      return json({
        version: 'e2e',
        toolchain: {
          llm: { installed: mock.llm, model: mock.llm ? 'Qwen3.5-4B-Q4_K_M.gguf' : null },
        },
      })
    if (pathname === '/api/packs')
      return json({
        index: { version: '1', updatedAt: NOW, packs: [], fonts: [] },
        manifests: [],
      })
    if (pathname === '/api/trends' || pathname.startsWith('/api/music'))
      return json({ error: 'not found' }, 404)
    if (pathname === '/api/projects' && req.method() === 'POST') {
      project = emptyProject()
      return json(project)
    }
    if (pathname === '/api/projects') return json([])
    if (pathname === `/api/projects/${PROJECT_ID}`) {
      if (req.method() === 'PUT') {
        mock.saves.push((req.postDataJSON() as { project: Project }).project)
        revision++
        return json({ revision })
      }
      return json({ ...project, revision })
    }
    if (pathname === '/api/uploads' && req.method() === 'POST')
      return json({ uploadId: `u${assets.length}`, chunkSize: 4_000_000 })
    if (/^\/api\/uploads\/[^/]+\/chunks\//.test(pathname)) return json({ received: 1 })
    if (/^\/api\/uploads\/[^/]+\/complete$/.test(pathname)) {
      const next = video(`a${assets.length + 1}`)
      assets.push(next)
      return json(next)
    }
    if (pathname === '/api/assets') return json(assets)
    const asset = /^\/api\/assets\/([^/]+)$/.exec(pathname)
    if (asset) return json(assets.find((a) => a.id === asset[1]) ?? {}, 200)
    if (pathname === '/api/jobs' && req.method() === 'POST') {
      const body = req.postDataJSON() as { kind: string }
      mock.jobKinds.push(body.kind)
      const result: Record<string, unknown> = {
        scenes: { scenes: [sec(3)] },
        highlights,
        copywriter: {
          hooks: ['You need to see this', 'Wait for it', 'Best view ever'],
          caption: 'c',
          hashtags: ['#a'],
        },
      }
      return json({
        id: `j${++jobSeq}`,
        kind: body.kind,
        status: 'done',
        progress: 1,
        createdAt: NOW,
        result: result[body.kind],
      })
    }
    if (pathname === '/api/jobs') return json([])
    return json({ error: 'not found' }, 404)
  })
  return mock
}

const lastSave = (m: Mock) => m.saves.at(-1)
const mainClips = (p: Project | undefined) => p?.tracks.find((t) => t.kind === 'main')?.clips ?? []

test.use({ serviceWorkers: 'block' })

const tinyMp4 = (name: string) => ({
  name,
  mimeType: 'video/mp4',
  buffer: Buffer.from(`fake-${name}`),
})

test.describe('Auto edit', () => {
  test('Home → Auto edit → clips upload → the editor cuts the reel on its own', async ({
    page,
  }) => {
    const mock = await mockApi(page, { assets: [] })
    await page.goto('/')
    await page.getByTestId('auto-edit').click()
    const start = page.getByTestId('autoedit-start')
    await expect(start).toBeDisabled()
    await page.getByTestId('autoedit-clips').setInputFiles([tinyMp4('one.mp4'), tinyMp4('two.mp4')])
    await expect(start).toBeEnabled()
    await page.getByRole('radio', { name: '15 s' }).click()
    await page.getByRole('radio', { name: 'Cinematic' }).click()
    await start.click()
    await expect(page).toHaveURL(new RegExp(`/p/${PROJECT_ID}`))
    await expect(page.getByTestId('editor')).toBeVisible()
    await expect.poll(() => mock.jobKinds).toContain('highlights')
    // Story variant: hook (a2 @2 s) first, then a1, then a2's payoff.
    await expect
      .poll(
        () => mainClips(lastSave(mock)).map((c) => (c.type === 'video' ? [c.assetId, c.in] : null)),
        { timeout: 30_000 },
      )
      .toEqual([
        ['a2', sec(2)],
        ['a1', 0],
        ['a2', sec(6)],
      ])
  })

  test('Magic panel: Make it a reel, switch version, and the no-model hint', async ({ page }) => {
    const a1 = video('a1')
    const a2 = video('a2')
    const mock = await mockApi(page, {
      project: projectWith(['a1', 'a2']),
      assets: [a1, a2],
      llm: false,
    })
    await page.goto(`/p/${PROJECT_ID}`)
    await expect(page.getByTestId('editor')).toBeVisible()
    await dockTool(page, 'ai').click() // Magic
    await expect(page.getByText(/need the local AI model/)).toBeVisible()
    await page.getByRole('button', { name: 'Make it a reel' }).click()
    await expect.poll(() => mainClips(lastSave(mock)).length, { timeout: 30_000 }).toBe(3)
    expect(mock.jobKinds).not.toContain('copywriter') // no model on this host
    const versions = page.getByTestId('autoedit-variants')
    await expect(versions).toBeVisible()
    await versions.getByRole('radio', { name: 'In order' }).click()
    await expect
      .poll(() => mainClips(lastSave(mock)).map((c) => (c.type === 'video' ? c.assetId : '')))
      .toEqual(['a1', 'a2'])
  })
})
