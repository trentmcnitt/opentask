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
  //
  // The redirect must not wait on any chunk the page body would lazy-load.
  // It used to: /history rendered its body for a signed-out visitor, the
  // body's next/dynamic BatchUndoDialog suspended the page, and the redirect
  // effect waited on that chunk (in CI it never came). So every JS chunk
  // requested once the session has resolved is held back until the /login
  // navigation's own request goes out, then released. A guard that renders
  // only the loading shell until the session is in needs none of them.
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
      let sessionResolved = false
      let releaseChunks = () => {}
      const loginRequested = new Promise<void>((resolve) => (releaseChunks = resolve))
      page.on('response', (res) => {
        if (new URL(res.url()).pathname === '/api/auth/session') sessionResolved = true
      })
      page.on('request', (req) => {
        if (new URL(req.url()).pathname === '/login') releaseChunks()
      })
      await page.route('**/_next/static/chunks/*.js', async (route) => {
        if (sessionResolved) await loginRequested
        await route.continue()
      })

      await page.goto(path)
      await page.waitForURL(`/login?callbackUrl=${encodeURIComponent(path)}`)
      await expect(page.getByLabel('Username')).toBeVisible()
    })
  }
})
