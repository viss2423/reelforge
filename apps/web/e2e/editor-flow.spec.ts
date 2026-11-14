/**
 * The core loop on every form factor: create a project, upload a real (lavfi-generated) MP4
 * through the chunked uploader, see the host process it in the media library, put it on the
 * timeline, export, and get a playable MP4 back.
 *
 * Steps share one project, so they run serially; each test re-opens it by id.
 */
import { readFile } from 'node:fs/promises'
import type { TestInfo } from '@playwright/test'
import { createProject, expect, openMediaLibrary, test } from './fixtures.ts'
import { SAMPLE_SECONDS, SAMPLE_VIDEO } from './env.ts'

test.describe.configure({ mode: 'serial' })

/**
 * Assets are library-wide and every device project shares one server, so each Playwright
 * project uploads the sample under its own name to keep tiles unambiguous. A serial group
 * retries from its first test, so the attempt is part of the name too (the first attempt's
 * upload is still in the library).
 */
const sampleName = (info: TestInfo, tag: string): string =>
  `${tag}-${info.project.name.replace(/\W+/g, '-').toLowerCase()}-r${info.retry}.mp4`
const sampleFile = async (name: string) => ({
  name,
  mimeType: 'video/mp4',
  buffer: await readFile(SAMPLE_VIDEO),
})

let projectId = ''

test('create a project', async ({ pairedPage: page }) => {
  projectId = await createProject(page)
  await expect(page.getByLabel('Project name')).toHaveValue(/^Reel · /)
  // A fresh project has nothing to export yet.
  await page.getByTestId('export-open').click()
  await expect(page.getByTestId('export-start')).toBeDisabled()
})

test('upload an MP4 and see it in the library', async ({ pairedPage: page }, info) => {
  test.slow() // probe + proxy + thumbnails run on the host
  const name = sampleName(info, 'clip')
  await page.goto(`/p/${projectId}`)
  const library = await openMediaLibrary(page)

  await library.getByTestId('library-upload').setInputFiles(await sampleFile(name))

  const tile = library.getByRole('button', { name: `Add ${name} to timeline` })
  await expect(tile).toBeVisible({ timeout: 60_000 })
  // Placeable once the host has probed it (duration known); the proxy follows.
  await expect(tile).toHaveAttribute('data-ready', 'true', { timeout: 60_000 })
  await expect(tile).toContainText(`0:0${SAMPLE_SECONDS}`)
  await expect(tile).toHaveAttribute('data-proxy', 'ready', { timeout: 90_000 })
  await expect(library.getByRole('list', { name: 'Uploads' })).toHaveCount(0)

  // It is a library-wide asset: still there after a reload.
  await page.reload()
  const again = await openMediaLibrary(page)
  await expect(again.getByRole('button', { name: `Add ${name} to timeline` })).toBeVisible()
})

test('add it to the timeline and autosave', async ({ pairedPage: page }, info) => {
  await page.goto(`/p/${projectId}`)
  const library = await openMediaLibrary(page)
  await library.getByRole('button', { name: `Add ${sampleName(info, 'clip')} to timeline` }).click()

  const clips = page.getByTestId('timeline-clip')
  await expect(clips).toHaveCount(1)
  await expect(page.getByTestId('sync')).toHaveAttribute('data-status', 'saved')

  // Undo/redo round-trip through the toolbar.
  await page.getByRole('button', { name: /^Undo/ }).click()
  await expect(clips).toHaveCount(0)
  await page.getByRole('button', { name: /^Redo/ }).click()
  await expect(clips).toHaveCount(1)
  await expect(page.getByTestId('sync')).toHaveAttribute('data-status', 'saved')

  // The server has the edit: a reload (fresh store) shows the clip.
  await page.reload()
  await expect(page.getByTestId('timeline-clip')).toHaveCount(1)
})

test('export and download the MP4', async ({ pairedPage: page }) => {
  test.slow()
  await page.goto(`/p/${projectId}`)
  await expect(page.getByTestId('timeline-clip')).toHaveCount(1)

  await page.getByTestId('export-open').click()
  const start = page.getByTestId('export-start')
  await expect(start).toBeEnabled()
  await start.click()

  await expect(page.getByTestId('export-done')).toBeVisible({ timeout: 150_000 })

  // The Download link is a plain attachment link. Fetch it with the page's session instead of
  // driving a browser download: WebKit on Windows never fires Playwright's download event and
  // Chromium intermittently reports downloads from self-signed origins as canceled.
  const link = page.getByTestId('export-download')
  await expect(link).toHaveAttribute('download', /\.mp4$/i)
  const res = await page.request.get((await link.getAttribute('href'))!)
  expect(res.status()).toBe(200)
  expect(res.headers()['content-type']).toBe('video/mp4')
  expect(res.headers()['content-disposition']).toMatch(/^attachment;.*\.mp4/i)
  const body = await res.body()
  // A 3 s 1080×1920 render is comfortably above this; an error page is far below.
  expect(body.length).toBeGreaterThan(50_000)
  // ISO BMFF: the file starts with an `ftyp` box.
  expect(body.subarray(4, 8).toString('latin1')).toBe('ftyp')

  // The finished export is listed on the Exports page too; the newest one opens expanded with
  // its actions, and its header collapses/expands it.
  await page.goto('/exports')
  const row = page.getByTestId('exports').locator('li[data-status="done"]').first()
  await expect(row.getByTestId('export-download')).toBeVisible()
  await row.getByRole('button', { expanded: true }).click()
  await expect(row.getByTestId('export-download')).toBeHidden()
  await row.getByRole('button', { expanded: false }).click()
  await expect(row.getByTestId('export-download')).toBeVisible()
})

test('import media straight into a new project', async ({ pairedPage: page }, info) => {
  test.slow()
  await page.goto('/')
  await page.getByTestId('import-media').setInputFiles(await sampleFile(sampleName(info, 'import')))
  await expect(page.getByTestId('editor')).toBeVisible()
  // The editor places the clip itself once the host has probed it.
  await expect(page.getByTestId('timeline-clip')).toHaveCount(1, { timeout: 90_000 })
})
