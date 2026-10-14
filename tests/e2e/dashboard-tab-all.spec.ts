/**
 * The Dashboard tab puts the view switch back on the front door when it is on
 * Newest (2026-09-30, when the front door was All; Now since 2026-10-14, when
 * the Today view was dropped) — from another page and when already on the
 * dashboard, on the desktop sidebar and on the phone tab bar. Already on the
 * dashboard, it also turns Now's Show all off.
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

test.describe('Dashboard tab shows Now', () => {
  test.afterEach(async ({ authenticatedPage: page }) => {
    await page.request.patch('/api/user/preferences', { data: { default_grouping: 'project' } })
  })

  test('from another page, Newest switches back to Now', async ({ authenticatedPage: page }) => {
    await page.goto('/')
    await switchView(page, 'Newest')
    await page.goto('/history')
    const saved = waitForPreferenceSave(page, 'default_grouping')
    await sidebarTab(page).click()
    await page.waitForURL('/')
    await saved
    await expect(view(page, 'Now')).toHaveAttribute('aria-pressed', 'true')
  })

  test('already on the dashboard, Newest switches back to Now', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/')
    await switchView(page, 'Newest')
    const saved = waitForPreferenceSave(page, 'default_grouping')
    await sidebarTab(page).click()
    await saved
    await expect(view(page, 'Now')).toHaveAttribute('aria-pressed', 'true')
  })

  test('already on the dashboard, Show all goes back to Now', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/')
    await switchView(page, 'Now')
    const summary = page.locator('[data-now-summary]')
    await summary.getByRole('button', { name: /^Show all \d+$/ }).click()
    await expect(summary.getByRole('button', { name: /^Show \d+ now$/ })).toBeVisible()
    await sidebarTab(page).click()
    await expect(summary.getByRole('button', { name: /^Show all \d+$/ })).toBeVisible()
  })

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 375, height: 812 } })

    test('the tab bar’s Dashboard does the same', async ({ authenticatedPage: page }) => {
      await page.goto('/')
      await switchView(page, 'Newest')
      const saved = waitForPreferenceSave(page, 'default_grouping')
      await page.getByRole('link', { name: 'Dashboard' }).last().click()
      await saved
      await expect(view(page, 'Now')).toHaveAttribute('aria-pressed', 'true')
    })
  })
})
