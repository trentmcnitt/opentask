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

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  // The deadline picker works in the browser's local days.
  timezoneId: process.env.E2E_TZ || 'America/Chicago',
})

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
        // The button names its action, led by the rule it has (2026-10-20).
        const repeat = sheet.getByRole('button', {
          name: 'Repeats: Sundays at 9:00 AM · Edit recurrence',
          exact: true,
        })
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

  test('a deadline-anchored repeat: the deadline line says where the target sits, and no Horizon row', async ({
    authenticatedPage: page,
  }) => {
    const recurring = await createTask(page, {
      title: uniqueTitle('Timesheet'),
      rrule: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=12;BYMINUTE=0',
      priority: 2,
    })
    const task = (await (await page.request.get(`/api/tasks/${recurring}`)).json()).data
    // Deadline 11 hours after the occurrence's noon target: 11 PM that day.
    // Since 2026-10-21 a repeat with a deadline walks the DEADLINE: switch the
    // anchor with the rule at 11 PM, the target the same day at noon.
    const deadline = new Date(Date.parse(task.due_at) + 11 * 3600_000).toISOString()
    expect(
      (
        await page.request.patch(`/api/tasks/${recurring}`, {
          data: {
            repeat_anchor: 'deadline',
            rrule: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=23;BYMINUTE=0',
            deadline_at: deadline,
            target_days_before: 0,
            target_time: '12:00',
          },
        })
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
          '· target the same day at 12:00 PM',
        )
        await expect(sheet.locator('[data-task-model-fields]')).not.toContainText('Horizon')
        // The rule's time is the DEADLINE's: the line and the picker say so.
        const line = sheet.locator('[data-quick-panel-recurrence]')
        await expect(line).toHaveText('Deadline Sundays at 11:00 PM')
        await line.tap()
        await expect(sheet.locator('[data-recurrence-time-label]')).toHaveText('Deadline')
        await line.tap()

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

  test('a target-anchored repeat offers no deadline; its rule time reads Target', async ({
    authenticatedPage: page,
  }) => {
    // 2026-10-21, until the editor's anchor switch (PR 4): a deadline on a
    // repeat whose rule walks its target is a 400 (L9), so none is offered.
    const id = await createTask(page, {
      title: uniqueTitle('Timesheet'),
      rrule: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=12;BYMINUTE=0',
      priority: 2,
    })
    try {
      await withPreferences(page, { default_grouping: 'unified' }, async () => {
        const sheet = await openEditor(page, id)
        const line = sheet.locator('[data-quick-panel-recurrence]')
        await expect(line).toHaveText('Target Sundays at 12:00 PM')
        await expect(sheet.locator('[data-quick-panel-deadline]')).toHaveCount(0)
        await line.tap()
        await expect(sheet.locator('[data-recurrence-time-label]')).toHaveText('Target')
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
  test('the Repeat button reads active on a repeating task, plain on a one-off', async ({
    authenticatedPage: page,
  }) => {
    // Trent, 2026-10-20: the button looked the same either way. A rule is the
    // panel's neutral selected look — grey fill, full foreground, never blue
    // (blue means an unsaved change; designer 10-20) — and leads its label.
    const repeating = await createTask(page, { title: uniqueTitle('Rep on'), rrule: WEEKLY })
    const oneOff = await createTask(page, {
      title: uniqueTitle('Rep off'),
      due_at: new Date(Date.now() + DAY_MS).toISOString(),
    })
    try {
      await withPreferences(page, { default_grouping: 'unified' }, async () => {
        let sheet = await openEditor(page, repeating)
        const on = sheet.getByRole('button', { name: /^Repeats: Sundays at 9:00 AM/ })
        await expect(on).toHaveAttribute('data-repeat-active', '')
        await expect(on).not.toHaveAttribute('aria-pressed')
        const look = (el: Element) => {
          const style = getComputedStyle(el)
          return { color: style.color, background: style.backgroundColor }
        }
        const onLook = await on.evaluate(look)
        // Neutral: no blue class on the active button.
        await expect(on).not.toHaveClass(/blue/)

        sheet = await openEditor(page, oneOff)
        const off = sheet.getByRole('button', { name: 'Edit recurrence', exact: true })
        await expect(off).toBeVisible()
        await expect(off).not.toHaveAttribute('data-repeat-active')
        const offLook = await off.evaluate(look)
        expect(offLook.color).not.toBe(onLook.color)
        expect(offLook.background).not.toBe(onLook.background)
      })
    } finally {
      await page.request.delete(`/api/tasks/${repeating}`)
      await page.request.delete(`/api/tasks/${oneOff}`)
    }
  })
})

test.describe('Recurrence editor on a phone: the starting time', () => {
  test("a new rule on an undated task starts at the user's Morning time, not 9:00", async ({
    authenticatedPage: page,
  }) => {
    // Every repeating task has a time (2026-10-12); the picker's starting time
    // is the task's anchor, else its date's time, else the Morning setting.
    const title = uniqueTitle('Stretch')
    const id = await createTask(page, { title })
    try {
      await withPreferences(
        page,
        { default_grouping: 'unified', morning_time: '08:30' },
        async () => {
          const sheet = await openEditor(page, id)
          await sheet.getByRole('button', { name: 'Edit recurrence', exact: true }).tap()
          const editor = sheet.locator('#quick-panel-recurrence-editor')
          await expect(editor).toBeVisible()
          await editor.getByRole('combobox').first().tap()
          await page.getByRole('option', { name: 'Daily', exact: true }).tap()
          const selects = editor.getByRole('combobox')
          await expect(selects.filter({ hasText: /^8$/ })).toHaveCount(1)
          await expect(selects.filter({ hasText: /^30$/ })).toHaveCount(1)
          await expect(selects.filter({ hasText: /^AM$/ })).toHaveCount(1)

          await sheet.getByRole('button', { name: 'Save' }).tap()
          await expect
            .poll(
              async () => (await (await page.request.get(`/api/tasks/${id}`)).json()).data.rrule,
            )
            .toBe('FREQ=DAILY;BYHOUR=8;BYMINUTE=30')
        },
      )
    } finally {
      await page.request.delete(`/api/tasks/${id}`)
    }
  })

  test('a "1st Saturday" rule keeps its weekday when only its time is edited', async ({
    authenticatedPage: page,
  }) => {
    // The picker has no weekday-of-month control; before 2026-10-20 any edit
    // rewrote such a rule to BYMONTHDAY=1. It is carried through now.
    const id = await createTask(page, {
      title: uniqueTitle('Craft'),
      rrule: 'FREQ=MONTHLY;BYDAY=1SA;BYHOUR=9;BYMINUTE=0',
    })
    try {
      await withPreferences(page, { default_grouping: 'unified' }, async () => {
        const sheet = await openEditor(page, id)
        await expect(sheet.locator('[data-quick-panel-recurrence]')).toContainText(
          'Monthly on the 1st Sat at 9:00 AM',
        )
        await sheet.getByRole('button', { name: /^Repeats: / }).tap()
        const editor = sheet.locator('#quick-panel-recurrence-editor')
        await expect(editor).toBeVisible()
        const selects = editor.getByRole('combobox')
        await expect(selects.filter({ hasText: /^1st Sat$/ })).toHaveCount(1)
        await selects.filter({ hasText: /^9$/ }).tap()
        await page.getByRole('option', { name: '10', exact: true }).tap()

        await sheet.getByRole('button', { name: 'Save' }).tap()
        await expect
          .poll(async () => (await (await page.request.get(`/api/tasks/${id}`)).json()).data.rrule)
          .toBe('FREQ=MONTHLY;BYDAY=1SA;BYHOUR=10;BYMINUTE=0')
      })
    } finally {
      await page.request.delete(`/api/tasks/${id}`)
    }
  })
})
