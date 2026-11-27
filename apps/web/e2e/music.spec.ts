/**
 * Auto music in real browsers on every form factor, with the API mocked (`page.route`):
 * Audio panel → "Add music automatically" → the host's pick lands on the timeline as a music
 * clip from the chorus with a beat grid; the library browser lists tracks with licences and
 * previews; CC BY credits appear in the export dialog; the template's trending-sound hint
 * is copyable; "Trending sounds today" copies a chart sound's name, inserts a similar free
 * track, previews the official clip with the reel, matches cuts to it and makes the export
 * default to "No music".
 */
import { expect, test, type Page } from '@playwright/test'
import { Asset, Project, sec, type MusicSuggestResult, type RankedTrack } from '@reelforge/core'

const PROJECT_ID = 'music-e2e'

const video = Asset.parse({
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

const musicAsset = Asset.parse({
  id: 'm1',
  kind: 'audio',
  name: 'DJ X - Night Drive.mp3',
  size: 5000,
  mime: 'audio/mpeg',
  createdAt: '2026-01-01T00:00:00.000Z',
  duration: sec(90),
  hasAudio: true,
  proxy: 'not-needed',
  waveform: 'not-needed',
  beats: [sec(30), sec(30.5), sec(31), sec(31.5), sec(32)],
  music: {
    source: 'openverse',
    trackId: 'openverse:night',
    title: 'Night Drive',
    artist: 'DJ X',
    licence: { code: 'by', name: 'CC BY 4.0', attributionRequired: true },
    attribution: '"Night Drive" by DJ X · CC BY 4.0',
    bpm: 120,
    section: { start: sec(30), end: sec(40) },
    downbeats: [sec(30)],
  },
})

const track = (id: string, title: string, over: Partial<RankedTrack> = {}): RankedTrack => ({
  id,
  source: 'openverse',
  title,
  artist: 'DJ X',
  licence: { code: 'by', name: 'CC BY 4.0', attributionRequired: true },
  duration: sec(90),
  tags: [],
  genres: [],
  cached: true,
  analyzed: true,
  bpm: 120,
  attribution: `"${title}" by DJ X · CC BY 4.0`,
  score: 0.9,
  reasons: ['upbeat', '120 BPM'],
  ...over,
})

const project = Project.parse({
  id: PROJECT_ID,
  name: 'Music e2e',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  revision: 1,
  templateRef: 'trend/fast',
  tracks: [
    {
      id: 'main',
      kind: 'main',
      clips: [0, 1, 2, 3].map((i) => ({
        id: `m${i}`,
        type: 'video',
        assetId: 'a1',
        start: sec(i * 2),
        duration: sec(2),
        in: sec(i * 2),
      })),
    },
    { id: 'text', kind: 'text', clips: [] },
    { id: 'audio', kind: 'audio', clips: [] },
  ],
})

interface Mock {
  saves: Project[]
  suggestBodies: Array<Record<string, unknown>>
  imports: Array<Record<string, unknown>>
  jobs: Array<Record<string, unknown>>
  previews: string[]
}

/** A short silent mono WAV the browser can decode (stands in for the 30 s preview clip). */
const silentWav = (seconds = 2, rate = 8000): Buffer => {
  const n = seconds * rate
  const b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + n * 2, 4)
  b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22)
  b.writeUInt32LE(rate, 24)
  b.writeUInt32LE(rate * 2, 28)
  b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36)
  b.writeUInt32LE(n * 2, 40)
  return b
}

const trends = {
  enabled: true,
  generatedAt: '2026-11-26T06:00:00.000Z',
  lastError: null,
  stale: false,
  running: false,
  nextRunAt: null,
  sources: [],
  topics: [],
  hashtags: [],
  formats: [],
  aesthetics: [],
  sounds: [
    {
      title: 'Club Hit',
      artist: 'DJ Y',
      bpm: 126,
      measured: true,
      weight: 1,
      sources: ['deezer'],
      link: 'https://www.deezer.com/search/club',
      genre: 'Dance',
      mood: 'energetic',
      energy: 0.85,
      firstSeen: '2026-11-26T06:00:00.000Z',
      fresh: true,
    },
    {
      title: 'Rare Song',
      bpm: 90,
      measured: false,
      weight: 0.5,
      sources: ['apple-music'],
      link: 'https://www.deezer.com/search/rare',
      fresh: false,
    },
  ],
  items: [],
  ideas: [],
  llm: { used: false },
  settings: { autoPublish: false },
  publishAvailable: false,
  soundPreview: true,
  publish: null,
}

const mockApi = async (page: Page): Promise<Mock> => {
  const mock: Mock = { saves: [], suggestBodies: [], imports: [], jobs: [], previews: [] }
  let revision = project.revision
  await page.addInitScript(() => {
    localStorage.setItem('rf.token', 'e2e-token')
    localStorage.setItem('rf.deviceId', 'e2e-device')
    // The clipboard is not available to headless pages without permissions.
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: (t: string) => (
          ((window as { __copied?: string }).__copied = t),
          Promise.resolve()
        ),
      },
    })
  })
  await page.routeWebSocket(/\/api\/events/, () => undefined)
  await page.route(/\/api\/music\/tracks\/.*\/preview/, (route) =>
    route.fulfill({ status: 200, contentType: 'audio/mp4', body: Buffer.alloc(16) }),
  )
  await page.route(/\/api\//, async (route) => {
    const req = route.request()
    const { pathname, searchParams } = new URL(req.url())
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
    if (pathname === '/api/assets') return json([video])
    if (pathname === '/api/jobs' && req.method() === 'POST') {
      const body = req.postDataJSON() as Record<string, unknown>
      mock.jobs.push(body)
      return json({ id: 'job1', kind: 'export', status: 'queued', progress: 0, createdAt: '' })
    }
    if (pathname === '/api/projects' || pathname === '/api/jobs') return json([])
    if (pathname === '/api/trends') return json(trends)
    if (pathname === '/api/trends/sounds/preview-info')
      return json(
        searchParams.get('title') === 'Club Hit'
          ? { available: true, source: 'deezer', duration: 30 }
          : { available: false },
      )
    if (pathname === '/api/trends/sounds/preview') {
      mock.previews.push(searchParams.get('title') ?? '')
      return route.fulfill({ status: 200, contentType: 'audio/wav', body: silentWav() })
    }
    if (pathname === '/api/trends/sounds/beats')
      return json({
        bpm: 126,
        beats: Array.from({ length: 63 }, (_, i) => Math.round(130_000 + (i * 60_000_000) / 126)),
        downbeats: Array.from({ length: 16 }, (_, i) =>
          Math.round(130_000 + (i * 4 * 60_000_000) / 126),
        ),
        duration: sec(30),
        engine: 'neural',
      })
    if (pathname === '/api/packs')
      return json({
        index: { version: '1', updatedAt: '2026-01-01T00:00:00.000Z', packs: [], fonts: [] },
        manifests: [
          {
            id: 'trend',
            version: '1',
            name: 'Trend',
            curatedAt: '2026-01-01',
            templates: [
              {
                id: 'fast',
                name: 'Fast',
                trendScore: 50,
                slots: [],
                musicHint: { title: 'Espresso (sped up)', bpm: 104 },
              },
            ],
          },
        ],
      })
    if (pathname === '/api/music/suggest') {
      mock.suggestBodies.push(req.postDataJSON() as Record<string, unknown>)
      const result: MusicSuggestResult = {
        tracks: [track('openverse:night', 'Night Drive'), track('openverse:day', 'Day Drive')],
        terms: 'upbeat happy',
        warnings: [],
        tookMs: 12,
      }
      return json(result)
    }
    if (pathname === '/api/music/import') {
      mock.imports.push(req.postDataJSON() as Record<string, unknown>)
      return json({
        asset: musicAsset,
        bpm: 120,
        beats: musicAsset.beats,
        downbeats: [sec(30)],
        section: { start: sec(30), end: sec(38) },
      })
    }
    if (pathname === '/api/music/search') {
      expect(searchParams.get('mood')).toBe('chill')
      return json({
        tracks: [
          track('openverse:night', 'Night Drive'),
          track('ccmixter:7', 'Sunday Lofi', {
            licence: { code: 'cc0', name: 'CC0 1.0', attributionRequired: false },
          }),
        ],
        warnings: [],
      })
    }
    return json({ error: 'not found' }, 404)
  })
  return mock
}

const openAudioPanel = async (page: Page) => {
  await page.goto(`/p/${PROJECT_ID}`)
  await expect(page.getByTestId('timeline')).toBeVisible()
  await page.getByRole('button', { name: 'Audio', exact: true }).click()
  await expect(page.getByTestId('auto-music')).toBeVisible()
}

// A service worker that claims the page would serve `/api` itself, bypassing `page.route`.
test.use({ serviceWorkers: 'block' })

test.describe('auto music', () => {
  test('one tap adds music from the chorus, trimmed to the reel, with credit and undo', async ({
    page,
  }) => {
    const mock = await mockApi(page)
    await openAudioPanel(page)
    await page.getByRole('radio', { name: 'Energetic' }).click()
    await page.getByTestId('auto-music').click()

    await expect(page.getByTestId('auto-music-pick')).toContainText('Night Drive')
    await expect(page.getByTestId('auto-music-credit')).toContainText('CC BY 4.0')
    expect(mock.suggestBodies[0]).toMatchObject({
      mood: 'energetic',
      duration: sec(8),
      hasSpeech: false,
      projectId: PROJECT_ID,
    })
    expect(mock.imports[0]).toMatchObject({ trackId: 'openverse:night', length: sec(8) })

    await expect
      .poll(
        () =>
          mock.saves
            .at(-1)
            ?.tracks.flatMap((t) => t.clips)
            .filter((c) => c.type === 'audio').length,
      )
      .toBe(1)
    const save = mock.saves.at(-1)!
    const clip = save.tracks.flatMap((t) => t.clips).find((c) => c.type === 'audio')!
    expect(clip).toMatchObject({
      assetId: 'm1',
      start: 0,
      duration: sec(8),
      in: sec(30),
      role: 'music',
    })
    expect(save.markers.filter((m) => m.kind === 'beat')).toHaveLength(5)

    // "Try another" swaps the bed (one music clip at a time).
    await page.getByRole('button', { name: /Try another: Day Drive/ }).click()
    await expect(page.getByTestId('auto-music-pick')).toContainText('Day Drive')
    await expect
      .poll(
        () =>
          mock.saves
            .at(-1)
            ?.tracks.flatMap((t) => t.clips)
            .filter((c) => c.type === 'audio').length,
      )
      .toBe(1)
  })

  test('browses the library, previews a track and adds it', async ({ page, browserName }) => {
    const mock = await mockApi(page)
    await openAudioPanel(page)
    await page.getByRole('tab', { name: 'Library' }).click()
    await page.getByRole('radio', { name: 'Chill' }).last().click()

    const rows = page.getByTestId('music-track')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0)).toContainText('CC BY 4.0')
    await expect(rows.nth(1)).toContainText('CC0 1.0')

    // Playwright's WebKit build does not fetch <audio> sources, so only Chromium asserts the
    // request (the fake 16-byte audio cannot play, so the player resets: the request is the contract).
    const previewRequest =
      browserName === 'webkit'
        ? undefined
        : page.waitForRequest(/\/api\/music\/tracks\/.*\/preview/)
    await page.getByRole('button', { name: 'Preview Sunday Lofi' }).click()
    if (previewRequest) expect((await previewRequest).url()).toContain('ccmixter')

    await page.getByRole('button', { name: 'Add Night Drive' }).click()
    await expect.poll(() => mock.imports.length).toBe(1)
    await expect
      .poll(() =>
        mock.saves
          .at(-1)
          ?.tracks.flatMap((t) => t.clips)
          .some((c) => c.type === 'audio'),
      )
      .toBe(true)
  })

  test('shows the trending sound hint with a copy button', async ({ page }) => {
    await mockApi(page)
    await openAudioPanel(page)
    const hint = page.getByTestId('trending-hint')
    await expect(hint).toContainText('Espresso (sped up)')
    await expect(hint).toContainText('104 BPM')
    await hint.getByRole('button', { name: 'Copy' }).click()
    expect(await page.evaluate(() => (window as { __copied?: string }).__copied)).toBe(
      'Espresso (sped up)',
    )
  })

  test('the export dialog offers the CC BY credit for the caption', async ({ page }) => {
    await mockApi(page)
    await openAudioPanel(page)
    await page.getByTestId('auto-music').click()
    await expect(page.getByTestId('auto-music-pick')).toBeVisible()
    await page
      .getByRole('button', { name: /^Export$/ })
      .first()
      .click()
    const credits = page.getByTestId('music-credits')
    await expect(credits).toContainText('"Night Drive" by DJ X · CC BY 4.0')
    await credits.getByRole('button', { name: 'Copy credits' }).click()
    expect(await page.evaluate(() => (window as { __copied?: string }).__copied)).toContain(
      '🎵 Music: "Night Drive"',
    )
  })
})

test.describe('trending sounds', () => {
  test('copy the name, insert a similar free track (trend-matched)', async ({ page }) => {
    const mock = await mockApi(page)
    await openAudioPanel(page)
    const row = page.getByTestId('trending-sound').first()
    await expect(row).toContainText('Club Hit')
    await expect(row).toContainText('126 BPM')
    await expect(row).toContainText('New today')
    await row.getByRole('button', { name: 'More for Club Hit' }).click()
    await row.getByRole('button', { name: 'Add this sound when you post' }).click()
    expect(await page.evaluate(() => (window as { __copied?: string }).__copied)).toBe(
      'Club Hit – DJ Y',
    )
    await row.getByTestId('find-similar').click()
    await expect.poll(() => mock.imports.length).toBe(1)
    expect(mock.suggestBodies.at(-1)).toMatchObject({
      order: 'trend',
      sound: { title: 'Club Hit', artist: 'DJ Y', bpm: 126, mood: 'energetic' },
    })
    await expect
      .poll(() =>
        mock.saves
          .at(-1)
          ?.tracks.flatMap((t) => t.clips)
          .some((c) => c.type === 'audio' && c.role === 'music'),
      )
      .toBe(true)
  })

  test('preview with my reel, match cuts, export without music', async ({ page }) => {
    const mock = await mockApi(page)
    await openAudioPanel(page)
    const row = page.getByTestId('trending-sound').first()
    await row.getByTestId('preview-sound').click()
    await expect(row.getByTestId('sound-previewing')).toBeVisible()
    expect(mock.previews).toEqual(['Club Hit'])
    // The preview never becomes an asset or a clip.
    expect(mock.imports).toHaveLength(0)

    const saves = mock.saves.length
    await row.getByTestId('match-cuts').click()
    await expect.poll(() => mock.saves.length).toBeGreaterThan(saves)

    await page
      .getByRole('button', { name: /^Export$/ })
      .first()
      .click()
    await expect(page.getByTestId('export-music-hint')).toContainText('add the sound in Instagram')
    await page.getByTestId('export-start').click()
    await expect.poll(() => mock.jobs.length).toBe(1)
    expect(mock.jobs[0]).toMatchObject({ kind: 'export', payload: { settings: { music: 'none' } } })
  })

  test('a sound without an official preview offers the closest free match', async ({ page }) => {
    const mock = await mockApi(page)
    await openAudioPanel(page)
    const row = page.getByTestId('trending-sound').nth(1)
    await row.getByTestId('preview-sound').click()
    await expect(row.getByTestId('no-preview')).toBeVisible()
    await row.getByRole('button', { name: 'Use the closest free match' }).click()
    await expect.poll(() => mock.imports.length).toBe(1)
    expect(mock.previews).toHaveLength(0)
  })

  test('with previews off (host default): listen on Deezer, BPM cuts, copy → export without music', async ({
    page,
  }) => {
    const mock = await mockApi(page)
    await page.route('**/api/trends', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...trends, soundPreview: false }),
      }),
    )
    await openAudioPanel(page)
    const row = page.getByTestId('trending-sound').first()
    await expect(row.getByTestId('preview-sound')).toHaveCount(0)
    await expect(row.getByTestId('listen-sound')).toHaveAttribute('href', trends.sounds[0]!.link)
    const saves = mock.saves.length
    await row.getByRole('button', { name: 'More for Club Hit' }).click()
    await row.getByTestId('match-cuts').click()
    await expect.poll(() => mock.saves.length).toBeGreaterThan(saves)
    expect(mock.previews).toHaveLength(0)
    await row.getByRole('button', { name: 'Add this sound when you post' }).click()
    await page
      .getByRole('button', { name: /^Export$/ })
      .first()
      .click()
    await expect(page.getByTestId('export-music-hint')).toContainText('add the sound in Instagram')
  })
})
