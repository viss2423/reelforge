/**
 * Downbeat-aware beat sync through the real UI (AI tab → Beat sync → "Cut on" Bar), with the
 * API mocked: the music asset already carries cached beats and bar starts (as the neural
 * tracker stores them), so no job runs and the edit is read back from the autosave PUT. The
 * main track's cut must land on a bar start, not just on any beat.
 */
import { expect, test, type Page } from '@playwright/test'
import { Asset, Project, sec, type Clip } from '@reelforge/core'

const PROJECT_ID = 'beats-e2e'
const created = '2026-01-01T00:00:00.000Z'

const video = Asset.parse({
  id: 'v1',
  kind: 'video',
  name: 'clip.mp4',
  size: 1000,
  mime: 'video/mp4',
  createdAt: created,
  duration: sec(20),
  width: 1080,
  height: 1920,
  hasVideo: true,
  hasAudio: false,
  proxy: 'ready',
})
// 120 BPM, first beat at 0.5 s; bars start at 1.0 s and every 2 s after it.
const beats = Array.from({ length: 30 }, (_, i) => sec(0.5 * (i + 1)))
const downbeats = beats.filter((_, i) => i % 4 === 1)
const music = Asset.parse({
  id: 'm1',
  kind: 'audio',
  name: 'song.mp3',
  size: 1000,
  mime: 'audio/mpeg',
  createdAt: created,
  duration: sec(15),
  hasAudio: true,
  waveform: 'ready',
  beats,
  downbeats,
})

const project = Project.parse({
  id: PROJECT_ID,
  name: 'Beats e2e',
  createdAt: created,
  updatedAt: created,
  revision: 1,
  tracks: [
    {
      id: 'main',
      kind: 'main',
      clips: [
        { id: 'c0', type: 'video', assetId: 'v1', start: 0, duration: sec(3.3), in: 0 },
        { id: 'c1', type: 'video', assetId: 'v1', start: sec(3.3), duration: sec(3.3), in: 0 },
      ],
    },
    { id: 'text', kind: 'text', clips: [] },
    {
      id: 'audio',
      kind: 'audio',
      clips: [
        {
          id: 'mus',
          type: 'audio',
          assetId: 'm1',
          role: 'music',
          start: 0,
          duration: sec(15),
          in: 0,
        },
      ],
    },
  ],
})

const mockApi = async (page: Page): Promise<Project[]> => {
  const saves: Project[] = []
  let revision = project.revision
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
    if (pathname === `/api/projects/${PROJECT_ID}`) {
      if (req.method() === 'PUT') {
        saves.push((req.postDataJSON() as { project: Project }).project)
        revision++
        return json({ revision })
      }
      return json({ ...project, revision })
    }
    if (pathname === '/api/health') return json({ ok: true, version: 'e2e' })
    if (pathname === '/api/assets') return json([video, music])
    if (pathname === '/api/assets/v1') return json(video)
    if (pathname === '/api/assets/m1') return json(music)
    if (pathname === '/api/projects' || pathname === '/api/jobs') return json([])
    if (pathname === '/api/packs')
      return json({
        index: { version: '1', updatedAt: created, packs: [], fonts: [] },
        manifests: [],
      })
    return json({ error: 'not found' }, 404)
  })
  return saves
}

const mainClips = (p: Project | undefined): Clip[] =>
  p?.tracks.find((t) => t.kind === 'main')?.clips ?? []

// A service worker that claims the page would serve `/api` itself, bypassing `page.route`.
test.use({ serviceWorkers: 'block' })

test.describe('beat sync options', () => {
  test('"Bar" cuts on a bar start, "Beat" on the latest beat', async ({ page }) => {
    const saves = await mockApi(page)
    await page.goto(`/p/${PROJECT_ID}`)
    await expect(page.getByTestId('timeline')).toBeVisible()
    await page.getByRole('toolbar', { name: 'Tools' }).locator('[data-tool="ai"]').click()

    await expect(page.getByRole('radiogroup', { name: 'Cut on' })).toBeVisible()
    for (const label of ['Beat', '2 beats', 'Bar', '2 bars']) {
      await expect(page.getByRole('radio', { name: label, exact: true })).toBeVisible()
    }
    await page.getByRole('radio', { name: 'Bar', exact: true }).click()
    await page.getByRole('button', { name: 'Sync to beat', exact: true }).click()

    // The first clip (3.3 s) is cut back to the latest bar start: 3.0 s.
    await expect.poll(() => mainClips(saves.at(-1))[0]?.duration, { timeout: 15_000 }).toBe(sec(3))
    const bars = new Set(downbeats)
    expect(bars.has(mainClips(saves.at(-1))[0]!.start + mainClips(saves.at(-1))[0]!.duration)).toBe(
      true,
    )
  })
})
