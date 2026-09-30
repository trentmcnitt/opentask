/**
 * Settings → Low and Medium auto-snooze survive a reload.
 *
 * Settings hydrates every preference from GET /api/user/preferences. That GET
 * once left out `auto_snooze_low_minutes` and `auto_snooze_medium_minutes`, so
 * after a reload both rows showed their client defaults (240 and 60) whatever
 * was saved. 15 and 30 are presets and neither default, so this fails on that
 * bug. The E2E database is shared by every spec, so the defaults are put back.
 */
import { test, expect } from './fixtures'

const isPrefsPatch = (res: { url(): string; request(): { method(): string } }) =>
  res.url().endsWith('/api/user/preferences') && res.request().method() === 'PATCH'

test('Low and Medium auto-snooze read back after a reload', async ({ authenticatedPage: page }) => {
  try {
    await page.goto('/settings')
    const low = page.getByRole('combobox', { name: 'Low auto-snooze' })
    const medium = page.getByRole('combobox', { name: 'Medium auto-snooze' })
    // The seeded user starts on the defaults. (A choice made before the GET
    // lands still wins: PreferencesProvider merges its dirty fields over it.)
    await expect(low).toHaveValue('240')
    await expect(medium).toHaveValue('60')

    let saved = page.waitForResponse(isPrefsPatch)
    await low.selectOption('15')
    expect((await saved).ok()).toBe(true)

    saved = page.waitForResponse(isPrefsPatch)
    await medium.selectOption('30')
    expect((await saved).ok()).toBe(true)

    await page.reload()
    await expect(low).toHaveValue('15')
    await expect(medium).toHaveValue('30')
  } finally {
    const res = await page.request.patch('/api/user/preferences', {
      data: { auto_snooze_low_minutes: 240, auto_snooze_medium_minutes: 60 },
    })
    expect(res.ok()).toBe(true)
  }
})
