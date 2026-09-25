/**
 * Settings → Reminder periods (2026-09-24): rename a period, move its start
 * (its reminder moves with it, and the toast's Undo puts both back), add one,
 * and remove one with Undo instead of a confirmation dialog.
 *
 * The E2E user is shared with every other spec, and some of them rely on the
 * default periods (snooze-all resolves "next period" from them), so every
 * change here is undone or reverted before the test ends.
 */
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

interface Slot {
  id: number
  label: string
  start_time: string
}

async function slots(page: Page): Promise<Slot[]> {
  return (await (await page.request.get('/api/time-slots')).json()).data.time_slots
}

async function slotNamed(page: Page, label: string): Promise<Slot | undefined> {
  return (await slots(page)).find((s) => s.label === label)
}

function section(page: Page) {
  return page.getByTestId('reminder-periods')
}

function toastUndo(page: Page) {
  return page.locator('[data-sonner-toast]').getByRole('button', { name: 'Undo' })
}

test.describe('Reminder periods', () => {
  test('rename, move with undo, add, and remove with undo', async ({ authenticatedPage: page }) => {
    const evening = (await slotNamed(page, 'Evening'))!
    expect(evening.start_time).toBe('20:30')
    const created = await page.request.post('/api/tasks', {
      data: {
        title: 'E2E evening thought',
        is_reminder: true,
        rrule: 'FREQ=DAILY;BYHOUR=20;BYMINUTE=30',
      },
    })
    expect(created.ok()).toBeTruthy()
    const reminderId = (await created.json()).data.id as number
    const reminderRule = async () =>
      (await (await page.request.get(`/api/tasks/${reminderId}`)).json()).data.rrule as string

    try {
      await page.goto('/settings')
      await expect(page.getByRole('heading', { name: 'Reminder periods' })).toBeVisible()
      await expect(section(page).getByLabel('Name of Evening')).toHaveValue('Evening')

      // Rename: commits on Enter.
      const name = section(page).getByLabel('Name of Evening')
      await name.fill('Night')
      await name.press('Enter')
      await expect(page.getByText('Renamed to "Night"')).toBeVisible()
      await expect(section(page).getByLabel('Name of Night')).toHaveValue('Night')

      // Move the start: the reminder on the boundary moves with it.
      const start = section(page).getByLabel('Start time of Night')
      await start.fill('21:00')
      await start.press('Enter')
      await expect(page.getByText(/Night now starts at 9:00 PM · moved 1 reminder/)).toBeVisible()
      expect(await reminderRule()).toBe('FREQ=DAILY;BYHOUR=21;BYMINUTE=0')

      // The toast's Undo puts back the period AND the reminder.
      await toastUndo(page).click()
      await expect(section(page).getByLabel('Start time of Night')).toHaveValue('20:30')
      expect(await reminderRule()).toBe('FREQ=DAILY;BYHOUR=20;BYMINUTE=30')

      // Add a period.
      await section(page).getByLabel('New period name').fill('Late night')
      await section(page).getByLabel('New period start time').fill('23:00')
      await section(page).getByRole('button', { name: 'Add' }).click()
      await expect(section(page).getByLabel('Name of Late night')).toBeVisible()

      // Remove it: no dialog, an Undo toast instead.
      await section(page).getByRole('button', { name: 'Remove Late night' }).click()
      await expect(section(page).getByLabel('Name of Late night')).toHaveCount(0)
      await expect(page.getByRole('alertdialog')).toHaveCount(0)
      await toastUndo(page).click()
      await expect(section(page).getByLabel('Name of Late night')).toBeVisible()
    } finally {
      const late = await slotNamed(page, 'Late night')
      if (late) await page.request.delete(`/api/time-slots/${late.id}`)
      await page.request.patch(`/api/time-slots/${evening.id}`, {
        data: { label: 'Evening', start_time: '20:30' },
      })
      await page.request.delete(`/api/tasks/${reminderId}`)
    }
    expect(await slotNamed(page, 'Evening')).toMatchObject({ start_time: '20:30' })
  })

  test('fits a phone screen without sideways scrolling', async ({ authenticatedPage: page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/settings')
    await section(page).scrollIntoViewIfNeeded()
    await expect(section(page).getByLabel('Name of Evening')).toBeVisible()
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)
    const box = await section(page).getByRole('button', { name: 'Remove Evening' }).boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x + box!.width).toBeLessThanOrEqual(375)
  })
})
