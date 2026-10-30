/**
 * Re-tapping the tab you are on scrolls its page to the top (Trent,
 * 2026-10-29: "if you tap the tab, it should scroll you to the top the same
 * way it does when you tap on Dashboard… The same is true for quotas";
 * `scrollPageToTop`, `useTabRetap`). The phone's tab bar and the desktop
 * sidebar, every destination. The page is made taller than the screen first,
 * so there is always somewhere to scroll from.
 */
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

/**
 * The link's click handler is attached (React has hydrated it): before that a
 * click is the browser's own navigation to the same page, which scrolls
 * nowhere.
 */
async function hydrated(page: Page, scope: string, path: string) {
  await page.waitForFunction(
    ([scope, path]) => {
      const link = document.querySelector(`${scope} a[href="${path}"]`)
      return !!link && Object.keys(link).some((k) => k.startsWith('__reactProps'))
    },
    [scope, path],
  )
}

async function scrolledDown(page: Page) {
  await page.addStyleTag({ content: 'body { min-height: 4000px; }' })
  await page.evaluate(() => window.scrollTo(0, 1200))
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(1000)
}

test.describe('phone tab bar', () => {
  test.use({ viewport: { width: 390, height: 700 } })
  for (const [path, label] of [
    ['/reminders', 'Reminders'],
    ['/quotas', 'Quotas'],
    ['/history', 'History'],
  ] as const) {
    test(`re-tapping ${label} scrolls to the top and stays on the page`, async ({
      authenticatedPage: page,
    }) => {
      await page.goto(path)
      await hydrated(page, 'nav', path)
      await scrolledDown(page)
      await page.locator('nav').getByRole('link', { name: label, exact: true }).click()
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
      expect(new URL(page.url()).pathname).toBe(path)
    })
  }
})

test.describe('desktop sidebar', () => {
  test.use({ viewport: { width: 1280, height: 700 } })
  for (const [path, label] of [
    ['/reminders', 'Reminders'],
    ['/quotas', 'Quotas'],
    ['/history', 'History'],
    ['/archive', 'Archive'],
    ['/trash', 'Trash'],
    ['/settings', 'Settings'],
  ] as const) {
    test(`clicking ${label} while on it scrolls to the top`, async ({
      authenticatedPage: page,
    }) => {
      await page.goto(path)
      await hydrated(page, 'aside', path)
      await scrolledDown(page)
      await page.locator('aside').getByRole('link', { name: label }).click()
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
      expect(new URL(page.url()).pathname).toBe(path)
    })
  }
})
