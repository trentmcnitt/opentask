/**
 * RE-TAPPING THE CURRENT TAB CLEARS AN ACTIVE SEARCH (Trent, 2026-11-12:
 * "tapping the tab bar at the bottom (if you're tapping the exact same bar)
 * should clear the search… Likewise for Reminders and Quotas"), and does only
 * that on that tap: the page does not scroll. With no search, the re-tap is
 * the walk / the top as before (nav-retap-top.spec, nav-retap-walk.spec).
 * The phone's tab bar and the desktop sidebar (`useTabRetap`, `SearchBar`).
 */
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

const TABS = [
  ['/', 'Dashboard', 'tasks'],
  ['/reminders', 'Reminders', 'reminders'],
  ['/quotas', 'Quotas', 'quotas'],
] as const

/** The link's click handler is attached (nav-retap-top.spec's `hydrated`). */
async function hydrated(page: Page, scope: string, path: string) {
  await page.waitForFunction(
    ([scope, path]) => {
      const link = document.querySelector(`${scope} a[href="${path}"]`)
      return !!link && Object.keys(link).some((k) => k.startsWith('__reactProps'))
    },
    [scope, path],
  )
}

/** Tall and scrolled down, with nothing that needs you: a re-tap that scrolled would reach 0. */
async function scrolledDown(page: Page) {
  // The app's own shell is made tall (not only <body>): the desktop sidebar
  // is sticky inside it, so its links stay on screen while scrolled — a link
  // scrolled off would be scrolled back into view by the click itself.
  await page.addStyleTag({
    content: 'body, body .min-h-screen { min-height: 4000px !important; }',
  })
  await page.evaluate(() =>
    document
      .querySelectorAll('[data-needs-you]')
      .forEach((el) => el.removeAttribute('data-needs-you')),
  )
  await page.evaluate(() => window.scrollTo(0, 1200))
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(1000)
}

test.describe('phone tab bar', () => {
  test.use({ viewport: { width: 390, height: 700 } })
  for (const [path, label, subject] of TABS) {
    test(`${label}: a re-tap clears the search and nothing else; the next one scrolls to the top`, async ({
      authenticatedPage: page,
    }) => {
      await page.goto(path)
      await hydrated(page, 'nav', path)
      await page.getByRole('button', { name: 'Search', exact: true }).click()
      const input = page.getByRole('textbox', { name: `Search ${subject}` })
      await input.fill('zzqx')
      await scrolledDown(page)
      const y = await page.evaluate(() => window.scrollY)

      const tab = page.locator('nav').getByRole('link', { name: label, exact: true })
      await tab.click()
      // The search is gone — its field closed, its button back.
      await expect(page.getByRole('textbox', { name: `Search ${subject}` })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeVisible()
      // Only that: the page stayed where it was, on its own path.
      expect(await page.evaluate(() => window.scrollY)).toBe(y)
      expect(new URL(page.url()).pathname).toBe(path)

      // No search now: the re-tap is the usual one.
      await scrolledDown(page)
      await tab.click()
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
    })
  }
})

test.describe('desktop sidebar', () => {
  test.use({ viewport: { width: 1280, height: 700 } })
  for (const [path, label, subject] of TABS) {
    test(`${label}: clicking it while on it clears the search and nothing else`, async ({
      authenticatedPage: page,
    }) => {
      await page.goto(path)
      await hydrated(page, 'aside', path)
      const input = page.getByRole('textbox', { name: `Search ${subject}` })
      await input.fill('zzqx')
      await expect(page.getByRole('button', { name: 'Clear search' })).toBeVisible()
      await scrolledDown(page)
      const y = await page.evaluate(() => window.scrollY)

      const link = page.locator('aside').getByRole('link', { name: label, exact: true })
      await link.click()
      await expect(input).toHaveValue('')
      expect(await page.evaluate(() => window.scrollY)).toBe(y)
      expect(new URL(page.url()).pathname).toBe(path)

      await link.click()
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
    })
  }
})
