/**
 * "Day starts at" (2026-10-23): Settings → Your day shows when the OpenTask day
 * turns — by default a fixed 3:00 AM ("Default (3:00 AM)", 2026-10-24), or a
 * custom time at any hour, or a link to a period. Removing a linked period keeps its time as custom,
 * and Undo puts the link back, like Morning's.
 *
 * The E2E user is shared with every other spec, so the setting is put back
 * to the default (`day_start_time: null`) before each test ends.
 *
 * The row shows only with the server's task-queue switch on (with it off the
 * day turns at midnight), so each test turns it on and off again after.
 */
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

interface Slot {
  id: number
  label: string
  start_time: string
}

async function slots(page: Page): Promise<Slot[]> {
  const list = (await (await page.request.get('/api/time-slots')).json()).data.time_slots as Slot[]
  return [...list].sort((a, b) => a.start_time.localeCompare(b.start_time))
}

async function prefs(page: Page) {
  return (await (await page.request.get('/api/user/preferences')).json()).data as {
    rollover_time: string
    day_start_time: string
    day_start_slot_id: number | null
    day_start_default: boolean
  }
}

function clock(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

async function resetDayStart(page: Page) {
  await page.request.patch('/api/user/preferences', { data: { day_start_time: null } })
}

async function setQueue(page: Page, enabled: boolean) {
  const res = await page.request.post('/api/test/task-queue', { data: { enabled } })
  expect(res.ok()).toBeTruthy()
}

test.beforeEach(async ({ authenticatedPage: page }) => {
  await setQueue(page, true)
})

test.afterEach(async ({ authenticatedPage: page }) => {
  await setQueue(page, false)
})

test.describe('Day starts at', () => {
  test('defaults to 3:00 AM; a custom 11:00 PM saves and reads back; Default goes back', async ({
    authenticatedPage: page,
  }) => {
    try {
      await page.goto('/settings')
      const row = page.locator('[data-anchor-row="day_start"]')
      const summary = row.locator('[data-anchor-summary]')
      const select = row.getByLabel('Day starts at: follows')
      await expect(select).toHaveValue('default')
      await expect(select.locator('option[value="default"]')).toHaveText('Default (3:00 AM)')
      await expect(summary).toHaveText('3:00 AM · default')
      await expect(row.getByLabel('Day starts at', { exact: true })).toHaveCount(0)

      // Custom: the time field appears at the time it read, then edits it.
      await select.selectOption('custom')
      const field = row.getByLabel('Day starts at', { exact: true })
      await expect(field).toHaveValue('03:00')
      await field.fill('23:00')
      await expect(summary).toHaveText('11:00 PM')
      await expect
        .poll(async () => {
          const p = await prefs(page)
          return [p.rollover_time, p.day_start_default, p.day_start_slot_id]
        })
        .toEqual(['23:00', false, null])

      // It survives a reload.
      await page.reload()
      await expect(page.locator('[data-anchor-row="day_start"] [data-anchor-summary]')).toHaveText(
        '11:00 PM',
      )

      // Back to the default.
      await page
        .locator('[data-anchor-row="day_start"]')
        .getByLabel('Day starts at: follows')
        .selectOption('default')
      await expect(page.locator('[data-anchor-row="day_start"] [data-anchor-summary]')).toHaveText(
        '3:00 AM · default',
      )
      await expect
        .poll(async () => {
          const p = await prefs(page)
          return [p.rollover_time, p.day_start_default]
        })
        .toEqual(['03:00', true])
    } finally {
      await resetDayStart(page)
    }
  })

  test('linked to a period, removing it keeps the time and says so; Undo relinks', async ({
    authenticatedPage: page,
  }) => {
    const afternoon = (await slots(page)).find((s) => s.label === 'Afternoon')
    if (!afternoon) throw new Error('no Afternoon period')
    try {
      await page.goto('/settings')
      const row = page.locator('[data-anchor-row="day_start"]')
      const summary = row.locator('[data-anchor-summary]')
      await row
        .getByLabel('Day starts at: follows')
        .selectOption({ label: `Afternoon (${clock(afternoon.start_time)})` })
      await expect(summary).toHaveText(`${clock(afternoon.start_time)} · Afternoon period`)
      await expect.poll(async () => (await prefs(page)).day_start_slot_id).toBe(afternoon.id)

      await page
        .getByTestId('reminder-periods')
        .getByRole('button', { name: 'Remove Afternoon' })
        .click()
      await expect(
        page.getByText(
          new RegExp(
            `Removed "Afternoon".* · Day start time stays at ${clock(afternoon.start_time)}`,
          ),
        ),
      ).toBeVisible()
      await expect(summary).toHaveText(clock(afternoon.start_time))
      await expect(row.getByLabel('Day starts at: follows')).toHaveValue('custom')

      await page
        .locator('[data-sonner-toast]', { hasText: 'Removed "Afternoon"' })
        .getByRole('button', { name: 'Undo' })
        .click()
      await expect(summary).toHaveText(`${clock(afternoon.start_time)} · Afternoon period`)
    } finally {
      await resetDayStart(page)
    }
    expect((await slots(page)).some((s) => s.label === 'Afternoon')).toBe(true)
  })
})
