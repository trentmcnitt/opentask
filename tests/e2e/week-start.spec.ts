/**
 * Settings → "Week starts on" (2026-09-27): Sunday by default, Monday on
 * request. The choice saves, survives a reload, and moves the Quotas panel's
 * week — its "N days left" follows the chosen first day.
 *
 * The E2E user is shared with every spec, so the preference is put back to
 * Sunday (the default) before the test ends.
 */
import { DateTime } from 'luxon'
import { test, expect, waitForPreferenceSave, uniqueTitle } from './fixtures'
import type { Page } from '@playwright/test'

const TZ = process.env.E2E_TZ || 'America/Chicago'

/** Days left in the week containing now, today counted — what the panel should say. */
function expectedDaysLeft(weekStart: 'sunday' | 'monday'): string {
  const weekday = DateTime.now().setZone(TZ).weekday // 1 = Mon … 7 = Sun
  const into = weekStart === 'sunday' ? weekday % 7 : weekday - 1
  const days = 7 - into
  return `${days} day${days === 1 ? '' : 's'} left`
}

async function weekStartPref(page: Page): Promise<string> {
  return (await (await page.request.get('/api/user/preferences')).json()).data.week_start
}

test.describe('Week starts on', () => {
  test('defaults to Sunday, switches to Monday, and the Quotas week follows', async ({
    authenticatedPage: page,
  }) => {
    const created = await page.request.post('/api/tasks', {
      data: { title: uniqueTitle('Week probe'), progress_target: 2, rrule: 'FREQ=WEEKLY' },
    })
    expect(created.ok()).toBeTruthy()
    const id = (await created.json()).data.id as number

    try {
      expect(await weekStartPref(page)).toBe('sunday')

      await page.goto('/')
      const week = page
        .getByRole('region', { name: 'Quotas' })
        .locator('[data-quota-period="WEEKLY"]')
      await expect(week).toContainText(expectedDaysLeft('sunday'))

      await page.goto('/settings')
      const select = page.getByRole('combobox', { name: 'Week starts on' })
      await expect(select).toHaveValue('sunday')
      const saved = waitForPreferenceSave(page, 'week_start')
      await select.selectOption('monday')
      expect((await saved).ok()).toBeTruthy()
      await expect(page.getByText('Preference saved')).toBeVisible()
      expect(await weekStartPref(page)).toBe('monday')

      await page.reload()
      await expect(page.getByRole('combobox', { name: 'Week starts on' })).toHaveValue('monday')

      await page.goto('/')
      await expect(week).toContainText(expectedDaysLeft('monday'))
    } finally {
      await page.request.patch('/api/user/preferences', { data: { week_start: 'sunday' } })
      await page.request.delete(`/api/tasks/${id}`)
    }
  })
})
