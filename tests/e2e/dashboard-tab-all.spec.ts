/**
 * The Dashboard tab resets nothing (Trent, 2026-10-29: "No filters or
 * anything should be reset by tapping a tab"). Until then it put the view
 * switch back on Now when it was on Newest (2026-09-30) and, already on the
 * dashboard, turned Now's Show all off. Now a tap from another page opens the
 * dashboard as it was left, and a re-tap only scrolls (`useTabRetap`,
 * nav-retap-walk.spec) — on the desktop sidebar and on the phone tab bar.
 */
import { test, expect, waitForPreferenceSave } from './fixtures'
import type { Page } from '@playwright/test'

const view = (page: Page, name: string) => page.getByRole('button', { name, exact: true })

async function switchView(page: Page, name: string) {
  if ((await view(page, name).getAttribute('aria-pressed')) === 'true') return
  const saved = waitForPreferenceSave(page, 'default_grouping')
  await view(page, name).click()
  await saved
}

const sidebarTab = (page: Page) => page.locator('aside').getByRole('link', { name: 'Dashboard' })

test.describe('the Dashboard tab keeps the view', () => {
  test.afterEach(async ({ authenticatedPage: page }) => {
    await page.request.patch('/api/user/preferences', { data: { default_grouping: 'project' } })
  })

  test('from another page, Newest stays Newest', async ({ authenticatedPage: page }) => {
    await page.goto('/')
    await switchView(page, 'Newest')
    await page.goto('/history')
    await sidebarTab(page).click()
    await page.waitForURL('/')
    await expect(view(page, 'Newest')).toHaveAttribute('aria-pressed', 'true')
  })

  test('already on the dashboard, Newest stays Newest', async ({ authenticatedPage: page }) => {
    await page.goto('/')
    await switchView(page, 'Newest')
    await sidebarTab(page).click()
    await expect(view(page, 'Newest')).toHaveAttribute('aria-pressed', 'true')
  })

  test('already on the dashboard, Show all stays on', async ({ authenticatedPage: page }) => {
    await page.goto('/')
    await switchView(page, 'Now')
    const summary = page.locator('[data-now-summary]')
    await summary.getByRole('button', { name: /^Show all \d+$/ }).click()
    await expect(summary.getByRole('button', { name: /^Show \d+ now$/ })).toBeVisible()
    // Even at the end of the re-tap's cycle (nothing left that needs you).
    await page.evaluate(() =>
      document
        .querySelectorAll('[data-needs-you]')
        .forEach((el) => el.removeAttribute('data-needs-you')),
    )
    await sidebarTab(page).click()
    await expect(summary.getByRole('button', { name: /^Show \d+ now$/ })).toBeVisible()
  })

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 375, height: 812 } })

    test('the tab bar’s Dashboard keeps it too', async ({ authenticatedPage: page }) => {
      await page.goto('/')
      await switchView(page, 'Newest')
      await page.getByRole('link', { name: 'Dashboard' }).last().click()
      await expect(view(page, 'Newest')).toHaveAttribute('aria-pressed', 'true')
    })
  })
})
