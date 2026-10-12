import { test, expect, uniqueTitle, withPreferences } from './fixtures'
import type { Locator, Page } from '@playwright/test'

/**
 * The task editor on a phone (Trent's morning QA, 2026-10-12), in the bottom
 * sheet a tap on a dashboard row opens:
 *
 * - #6: the recurrence summary line is the way into the recurrence editor, and
 *   the Repeat button says what a tap does (its one state is the editor's).
 * - #7: with the editor open the sheet is taller than the screen; it must
 *   scroll, so its top (title, target line) can be brought back. It used to be
 *   an unbounded `fixed bottom-0` box whose top went above the screen, with the
 *   page scroll-locked behind it — nothing could scroll.
 * - #8: a recurring task's time is labelled the target, its deadline says it
 *   moves with each occurrence, and it has no Horizon row.
 * - #5: a deadline-only task names its stored automatic target instead of "No target".
 */

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

const WEEKLY = 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0'
const DAY_MS = 24 * 3600_000

async function createTask(page: Page, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data })
  expect(res.ok()).toBeTruthy()
  return (await res.json()).data.id as number
}

/** Tap the row's own padding (not the title link, not the Done circle) to open the sheet. */
async function openEditor(page: Page, id: number): Promise<Locator> {
  await page.goto('/')
  const row = page.locator(`#task-row-${id}`)
  await row.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  const box = await row.boundingBox()
  if (!box) throw new Error('row not on screen')
  await row.tap({ position: { x: 56, y: box.height - 6 } })
  const sheet = page.locator('[data-slot="sheet-content"]')
  await expect(sheet.getByRole('button', { name: 'Save' })).toBeVisible()
  return sheet
}

test.describe('Task editor sheet on a phone', () => {
  test('the recurrence line opens the editor, and the sheet scrolls back to the top', async ({
    authenticatedPage: page,
  }) => {
    const title = uniqueTitle('Weekly review')
    const id = await createTask(page, { title, rrule: WEEKLY, priority: 2 })
    try {
      await withPreferences(page, { default_grouping: 'unified' }, async () => {
        const sheet = await openEditor(page, id)
        const line = sheet.locator('[data-quick-panel-recurrence]')
        await expect(line).toHaveText('Target Sundays at 9:00 AM')
        await expect(line).toHaveAttribute('aria-expanded', 'false')
        // The button names its action, not the task's state.
        const repeat = sheet.getByRole('button', { name: 'Edit recurrence', exact: true })
        await expect(repeat).toBeVisible()

        await line.tap()
        const editor = sheet.locator('#quick-panel-recurrence-editor')
        await expect(editor).toBeVisible()
        await expect(line).toHaveAttribute('aria-expanded', 'true')
        await expect(
          sheet.getByRole('button', { name: 'Close recurrence editor', exact: true }),
        ).toBeVisible()
        // Opening the editor changes nothing: the task still recurs, nothing staged.
        await expect(sheet.getByRole('button', { name: 'Save' })).toBeDisabled()
        await expect(editor.getByText('Schedule from')).toBeVisible()
        await expect(editor.getByRole('combobox').filter({ hasText: 'Target' })).toBeVisible()

        // #7: the open sheet is taller than the screen. It stays on screen and
        // scrolls: scroll to the end, then the title must come back into view.
        const metrics = await sheet.evaluate((el) => ({
          top: el.getBoundingClientRect().top,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        }))
        expect(metrics.top).toBeGreaterThanOrEqual(0)
        expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight)
        await sheet.evaluate((el) => el.scrollTo(0, el.scrollHeight))
        const heading = sheet.getByText(title, { exact: true })
        await expect(heading).not.toBeInViewport()
        await heading.scrollIntoViewIfNeeded()
        await expect(heading).toBeInViewport()

        // The line closes it again.
        await line.tap()
        await expect(editor).toHaveCount(0)
        await expect(repeat).toBeVisible()
      })
    } finally {
      await page.request.delete(`/api/tasks/${id}`)
    }
  })

  test('a recurring task: deadline moves with each week, and no Horizon row', async ({
    authenticatedPage: page,
  }) => {
    const recurring = await createTask(page, {
      title: uniqueTitle('Timesheet'),
      rrule: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=12;BYMINUTE=0',
      priority: 2,
    })
    const task = (await (await page.request.get(`/api/tasks/${recurring}`)).json()).data
    // Deadline 11 hours after the occurrence's noon target: 11 PM that day.
    const deadline = new Date(Date.parse(task.due_at) + 11 * 3600_000).toISOString()
    expect(
      (
        await page.request.patch(`/api/tasks/${recurring}`, { data: { deadline_at: deadline } })
      ).ok(),
    ).toBeTruthy()
    const oneOff = await createTask(page, {
      title: uniqueTitle('One-off'),
      due_at: new Date(Date.now() + 2 * 3600_000).toISOString(),
      priority: 2,
    })
    try {
      await withPreferences(page, { default_grouping: 'unified' }, async () => {
        let sheet = await openEditor(page, recurring)
        await expect(sheet.locator('[data-quick-panel-deadline-repeat]')).toHaveText(
          '· moves with each week',
        )
        await expect(sheet.locator('[data-task-model-fields]')).not.toContainText('Horizon')

        sheet = await openEditor(page, oneOff)
        await expect(sheet.locator('[data-task-model-fields]')).toContainText('Horizon')
        await expect(sheet.locator('[data-quick-panel-deadline-repeat]')).toHaveCount(0)
        await expect(sheet.locator('[data-quick-panel-recurrence]')).toHaveText('One time')
      })
    } finally {
      await page.request.delete(`/api/tasks/${recurring}`)
      await page.request.delete(`/api/tasks/${oneOff}`)
    }
  })

  test("a recurring task's empty deadline picker opens on the occurrence, not tomorrow", async ({
    authenticatedPage: page,
  }) => {
    // The noon target is the occurrence; a deadline "before bed that night" is
    // then just a time change, with no hunting through the calendar for Sunday.
    const id = await createTask(page, {
      title: uniqueTitle('Timesheet'),
      rrule: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=12;BYMINUTE=0',
      priority: 2,
    })
    const task = (await (await page.request.get(`/api/tasks/${id}`)).json()).data
    try {
      await withPreferences(page, { default_grouping: 'unified' }, async () => {
        const sheet = await openEditor(page, id)
        await sheet.locator('[data-quick-panel-deadline]').tap()
        // The picker selects its day as a browser-local Date, so ask the browser.
        const day = await page.evaluate((iso) => new Date(iso).getDate(), task.due_at as string)
        const selected = page.locator('[data-selected-single="true"]')
        await expect(selected).toHaveText(String(day))
        await expect(page.getByLabel('Hour')).toHaveValue('12')
        // Opening it stages nothing.
        await expect(sheet.locator('[data-quick-panel-deadline]')).toContainText('None')
      })
    } finally {
      await page.request.delete(`/api/tasks/${id}`)
    }
  })

  test('a deadline-only task names its stored auto target', async ({ authenticatedPage: page }) => {
    // Deadline 20 days out: a wait of 16+ days, so the stored automatic
    // target is 4 days before it (spec §8.1).
    const id = await createTask(page, {
      title: uniqueTitle('Renew passport'),
      deadline_at: new Date(Date.now() + 20 * DAY_MS).toISOString(),
      priority: 2,
    })
    try {
      await withPreferences(page, { default_grouping: 'unified' }, async () => {
        const sheet = await openEditor(page, id)
        const target = sheet.locator('[data-quick-panel-date]')
        await expect(target).toContainText('auto')
        await expect(target).toContainText('(4 days before deadline)')
        await expect(target).not.toContainText('No target')
      })
    } finally {
      await page.request.delete(`/api/tasks/${id}`)
    }
  })
})
