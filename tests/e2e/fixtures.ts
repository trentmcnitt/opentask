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
