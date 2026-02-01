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

    // Wait for tasks to load
    await page.waitForSelector('[data-testid="task-row"], .text-4xl', {
      timeout: 10_000,
    }).catch(() => {
      // Dashboard might be empty or task-row might not have testid — that's OK
    })

    // Wait a moment for hydration
    await page.waitForTimeout(500)

    await use(page)
  },
})
/* eslint-enable react-hooks/rules-of-hooks */

export { expect } from '@playwright/test'
