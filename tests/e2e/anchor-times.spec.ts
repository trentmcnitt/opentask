/**
 * Anchor times (2026-10-21): Settings → Snooze shows Morning, Wake, Sleep and
 * the number pad's four buttons, each a custom time or linked to a reminder
 * period; a linked one follows the period, the quick panel's pad shows the
 * buttons as set, and removing a linked period keeps the time and says so,
 * with Undo putting the link back.
 *
 * The E2E user is shared with every other spec (snooze.spec reads the pad's
 * default times and "Tomorrow at 9:00 AM"), so every change here is put back
 * before the test ends.
 */
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import { DateTime } from 'luxon'

const TZ = process.env.E2E_TZ || 'America/Chicago'

interface Slot {
  id: number
  label: string
  start_time: string
}

async function slotNamed(page: Page, label: string): Promise<Slot> {
  const slots = (await (await page.request.get('/api/time-slots')).json()).data.time_slots as Slot[]
  const slot = slots.find((s) => s.label === label)
  if (!slot) throw new Error(`no period ${label}`)
  return slot
}

function anchorRow(page: Page, target: string) {
  return page.locator(`[data-anchor-row="${target}"]`)
}

function periods(page: Page) {
  return page.getByTestId('reminder-periods')
}

/** The Undo on the toast that says `text` (an earlier toast may still be up). */
function toastUndo(page: Page, text: string) {
  return page
    .locator('[data-sonner-toast]', { hasText: text })
    .getByRole('button', { name: 'Undo' })
}

async function resetAnchors(page: Page) {
  await page.request.patch('/api/user/preferences', {
    data: { morning_time: '09:00', pad_presets: null },
  })
}

test.describe('Anchor times', () => {
  test('Morning linked to a period follows it; removing the period keeps the time, Undo relinks', async ({
    authenticatedPage: page,
  }) => {
    const afternoon = await slotNamed(page, 'Afternoon')
    expect(afternoon.start_time).toBe('16:00')
    try {
      await page.goto('/settings')
      const morning = anchorRow(page, 'morning')
      const summary = morning.locator('[data-anchor-summary]')
      await expect(summary).toHaveText('Morning · 9:00 AM')

      // Link it: the time field goes, the summary names the period.
      await morning
        .getByLabel('Morning time: follows')
        .selectOption({ label: 'Afternoon (4:00 PM)' })
      await expect(summary).toHaveText('Morning · 4:00 PM (Afternoon period)')
      await expect(morning.getByLabel('Morning time', { exact: true })).toHaveCount(0)

      // Move the period: Morning follows it.
      const start = periods(page).getByLabel('Start time of Afternoon')
      await start.fill('16:30')
      await start.press('Enter')
      await expect(summary).toHaveText('Morning · 4:30 PM (Afternoon period)')

      // Remove it: Morning keeps 4:30 PM as its own time, and the toast says so.
      await periods(page).getByRole('button', { name: 'Remove Afternoon' }).click()
      await expect(
        page.getByText(/Removed "Afternoon".* · Morning time stays at 4:30 PM/),
      ).toBeVisible()
      await expect(summary).toHaveText('Morning · 4:30 PM')
      await expect(morning.getByLabel('Morning time', { exact: true })).toHaveValue('16:30')

      // Undo brings the period back, and Morning follows it again.
      await toastUndo(page, 'Removed "Afternoon"').click()
      await expect(summary).toHaveText('Morning · 4:30 PM (Afternoon period)')
    } finally {
      await resetAnchors(page)
      const back = await slotNamed(page, 'Afternoon').catch(() => null)
      if (back) {
        await page.request.patch(`/api/time-slots/${back.id}`, { data: { start_time: '16:00' } })
      }
    }
    expect((await slotNamed(page, 'Afternoon')).start_time).toBe('16:00')
  })

  test('a pad button set to a custom time shows on the quick panel and stages that time', async ({
    authenticatedPage: page,
  }) => {
    const created = await page.request.post('/api/tasks', {
      data: { title: `Pad button ${Date.now()}`, priority: 3 },
    })
    expect(created.ok()).toBeTruthy()
    const id = (await created.json()).data.id as number
    try {
      await page.goto('/settings')
      const button1 = anchorRow(page, '0')
      await expect(button1.locator('[data-anchor-summary]')).toHaveText('Button 1 · 9:00 AM')
      await button1.getByLabel('Button 1', { exact: true }).fill('07:15')
      await expect(button1.locator('[data-anchor-summary]')).toHaveText('Button 1 · 7:15 AM')
      await expect
        .poll(async () => {
          const prefs = (await (await page.request.get('/api/user/preferences')).json()).data
          return prefs.pad_presets[0].time
        })
        .toBe('07:15')

      await page.setViewportSize({ width: 1280, height: 800 })
      await page.goto('/')
      await page.locator(`#task-row-${id}`).dblclick()
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByRole('button', { name: '7:15 AM', exact: true })).toBeVisible()
      await expect(dialog.getByRole('button', { name: '9:00 AM', exact: true })).toHaveCount(0)
      await expect(dialog.getByRole('button', { name: '12:00 PM', exact: true })).toBeVisible()

      await dialog.getByRole('button', { name: '7:15 AM', exact: true }).click()
      await dialog.getByRole('button', { name: 'Save' }).click()
      await expect
        .poll(async () => {
          const task = (await (await page.request.get(`/api/tasks/${id}`)).json()).data
          return task.target_at
            ? DateTime.fromISO(task.target_at).setZone(TZ).toFormat('HH:mm')
            : null
        })
        .toBe('07:15')
    } finally {
      await resetAnchors(page)
      await page.request.delete(`/api/tasks/${id}`)
    }
  })

  test('the settings rows fit a phone screen', async ({ authenticatedPage: page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/settings')
    await anchorRow(page, 'morning').scrollIntoViewIfNeeded()
    await expect(anchorRow(page, 'morning')).toBeVisible()
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)
  })
})
