import { test, expect } from '@playwright/test'

/**
 * Smoke tests for OpenTask
 *
 * These tests verify basic functionality is working.
 */

test.describe('OpenTask Smoke Tests', () => {
  test('home page loads', async ({ page }) => {
    await page.goto('/')

    // Verify page loads without errors
    await expect(page).toHaveTitle(/OpenTask/i)
  })

  test('API health check', async ({ request }) => {
    // Test that the API is responding
    const response = await request.get('/api/tasks')

    // Should return 401 (unauthorized) or 200 (if authenticated)
    // Either means the API is running
    expect([200, 401]).toContain(response.status())
  })
})
