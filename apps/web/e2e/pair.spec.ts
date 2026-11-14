/**
 * Pairing: an unpaired device is sent to /pair, a wrong code is rejected with an actionable
 * message, the right code pairs and lands on Home, and QR links (`?code=`) pair hands-free.
 *
 * Playwright's browser runs on the host itself, where the app would normally pair over
 * loopback without a code (`POST /api/pair/local`). That route is blocked here so the specs
 * exercise the phone path.
 */
import { expect, test } from '@playwright/test'
import { E2E_PAIR_CODE } from './env.ts'

test.beforeEach(async ({ page }) => {
  await page.route('**/api/pair/local', (route) =>
    route.fulfill({ status: 403, json: { error: 'loopback pairing disabled in this test' } }),
  )
})

test('redirects to pairing, rejects a wrong code, pairs with the right one', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveURL(/\/pair/)
  await expect(page.getByRole('heading', { name: 'Connect to your ReelForge' })).toBeVisible()

  const input = page.getByLabel('Pairing code')
  // Non-digits are dropped as the user types.
  await input.pressSequentially('12ab')
  await expect(input).toHaveValue('12')
  await input.fill('')

  const wrong = '135797' // anything but E2E_PAIR_CODE
  await input.fill(wrong)
  await expect(page.getByRole('alert')).toContainText(/wrong or has expired/)
  await expect(page).toHaveURL(/\/pair/)

  await input.fill(E2E_PAIR_CODE)
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('button', { name: 'New project' })).toBeVisible()

  // The session survives a reload (cookie + stored token).
  await page.reload()
  await expect(page.getByRole('button', { name: 'New project' })).toBeVisible()
})

test('QR link pairs automatically and honours ?next', async ({ page }) => {
  await page.goto(`/pair?code=${E2E_PAIR_CODE}&next=/settings`)
  await expect(page).toHaveURL(/\/settings$/)
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
})
