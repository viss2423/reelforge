/**
 * Trending Now + generated templates, with the API mocked (`page.route`): the Trending tab
 * shows today's topics, sounds and hashtags with their sources; tapping a topic opens a reel
 * idea whose "Make this reel" opens Auto Edit with the topic and vibe; refresh starts a host run; Home
 * lists generated templates first with a "New today" badge; Settings shows the Trends
 * section with source status and the refresh button.
 */
import { expect, test, type Page } from '@playwright/test'
import { PackManifest } from '@reelforge/core'

const template = (id: string, name: string, trendScore: number, tags: string[] = []) => ({
  id,
  name,
  trendScore,
  tags,
  slots: [{ duration: 1_000_000 }, { duration: 1_000_000 }, { duration: 2_000_000 }],
  musicHint: { title: 'Dracula — Tame Impala', bpm: 120 },
})

const manifests = [
  PackManifest.parse({
    id: 'trending-2026-11',
    version: '1.0.0',
    name: 'November',
    curatedAt: '2026-11-01',
    templates: [template('photo-dump', 'Photo Dump', 99, ['photo-dump'])],
  }),
  PackManifest.parse({
    id: 'trending-live',
    version: '2026.11.20',
    name: 'Trending today',
    curatedAt: '2026-11-20',
    templates: [template('snow-day-dump', 'Snow Day Dump', 90, ['new', 'winter'])],
  }),
]

const now = new Date().toISOString()
const trends = {
  enabled: true,
  generatedAt: now,
  lastAttemptAt: now,
  lastError: null,
  stale: false,
  running: false,
  nextRunAt: now,
  sources: [
    { id: 'google-trends', name: 'Google Trends', state: 'ok', items: 20 },
    { id: 'deezer', name: 'Deezer', state: 'ok', items: 15 },
    {
      id: 'youtube',
      name: 'YouTube',
      state: 'disabled',
      items: 0,
      error: 'Set YOUTUBE_API_KEY (free) to enable',
    },
  ],
  topics: [
    { text: 'oklahoma state basketball', weight: 1, sources: ['google-trends'] },
    { text: 'thanksgiving', weight: 0.5, sources: ['calendar'] },
  ],
  hashtags: ['winterphotodump', 'cozyseason'],
  formats: [{ text: 'photo dump', weight: 1, sources: ['reddit', 'youtube'] }],
  aesthetics: [],
  sounds: [
    {
      title: 'Dracula',
      artist: 'Tame Impala',
      bpm: 118,
      measured: false,
      weight: 1,
      sources: ['deezer'],
      link: 'https://www.deezer.com/search/Dracula',
    },
  ],
  items: [
    {
      ref: 'trending-live/snow-day-dump',
      collection: 'templates',
      name: 'Snow Day Dump',
      trend: 'photo dump',
      kind: 'format',
      createdAt: now,
      fresh: true,
    },
  ],
  ideas: [
    {
      topic: 'oklahoma state basketball',
      title: 'Game night recap',
      hooks: ['POV: you were in the arena', 'Nobody saw this coming', 'Wait for the last shot'],
      shots: ['Crowd wide shot', 'Scoreboard close-up', 'Celebration'],
      caption: 'What a night',
      hashtags: ['gameday'],
      template: 'trending-live/snow-day-dump',
    },
  ],
  llm: { used: true },
  settings: { autoPublish: false },
  publishAvailable: false,
  publish: null,
  ms: null,
}

const mockApi = async (page: Page) => {
  const calls = { refresh: 0, ideas: [] as string[] }
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
    if (pathname === '/api/trends') return json(trends)
    if (pathname === '/api/trends/refresh') {
      calls.refresh++
      return json({ jobId: 'j1' }, 202)
    }
    if (pathname === '/api/trends/ideas') {
      const { topic } = req.postDataJSON() as { topic: string }
      calls.ideas.push(topic)
      return json({
        topic,
        title: 'Thanksgiving table',
        hooks: ['Things I wish I knew about thanksgiving'],
        shots: ['Table wide', 'Close-up'],
        caption: 'Happy thanksgiving',
        hashtags: ['thanksgiving'],
        template: 'trending-2026-11/photo-dump',
      })
    }
    if (pathname === '/api/health') return json({ ok: true, version: 'e2e' })
    if (pathname === '/api/packs')
      return json({
        version: '1',
        source: 'bundled',
        index: { version: '1', updatedAt: '2026-11-20', packs: [], fonts: [] },
        manifests,
      })
    if (pathname === '/api/devices') return json([])
    if (pathname === '/api/system') return json({})
    if (['/api/projects', '/api/jobs', '/api/assets'].includes(pathname)) return json([])
    return json({ error: 'not found' }, 404)
  })
  return calls
}

test.use({ serviceWorkers: 'block' })

test('Trending Now: topics, sounds, idea → Make this reel, refresh', async ({ page }) => {
  const calls = await mockApi(page)
  await page.goto('/')
  await page.getByRole('link', { name: 'Trending' }).filter({ visible: true }).first().click()
  await expect(page).toHaveURL(/\/trending$/)
  await expect(page.getByTestId('trends-updated')).toContainText('Google Trends')

  const topics = page.getByTestId('trend-topics')
  await expect(topics.getByText('oklahoma state basketball')).toBeVisible()
  await expect(page.getByTestId('trend-sounds')).toContainText('Dracula')
  await expect(page.getByTestId('trend-sounds')).toContainText('118 BPM (est.)')
  await expect(page.getByRole('link', { name: 'Find Dracula' })).toHaveAttribute(
    'href',
    /deezer\.com\/search/,
  )
  await expect(page.getByTestId('trend-templates')).toContainText('New today')
  await expect(page.getByTestId('trend-templates')).toContainText('from “photo dump”')

  // Cached idea from the daily run.
  await page.getByRole('button', { name: 'Reel idea for oklahoma state basketball' }).click()
  const idea = page.getByTestId('reel-idea')
  await expect(idea).toContainText('POV: you were in the arena')
  await expect(idea).toContainText('Scoreboard close-up')
  await expect(idea).toContainText('#gameday')
  await expect(idea).toContainText('Snow Day Dump')
  await idea.getByRole('button', { name: 'Make this reel' }).click()
  await expect(page).toHaveURL(/[?&]autoedit=1&topic=oklahoma\+state\+basketball&vibe=\w+/)
  await expect(page.getByTestId('autoedit-start')).toBeVisible()
  await page.goto('/trending')

  // On-demand idea for a topic without one.
  await page.getByRole('button', { name: 'Reel idea for thanksgiving' }).click()
  await expect(page.getByTestId('reel-idea')).toContainText(
    'Things I wish I knew about thanksgiving',
  )
  expect(calls.ideas).toEqual(['thanksgiving'])
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Refresh trends' }).click()
  await expect.poll(() => calls.refresh).toBe(1)
})

test('Home lists generated templates first with a New today badge', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
  const carousel = page.getByTestId('template-carousel')
  const first = carousel.locator('li').first()
  await expect(first).toContainText('Snow Day Dump')
  await expect(first).toContainText('New today')
  await expect(first).toContainText('from “photo dump”')
  await expect(carousel.locator('li').nth(1)).toContainText('Photo Dump')
})

test('Settings → Trends: sources, refresh, publish toggle state', async ({ page }) => {
  const calls = await mockApi(page)
  await page.goto('/settings')
  const sources = page.getByTestId('trend-sources')
  await expect(sources).toContainText('Google Trends')
  await expect(sources).toContainText('20 items')
  await expect(sources).toContainText('Set YOUTUBE_API_KEY')
  await expect(page.getByRole('switch', { name: 'Auto-publish trends' })).toBeDisabled()
  await page.getByRole('button', { name: 'Refresh now' }).click()
  await expect.poll(() => calls.refresh).toBe(1)
})
