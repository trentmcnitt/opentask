/**
 * E2E test fixtures
 *
 * Extends Playwright test with an authenticatedPage fixture
 * that logs in via the real login form.
 */

import { test as base, type Page } from '@playwright/test'

export const TEST_EMAIL = 'test@opentask.local'
export const TEST_PASSWORD = 'testpass123'

/* eslint-disable react-hooks/rules-of-hooks -- Playwright fixtures use `use` which is not a React hook */
export const test = base.extend<{ authenticatedPage: Page }>({
  authenticatedPage: async ({ page }, use) => {
    // Navigate to login page
    await page.goto('/login')

    // Fill in login form
    await page.getByLabel('Username').fill(TEST_EMAIL)
    await page.getByLabel('Password').fill(TEST_PASSWORD)
    await page.getByRole('button', { name: /sign in/i }).click()

    // Wait for redirect to dashboard
    await page.waitForURL('/', { timeout: 10_000 })

    // Wait for dashboard content to render (task rows or empty state).
    // This confirms React has hydrated and the initial data fetch completed.
    // Note: we do NOT use waitForLoadState('networkidle') because the SSE
    // sync stream (/api/sync/stream) keeps a persistent connection open,
    // which prevents networkidle from ever being reached.
    await page.waitForSelector('[id^="task-row-"], .text-4xl', { timeout: 10_000 }).catch(() => {
      // Dashboard might be empty — that's OK
    })

    await use(page)
  },
})
/* eslint-enable react-hooks/rules-of-hooks */

export { expect } from '@playwright/test'

/**
 * Resolves on the PATCH that saves `field` to `/api/user/preferences` — and on
 * nothing else. Arm it BEFORE the click that saves.
 *
 * Matching the URL alone is not enough: the page GETs the same URL on its own
 * schedule (`PreferencesProvider` on load, `useQuotaPromptPrefs` on every mount
 * of the quota editor and the Track panel's prompt setup). A GET still in
 * flight when the click lands satisfied a URL-only wait, the test then
 * reloaded, and the reload aborted the real PATCH — so the reloaded page read
 * the old value back. That made `track.spec.ts`'s "Show as chips after a
 * reload" fail about one run in five (2026-09-25).
 */
export function waitForPreferenceSave(page: Page, field: string) {
  return page.waitForResponse((r) => {
    if (!r.url().includes('/api/user/preferences')) return false
    const req = r.request()
    if (req.method() !== 'PATCH') return false
    try {
      return Object.hasOwn(JSON.parse(req.postData() ?? '{}') as object, field)
    } catch {
      return false
    }
  })
}
