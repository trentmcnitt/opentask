/**
 * The shelved AI features in the web (2026-10-22; src/core/ai/shelved.ts):
 * What's Next, Insights and Quick Take are shelved unless the server runs
 * with OPENTASK_AI_UNSHELVE=1, and the web hides every surface of them.
 *
 * E2E runs without AI and with the features shelved (as production), so each
 * test reports `ai_available: true` on the preferences GET — the AI surfaces
 * only render where AI runs — and leaves `ai_unshelved` as the server says
 * (false). The "unshelved" control reports `ai_unshelved: true` as well, to
 * show the same assertions would catch the surfaces if they were drawn.
 *
 * Nothing here PATCHes a preference: the shelve must not write user data.
 */
import { test, expect, waitForTaskCreate } from './fixtures'
import type { Page } from '@playwright/test'

/** Report AI available (and, for the control, unshelved) on the preferences GET. */
async function reportPrefs(page: Page, opts: { unshelved?: boolean } = {}): Promise<void> {
  await page.route('**/api/user/preferences', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch()
    const json = await response.json()
    json.data.ai_available = true
    if (opts.unshelved) json.data.ai_unshelved = true
    await route.fulfill({ response, json })
  })
}

/** Load `path` and wait for the (routed) preferences GET to land. */
async function gotoWithPrefs(page: Page, path: string): Promise<void> {
  const loaded = page.waitForResponse(
    (r) => r.url().includes('/api/user/preferences') && r.request().method() === 'GET',
  )
  await page.goto(path)
  await loaded
}

/** Requests to a shelved feature's endpoint, from now on. */
function watchShelvedRequests(page: Page): string[] {
  const seen: string[] = []
  page.on('request', (req) => {
    if (/\/api\/ai\/(whats-next|insights|quick-take)/.test(req.url())) seen.push(req.url())
  })
  return seen
}

const SHELVED_ROWS = ['Quick Take', "What's Next", 'Insights']

test.describe('Shelved AI features (the default)', () => {
  test('server reports ai_unshelved: false', async ({ authenticatedPage: page }) => {
    const prefs = (await (await page.request.get('/api/user/preferences')).json()).data
    expect(prefs.ai_unshelved).toBe(false)
  })

  test("dashboard: no AI chip, no What's Next or Insights chip, and none of their requests", async ({
    authenticatedPage: page,
  }) => {
    await reportPrefs(page)
    const seen = watchShelvedRequests(page)
    await gotoWithPrefs(page, '/')
    await expect(page.getByRole('textbox', { name: 'Quick add task' })).toBeVisible()
    await page.waitForSelector('[id^="task-row-"], .text-4xl', { timeout: 10_000 })

    await expect(page.getByRole('button', { name: 'AI settings' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /What's Next/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Insights/ })).toHaveCount(0)
    expect(seen).toEqual([])
  })

  test('quick add is the plain create: no Quick Take call, no banner', async ({
    authenticatedPage: page,
  }) => {
    await reportPrefs(page)
    const seen = watchShelvedRequests(page)
    await gotoWithPrefs(page, '/')
    const title = `E2E shelved quick add ${Date.now()}`
    const input = page.getByRole('textbox', { name: 'Quick add task' })
    await input.fill(title)
    const created = waitForTaskCreate(page)
    await input.press('Enter')
    const id = (await (await created).json()).data.id as number
    try {
      // The task is created as always (the Just now card lists it)…
      await expect(page.locator('[data-just-added-card]').getByText(title)).toBeVisible()
      // …and nothing asked for a Quick Take or drew its banner.
      await expect(page.getByLabel('Generating insight')).toHaveCount(0)
      expect(seen).toEqual([])
    } finally {
      await page.request.delete(`/api/tasks/${id}`)
    }
  })

  // Process has its own mode and is not shelved (2026-10-22): its row stays
  // (tests/e2e/settings-ai-process.spec.ts).
  test('Settings → AI lists only Enrichment and Process', async ({ authenticatedPage: page }) => {
    await reportPrefs(page)
    await gotoWithPrefs(page, '/settings')
    await expect(page.getByRole('heading', { name: 'AI Context' })).toBeVisible()
    await expect(page.getByText('Feature modes')).toBeVisible()
    await expect(page.getByText('Enrichment', { exact: true })).toBeVisible()
    await expect(page.getByRole('group', { name: 'Process mode' })).toBeVisible()
    for (const row of SHELVED_ROWS) {
      await expect(page.getByText(row, { exact: true })).toHaveCount(0)
    }
  })
})

test.describe('Unshelved control (ai_unshelved: true reported)', () => {
  test('the AI chip and every Settings → AI row are drawn', async ({ authenticatedPage: page }) => {
    await reportPrefs(page, { unshelved: true })
    await gotoWithPrefs(page, '/')
    await expect(page.getByRole('button', { name: 'AI settings' })).toBeVisible()

    await gotoWithPrefs(page, '/settings')
    await expect(page.getByText('Enrichment', { exact: true })).toBeVisible()
    for (const row of SHELVED_ROWS) {
      await expect(page.getByText(row, { exact: true })).toBeVisible()
    }
  })
})
