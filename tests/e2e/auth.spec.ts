import { test, expect } from '@playwright/test'

test.describe('Authentication', () => {
  test('login with valid credentials redirects to dashboard; invalid shows error', async ({
    page,
  }) => {
    // Try invalid credentials first
    await page.goto('/login')
    await page.getByLabel('Username').fill('wrong@example.com')
    await page.getByLabel('Password').fill('wrongpassword')
    await page.getByRole('button', { name: /sign in/i }).click()

    // Should show error message
    await expect(page.getByText('Invalid username or password')).toBeVisible({ timeout: 5000 })

    // Now try valid credentials
    await page.getByLabel('Username').fill('test@opentask.local')
    await page.getByLabel('Password').fill('testpass123')
    await page.getByRole('button', { name: /sign in/i }).click()

    // Should redirect to dashboard
    await page.waitForURL('/', { timeout: 10_000 })
    await expect(page.getByRole('img', { name: 'OpenTask' })).toBeVisible()
  })

  // The signed-in pages share one client-side guard (useRequireSession): a
  // visitor with no session lands on the login page, which remembers where
  // they were headed.
  for (const path of [
    '/archive',
    '/trash',
    '/history',
    '/quotas',
    '/reminders',
    '/settings',
    '/tasks/1',
  ]) {
    test(`signed-out visit to ${path} redirects to login with a callbackUrl`, async ({ page }) => {
      await page.goto(path)
      await page.waitForURL(`/login?callbackUrl=${encodeURIComponent(path)}`)
      await expect(page.getByLabel('Username')).toBeVisible()
    })
  }
})
