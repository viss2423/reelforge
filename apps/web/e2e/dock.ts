/**
 * Editor shell helpers shared by the mocked and real-server specs: the tool dock (phones
 * keep most tools behind "More"), the stage's "⋯" menu and the timeline options.
 */
import { expect, type Page } from '@playwright/test'

/** A tool button in the dock itself. */
export const dockTool = (page: Page, id: string) =>
  page.getByRole('toolbar', { name: 'Tools' }).locator(`[data-tool="${id}"]`)

/**
 * Activates tool `id`: straight from the dock, or through the "More" grid (a panel tool
 * opened there then shows, pressed, in the dock).
 */
export const openTool = async (page: Page, id: string): Promise<void> => {
  const direct = dockTool(page, id)
  if (await direct.isVisible()) {
    await direct.click()
    return
  }
  await page.getByTestId('dock-more').click()
  await page.getByTestId('dock-more-sheet').locator(`[data-tool="${id}"]`).click()
}

/** Clicks an item (by test id) in the stage's glass "⋯" menu. */
export const stageOption = async (page: Page, testId: string): Promise<void> => {
  await page.getByTestId('stage-more').click()
  await page.getByTestId(testId).click()
}

/** Turns a timeline edit mode on from the timeline options, then closes them. */
export const enableEditMode = async (
  page: Page,
  testId: 'ripple-toggle' | 'roll-toggle',
): Promise<void> => {
  await page.getByTestId('timeline-options').click()
  const toggle = page.getByTestId(testId)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Escape')
  await expect(toggle).toBeHidden()
}
