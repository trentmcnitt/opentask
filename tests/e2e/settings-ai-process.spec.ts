/**
 * Settings → AI: the Process row (2026-10-22). Process's AI suggestions have
 * their own mode (`ai_process_mode`) and are NOT shelved, so the row shows
 * next to Enrichment whatever the AI shelve switch says — the server here
 * runs shelved, as production does — and picking a mode saves it.
 *
 * E2E runs without AI, so the preferences GET is made to report
 * `ai_available: true` (Settings → AI renders only where AI runs). The E2E
 * user is shared with every spec, so the mode is put back before the test
 * ends.
 */
import { test, expect, waitForPreferenceSave } from './fixtures'
import type { Page } from '@playwright/test'

async function pref(page: Page, field: string): Promise<unknown> {
  return (await (await page.request.get('/api/user/preferences')).json()).data[field]
}

/** Report AI available (and, optionally, unshelved) on the preferences GET. */
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

async function openSettings(page: Page): Promise<void> {
  const loaded = page.waitForResponse(
    (r) => r.url().includes('/api/user/preferences') && r.request().method() === 'GET',
  )
  await page.goto('/settings')
  await loaded
  await expect(page.getByText('Feature modes')).toBeVisible()
}

test.describe('Settings → AI: Process row', () => {
  test('shown next to Enrichment while the other AI features are shelved', async ({
    authenticatedPage: page,
  }) => {
    expect(await pref(page, 'ai_unshelved')).toBe(false)
    await reportPrefs(page)
    await openSettings(page)

    const groups = page.getByRole('group', { name: / mode$/ })
    await expect(groups).toHaveCount(2)
    await expect(groups.nth(0)).toHaveAccessibleName('Enrichment mode')
    await expect(groups.nth(1)).toHaveAccessibleName('Process mode')
    await expect(page.getByText('Suggests projects and spots duplicates in Process')).toBeVisible()
    for (const shelved of ['Quick Take', "What's Next", 'Insights']) {
      await expect(page.getByRole('group', { name: `${shelved} mode` })).toHaveCount(0)
    }
  })

  test('also shown when unshelved, second after Enrichment', async ({
    authenticatedPage: page,
  }) => {
    await reportPrefs(page, { unshelved: true })
    await openSettings(page)
    const groups = page.getByRole('group', { name: / mode$/ })
    await expect(groups).toHaveCount(5)
    await expect(groups.nth(1)).toHaveAccessibleName('Process mode')
  })

  test('picking a mode saves ai_process_mode and leaves Insights alone', async ({
    authenticatedPage: page,
  }) => {
    const insightsBefore = await pref(page, 'ai_insights_mode')
    const before = await pref(page, 'ai_process_mode')
    expect(before).toBe('api')
    try {
      await reportPrefs(page)
      await openSettings(page)
      const row = page.getByRole('group', { name: 'Process mode' })
      await expect(row.getByRole('button', { name: 'API' })).toHaveAttribute('aria-pressed', 'true')

      const saved = waitForPreferenceSave(page, 'ai_process_mode')
      await row.getByRole('button', { name: 'Off' }).click()
      const res = await saved
      expect(res.ok()).toBe(true)
      expect(JSON.parse(res.request().postData() ?? '{}')).toEqual({ ai_process_mode: 'off' })
      await expect(row.getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true')
      expect(await pref(page, 'ai_process_mode')).toBe('off')
      expect(await pref(page, 'ai_insights_mode')).toBe(insightsBefore)

      // Read back from the server after a reload.
      await openSettings(page)
      await expect(
        page.getByRole('group', { name: 'Process mode' }).getByRole('button', { name: 'Off' }),
      ).toHaveAttribute('aria-pressed', 'true')
    } finally {
      await page.request.patch('/api/user/preferences', { data: { ai_process_mode: before } })
    }
  })
})
