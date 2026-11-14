/**
 * Shared Playwright fixtures: a `pairedPage` that is already authenticated (pairs through
 * the real `POST /api/pair` with the test code, so the context gets the server's HttpOnly
 * cookie, and seeds the localStorage token the app uses for `Authorization` / WebSocket),
 * plus helpers for the editor layouts (desktop shows the media library inline, phones open
 * it in a bottom sheet).
 */
import { expect, test as base, type Page } from '@playwright/test'
import { E2E_PAIR_CODE } from './env.ts'

interface Session {
  token: string
  deviceId: string
}

/** Pairs the page's browser context via the API and returns the session. */
export const pairContext = async (page: Page): Promise<Session> => {
  const res = await page.request.post('/api/pair', {
    data: { code: E2E_PAIR_CODE, deviceName: 'Playwright' },
  })
  expect(res.ok(), `POST /api/pair → ${res.status()}`).toBe(true)
  const session = (await res.json()) as Session
  await page.addInitScript((s: Session) => {
    localStorage.setItem('rf.token', s.token)
    localStorage.setItem('rf.deviceId', s.deviceId)
  }, session)
  return session
}

export const test = base.extend<{ pairedPage: Page }>({
  pairedPage: async ({ page }, use) => {
    await pairContext(page)
    await use(page)
  },
})

export { expect }

/** True when the project runs the desktop editor layout (≥ 1024 px wide). */
export const isDesktop = (page: Page): boolean => (page.viewportSize()?.width ?? 0) >= 1024

/** Creates an empty project from Home and waits for the editor. Returns its id. */
export const createProject = async (page: Page): Promise<string> => {
  await page.goto('/')
  await page.getByRole('button', { name: 'New project' }).click()
  await expect(page.getByTestId('editor')).toBeVisible()
  const id = /\/p\/([^/?#]+)/.exec(page.url())?.[1]
  expect(id, `editor URL ${page.url()}`).toBeTruthy()
  return id!
}

/** Makes the media library visible (opens the sheet on phones) and returns its region. */
export const openMediaLibrary = async (page: Page) => {
  const library = page.getByRole('region', { name: 'Media' })
  // On phones the sheet stays open after an upload (and then covers the Add media button).
  if (!isDesktop(page) && !(await library.isVisible())) await page.getByTestId('add-media').click()
  await expect(library).toBeVisible()
  return library
}
