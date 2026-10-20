/**
 * History names the client behind each entry (client attribution, 2026-10-20)
 *
 * A write from the web app (session cookie) shows "· Web" after the entry's
 * time; a write sent with `X-OpenTask-Client: watch` shows "· Watch". The
 * tasks are trashed afterwards so no other spec sees them.
 */

import { test, expect } from './fixtures'

const TOKEN = 'a'.repeat(64) // the E2E Token, seeded in globalSetup.ts

test.describe('History client attribution', () => {
  const created: number[] = []

  test.afterEach(async ({ authenticatedPage: page }) => {
    for (const id of created.splice(0)) await page.request.delete(`/api/tasks/${id}`)
  })

  test('a web write shows · Web, a Watch write shows · Watch', async ({
    authenticatedPage: page,
  }) => {
    const stamp = Date.now()
    const webTitle = `Client web ${stamp}`
    const watchTitle = `Client watch ${stamp}`

    // The page's own request context carries the session cookie: the web app.
    const web = await page.request.post('/api/tasks', { data: { title: webTitle } })
    expect(web.status()).toBe(201)
    created.push((await web.json()).data.id)

    const watch = await page.request.post('/api/tasks', {
      data: { title: watchTitle },
      headers: { Authorization: `Bearer ${TOKEN}`, 'X-OpenTask-Client': 'watch' },
    })
    expect(watch.status()).toBe(201)
    created.push((await watch.json()).data.id)

    await page.goto('/history')
    const webRow = page.getByRole('button').filter({ hasText: webTitle })
    await expect(webRow.locator('[data-activity-client]')).toHaveText('· Web')
    const watchRow = page.getByRole('button').filter({ hasText: watchTitle })
    await expect(watchRow.locator('[data-activity-client]')).toHaveText('· Watch')
    await expect(watchRow.locator('[data-activity-client]')).toHaveAttribute(
      'title',
      'Token: E2E Token',
    )
  })
})
