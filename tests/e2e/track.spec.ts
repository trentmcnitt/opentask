/**
 * Track on the web (REDESIGN-V03 §5): a tracked task's row is a progress row —
 * count, bar, +1 and −1 — and reaching the target reads as "met" without
 * closing the task.
 */
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

async function createTask(page: Page, body: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data: body })
  expect(res.ok()).toBeTruthy()
  const json = await res.json()
  return json.data.id as number
}

async function deleteTasks(page: Page, ids: number[]): Promise<void> {
  for (const id of ids) await page.request.delete(`/api/tasks/${id}`)
}

const VIEWS = ['Today', 'Projects', 'All'] as const
type View = (typeof VIEWS)[number]
/** The view toggle persists server-side for the shared test user; tests put it back. */
async function pressedView(page: Page): Promise<View | null> {
  for (const v of VIEWS) {
    const b = page.getByRole('button', { name: v, exact: true })
    if ((await b.getAttribute('aria-pressed')) === 'true') return v
  }
  return null
}
async function switchView(page: Page, v: View) {
  const saved = page.waitForResponse((r) => r.url().includes('/api/user/preferences'))
  await page.getByRole('button', { name: v, exact: true }).click()
  await saved
}

/** The panel starts folded; open it (the choice persists, so tests close it again). */
async function openTrack(page: Page) {
  const panel = page.getByRole('region', { name: 'Track' })
  await expect(panel).toBeVisible()
  const fold = panel.getByRole('button', { name: 'Expand Track' })
  if (await fold.isVisible()) {
    // The choice is saved fire-and-forget; wait for it so a reload can't race it.
    const saved = page.waitForResponse((r) => r.url().includes('/api/user/preferences'))
    await fold.click()
    await saved
  }
  await expect(panel.getByRole('button', { name: 'Collapse Track' })).toBeVisible()
}
async function closeTrack(page: Page) {
  const fold = page.getByRole('button', { name: 'Collapse Track' })
  if (await fold.isVisible()) {
    const saved = page.waitForResponse((r) => r.url().includes('/api/user/preferences'))
    await fold.click()
    await saved
  }
}

test.describe('Track', () => {
  test('the Track panel shows a quota, logs +1 and −1, and reads "met" at target', async ({
    authenticatedPage: page,
  }) => {
    // A weekly quota whose rule "occurs" on some other weekday: the panel must
    // show it every day regardless.
    const id = await createTask(page, {
      title: 'Eggs for the kids',
      progress_target: 2,
      rrule: 'FREQ=WEEKLY;BYDAY=WE',
    })
    // A quota with a target of 1 — only the flag makes it one — on a different
    // period, so the chips say their periods and the header says none.
    const nightId = await createTask(page, {
      title: 'Date night',
      rrule: 'FREQ=MONTHLY',
      is_tracked: true,
    })

    try {
      await page.goto('/')
      const panel = page.getByRole('region', { name: 'Track' })
      await expect(panel).toBeVisible()
      // Folded by default: the header's total, and the quota as a chip.
      await expect(panel.getByRole('button', { name: 'Expand Track' })).toBeVisible()
      const night = panel.locator(`[data-track-chip="${nightId}"]`)
      await expect(night).toContainText('Date night')
      await expect(night.locator('[data-track-count]')).toHaveText('0/1')
      // One card per period, the word once on the card, never on a chip; each
      // card has its own bar.
      const monthCard = panel.locator('[data-track-period="month"]')
      const weekCard = panel.locator('[data-track-period="week"]')
      await expect(monthCard.getByRole('list', { name: 'month' })).toContainText('Date night')
      await expect(weekCard.getByRole('list', { name: 'week' })).toContainText('Eggs for the kids')
      await expect(weekCard.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
      await expect(panel.getByRole('button', { name: 'Expand Track' })).not.toContainText('this')
      await expect(panel.locator(`[data-track-row="${id}"]`)).toHaveCount(0)
      const chip = panel.locator(`[data-track-chip="${id}"]`)
      const chipCount = chip.locator('[data-track-count]')
      await expect(chipCount).toHaveText('0/2')

      // Tap: +1, with a toast whose Undo takes it back.
      await chip.click()
      await expect(chipCount).toHaveText('1/2')
      await expect(weekCard.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1')
      const toast = page
        .locator('[data-sonner-toast]')
        .filter({ hasText: 'Logged one for \u201cEggs for the kids\u201d \u00b7 1/2' })
      await expect(toast).toBeVisible()
      await toast.getByRole('button', { name: 'Undo' }).click()
      await expect(chipCount).toHaveText('0/2')

      // Subtracting: shift-click and right-click. A hold no longer subtracts —
      // since 2026-09-06 it opens the detail sheet, and the swipe took over −1.
      await chip.click()
      await chip.click()
      await expect(chipCount).toHaveText('2/2')
      await chip.click({ modifiers: ['Shift'] })
      await expect(chipCount).toHaveText('1/2')
      await chip.click({ button: 'right' })
      await expect(chipCount).toHaveText('0/2')

      // A hold opens the detail sheet instead of subtracting, and the note is
      // writable there — the whole point, since a terse title like "Eggs" says
      // nothing about what is actually being tracked.
      await chip.click({ delay: 500 })
      const sheet = page.getByRole('dialog').filter({ hasText: 'Eggs for the kids' })
      await expect(sheet).toBeVisible()
      await sheet.getByLabel('Notes').fill('Two eggs each, breakfast or dinner')
      await sheet.getByRole('button', { name: 'Save' }).click()
      await expect(sheet).toBeHidden()
      await expect(
        page.locator('[data-sonner-toast]').filter({ hasText: 'Note saved' }),
      ).toBeVisible()
      // The click that trails a hold is not a tap: the count is untouched.
      await expect(chipCount).toHaveText('0/2')

      // The note survives a reload, which proves it reached the server.
      await page.reload()
      await panel.locator(`[data-track-chip="${id}"]`).click({ delay: 500 })
      await expect(
        page.getByRole('dialog').filter({ hasText: 'Eggs for the kids' }).getByLabel('Notes'),
      ).toHaveValue('Two eggs each, breakfast or dinner')
      await page.keyboard.press('Escape')

      await openTrack(page)
      // The choice sticks across a reload.
      await page.reload()
      await expect(panel.getByRole('button', { name: 'Collapse Track' })).toBeVisible()
      const row = panel.locator(`[data-track-row="${id}"]`)
      await expect(row).toBeVisible()
      // On the Today view it is not also a row in the day's groups: the panel
      // is its only home there (other views list it as a plain row).
      const todayToggle = page.getByRole('button', { name: 'Today', exact: true })
      await todayToggle.click()
      await expect(todayToggle).toHaveAttribute('aria-pressed', 'true')
      await expect(page.locator(`#task-row-${id}`)).toHaveCount(0)
      await expect(row).toBeVisible()
      const count = row.locator('[data-track-count]')
      const plus = row.getByRole('button', { name: 'Log one more for "Eggs for the kids"' })
      const minus = row.getByRole('button', { name: 'Remove one from "Eggs for the kids"' })

      // One aligned line: title, bar, count, −, +1.
      await expect(count).toContainText('0 / 2')
      await expect(row.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
      await expect(minus).toBeDisabled()

      // +1 moves the count at once (optimistic) and the server agrees.
      await plus.click()
      await expect(count).toContainText('1 / 2')
      await expect
        .poll(async () => {
          const res = await page.request.get(`/api/tasks/${id}`)
          return (await res.json()).data.progress_current
        })
        .toBe(1)

      // −1 is a correction, never below zero.
      await minus.click()
      await expect(count).toContainText('0 / 2')
      await expect(minus).toBeDisabled()

      // Reaching the target is "met": a state, not an exit — the line stays.
      await plus.click()
      await plus.click()
      await expect(count).toContainText('2 / 2')
      await expect(row.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2')
      await expect(row).toBeVisible()

      // Overflow stays observable (Trent, Jul 26): the third egg shows as 3/2.
      await plus.click()
      await expect(count).toContainText('3 / 2')

      // The task itself is still open — progress is not completion.
      const res = await page.request.get(`/api/tasks/${id}`)
      const task = (await res.json()).data
      expect(task.done).toBe(false)
      expect(task.progress_current).toBe(3)
    } finally {
      await closeTrack(page)
      await deleteTasks(page, [id, nightId])
    }
  })

  test('an ordinary task is a row in the day, not a line in the panel', async ({
    authenticatedPage: page,
  }) => {
    const id = await createTask(page, { title: 'Plain one-off task' })
    let before: View | null = null
    try {
      await page.goto('/')
      await expect(page.getByRole('button', { name: 'Today', exact: true })).toBeVisible()
      before = await pressedView(page)
      if (before !== 'Today') await switchView(page, 'Today')
      // Undated one-offs sit in the day's folded "Undated" group (§7.3).
      const fold = page.getByRole('button', { name: 'Expand Undated' })
      await expect(fold).toBeVisible()
      await fold.click()
      await expect(page.getByRole('button', { name: 'Collapse Undated' })).toBeVisible()
      const row = page.locator(`#task-row-${id}`)
      await expect(row).toBeVisible()
      await expect(page.locator(`[data-track-row="${id}"]`)).toHaveCount(0)
    } finally {
      if (before && before !== 'Today') await switchView(page, before)
      await deleteTasks(page, [id])
    }
  })

  test('in the All list a quota is a plain row with its count as a chip', async ({
    authenticatedPage: page,
  }) => {
    const id = await createTask(page, {
      title: 'Chip quota',
      progress_target: 3,
      rrule: 'FREQ=WEEKLY;BYDAY=WE',
    })
    let before: View | null = null
    try {
      // Log one through the API so the chip has a non-zero count to show.
      const logged = await page.request.post(`/api/tasks/${id}/progress`, { data: { delta: 1 } })
      expect(logged.ok()).toBeTruthy()
      await page.goto('/')
      await expect(page.getByRole('button', { name: 'All', exact: true })).toBeVisible()
      before = await pressedView(page)
      if (before !== 'All') await switchView(page, 'All')
      const row = page.locator(`#task-row-${id}`)
      await expect(row).toBeVisible()
      await expect(row).toContainText('1 / 3 this week')
      await expect(row.getByRole('button', { name: /Log one more/ })).toHaveCount(0)
    } finally {
      if (before && before !== 'All') await switchView(page, before)
      await deleteTasks(page, [id])
    }
  })
})
