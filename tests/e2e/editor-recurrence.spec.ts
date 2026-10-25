import { test, expect, uniqueTitle, withPreferences } from './fixtures'
import type { Locator, Page } from '@playwright/test'

/**
 * The task editor on a phone (Trent's morning QA, 2026-10-12; every-time
 * mode, 2026-10-22, editor PR 4c), in the bottom sheet a tap on a dashboard
 * row opens:
 *
 * - the "↻ Repeats — … · edit every time ›" link is the way into every-time
 *   mode (the grey recurrence line and the Repeat button are gone), and the
 *   sheet scrolls back to the top so the mode's banner shows (#7: the sheet
 *   is taller than the screen and must scroll);
 * - a deadline-anchored repeat's rows say where the target sits, every-time
 *   says it as "the day before ▾ at 6:00 PM ▾", and there is no Horizon;
 * - a target-anchored repeat's Deadline row reads None and opens every-time
 *   with "+ Add" (it used to be hidden — the #313 stopgap);
 * - a deadline-only task names its stored automatic target (#5);
 * - "Make it repeat" starts at the Morning time; a "1st Saturday" rule keeps
 *   its weekday when only its time is edited.
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

const everyTime = (sheet: Locator) => sheet.getByRole('region', { name: 'Editing every time' })

test.describe('Task editor sheet on a phone', () => {
  test('the Repeats link opens every-time mode, and the sheet scrolls back to the top', async ({
    authenticatedPage: page,
  }) => {
    const title = uniqueTitle('Weekly review')
    const id = await createTask(page, { title, rrule: WEEKLY, priority: 2 })
    try {
      await withPreferences(page, unified(), async () => {
        const sheet = await openEditor(page, id)
        const link = sheet.locator('[data-quick-panel-repeat-link]')
        await expect(link).toContainText('Repeats — Sundays at 9:00 AM')
        await expect(link).toHaveAccessibleName('Repeats Sundays at 9:00 AM — edit every time')

        // #7: the sheet stays on screen (it scrolls when taller than it).
        expect(await sheet.evaluate((el) => el.getBoundingClientRect().top)).toBeGreaterThanOrEqual(
          0,
        )
        await sheet.evaluate((el) => el.scrollTo(0, el.scrollHeight))

        await link.tap()
        const region = everyTime(sheet)
        await expect(region).toBeVisible()
        // Entering scrolls the sheet back to the top: the banner and the title show.
        await expect(region.getByRole('heading', { name: 'Editing every time' })).toBeInViewport()
        await expect(region.getByText(title, { exact: true })).toBeInViewport()
        // Opening it changes nothing.
        await expect(region.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
        await expect(region.getByRole('combobox', { name: 'Target time' })).toHaveText('9:00 AM')

        // Back to this one: the link again.
        await region.locator('[data-every-time-back]').tap()
        await expect(region).toHaveCount(0)
        await expect(link).toBeVisible()
      })
    } finally {
      await page.request.delete(`/api/tasks/${id}`)
    }
  })

  test('a deadline-anchored repeat: the rows say where the target sits, every-time edits it, and no Horizon', async ({
    authenticatedPage: page,
  }) => {
    const recurring = await createTask(page, {
      title: uniqueTitle('Timesheet'),
      rrule: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=12;BYMINUTE=0',
      priority: 2,
    })
    const task = (await (await page.request.get(`/api/tasks/${recurring}`)).json()).data
    // Deadline 11 hours after the occurrence's noon target: 11 PM that day —
    // the rule walks the DEADLINE at 11 PM, the target the same day at noon.
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
      await withPreferences(page, unified(), async () => {
        let sheet = await openEditor(page, recurring)
        await expect(sheet.locator('[data-quick-panel-deadline-repeat]')).toHaveText(
          '· target the deadline day at 12:00 PM',
        )
        await expect(sheet.locator('[data-task-model-fields]')).not.toContainText('Horizon')
        // The rule's time is the DEADLINE's: the link says so.
        await expect(sheet.locator('[data-quick-panel-repeat-link]')).toContainText(
          'Sundays, deadline 11:00 PM',
        )
        await sheet.locator('[data-quick-panel-repeat-link]').tap()
        const region = everyTime(sheet)
        await expect(region.getByRole('combobox', { name: 'Deadline time' })).toHaveText('11:00 PM')
        await expect(region.getByRole('combobox', { name: 'Days before the deadline' })).toHaveText(
          'the deadline day',
        )
        await expect(region.getByRole('combobox', { name: 'Target time' })).toHaveText('12:00 PM')

        sheet = await openEditor(page, oneOff)
        await expect(sheet.locator('[data-task-model-fields]')).toContainText('Horizon')
        await expect(sheet.locator('[data-quick-panel-deadline-repeat]')).toHaveCount(0)
        await expect(sheet.locator('[data-quick-panel-repeat-link]')).toHaveText('Make it repeat')
      })
    } finally {
      await page.request.delete(`/api/tasks/${recurring}`)
      await page.request.delete(`/api/tasks/${oneOff}`)
    }
  })

  test('a target-anchored repeat: its Deadline row reads None and opens every-time with "+ Add"', async ({
    authenticatedPage: page,
  }) => {
    // Until 4c a deadline on a repeat whose rule walks its target was hidden
    // (the #313 stopgap: the API refuses one, L9). Its home is every-time mode.
    const id = await createTask(page, {
      title: uniqueTitle('Timesheet'),
      rrule: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=12;BYMINUTE=0',
      priority: 2,
    })
    try {
      await withPreferences(page, unified(), async () => {
        const sheet = await openEditor(page, id)
        await expect(sheet.locator('[data-quick-panel-repeat-link]')).toContainText(
          'Sundays at 12:00 PM',
        )
        const deadline = sheet.locator('[data-quick-panel-deadline]')
        await expect(deadline).toHaveText('None')
        await deadline.tap()
        const region = everyTime(sheet)
        await expect(region.locator('[data-every-time-add-deadline]')).toBeFocused()
        await expect(region.getByRole('combobox', { name: 'Target time' })).toHaveText('12:00 PM')
      })
    } finally {
      await page.request.delete(`/api/tasks/${id}`)
    }
  })

  test('a deadline-only task (task queue off) shows its stored target as a date, never "auto"', async ({
    authenticatedPage: page,
  }) => {
    // Deadline 20 days out. With the task queue off (this user's server
    // default) the server still stores an automatic target, 4 days before it
    // (spec §8.1, one more release, plan A1). Since 2026-10-22 the editor no
    // longer labels it "auto" (the deadlines page replaced it; with the queue
    // on there is no target — "No target" and the Lead row,
    // tm-deadline-target.spec.ts): the Target row reads its date, like a pick.
    const deadline = new Date(Date.now() + 20 * DAY_MS)
    const id = await createTask(page, {
      title: uniqueTitle('Renew passport'),
      deadline_at: deadline.toISOString(),
      priority: 2,
    })
    try {
      const stored = await (await page.request.get(`/api/tasks/${id}`)).json()
      expect(stored.data.target_auto).toBe(true)
      await withPreferences(page, unified(), async () => {
        const sheet = await openEditor(page, id)
        const target = sheet.locator('[data-quick-panel-date]')
        await expect(target).not.toContainText('auto')
        await expect(target).not.toContainText('No target')
        await expect(target).toContainText(/\w{3}, \w{3} \d+, \d+:\d{2} [AP]M/)
        await expect(sheet.locator('[data-quick-panel-lead]')).toHaveCount(0)
      })
    } finally {
      await page.request.delete(`/api/tasks/${id}`)
    }
  })

  test('the link says the rule on a repeating task, "Make it repeat" on a one-off', async ({
    authenticatedPage: page,
  }) => {
    // The Repeat icon button is gone (A8): the text is the only way in, and
    // it says whether the task repeats (Trent, 2026-10-20: the button looked
    // the same either way). Neutral, never blue (blue = unsaved).
    const repeating = await createTask(page, { title: uniqueTitle('Rep on'), rrule: WEEKLY })
    const oneOff = await createTask(page, {
      title: uniqueTitle('Rep off'),
      due_at: new Date(Date.now() + DAY_MS).toISOString(),
    })
    try {
      await withPreferences(page, unified(), async () => {
        let sheet = await openEditor(page, repeating)
        const on = sheet.locator('[data-quick-panel-repeat-link]')
        await expect(on).toHaveAttribute('data-repeats', '')
        await expect(on).not.toHaveClass(/blue/)
        await expect(sheet.getByRole('button', { name: /Edit recurrence/ })).toHaveCount(0)

        sheet = await openEditor(page, oneOff)
        const off = sheet.locator('[data-quick-panel-repeat-link]')
        await expect(off).toHaveAccessibleName('Make it repeat')
        await expect(off).not.toHaveAttribute('data-repeats')
      })
    } finally {
      await page.request.delete(`/api/tasks/${repeating}`)
      await page.request.delete(`/api/tasks/${oneOff}`)
    }
  })
})

test.describe('Every-time mode on a phone: the starting time', () => {
  test('"Make it repeat" on an undated task starts at the user\'s Morning time, not 9:00', async ({
    authenticatedPage: page,
  }) => {
    // Every repeating task has a time (2026-10-12); a new rule's time is the
    // task's anchor, else its date's time, else the Morning setting.
    const title = uniqueTitle('Stretch')
    const id = await createTask(page, { title })
    try {
      await withPreferences(page, { ...unified(), morning_time: '08:30' }, async () => {
        const sheet = await openEditor(page, id)
        await sheet.locator('[data-quick-panel-repeat-link]').tap()
        const region = everyTime(sheet)
        await expect(region).toBeVisible()
        await region.getByRole('combobox', { name: 'How often' }).tap()
        await page.getByRole('option', { name: 'Daily', exact: true }).tap()
        await expect(region.getByRole('combobox', { name: 'Target time' })).toHaveText('8:30 AM')

        await region.getByRole('button', { name: 'Save', exact: true }).tap()
        await expect
          .poll(async () => (await (await page.request.get(`/api/tasks/${id}`)).json()).data.rrule)
          .toBe('FREQ=DAILY;BYHOUR=8;BYMINUTE=30')
      })
    } finally {
      await page.request.delete(`/api/tasks/${id}`)
    }
  })

  test('a "1st Saturday" rule keeps its weekday when only its time is edited', async ({
    authenticatedPage: page,
  }) => {
    // Before 2026-10-20 any edit rewrote such a rule to BYMONTHDAY=1. It is
    // carried through (the month-day select offers it as its own choice).
    const id = await createTask(page, {
      title: uniqueTitle('Craft'),
      rrule: 'FREQ=MONTHLY;BYDAY=1SA;BYHOUR=9;BYMINUTE=0',
    })
    try {
      await withPreferences(page, unified(), async () => {
        const sheet = await openEditor(page, id)
        await expect(sheet.locator('[data-quick-panel-repeat-link]')).toContainText(
          'Monthly on the 1st Sat at 9:00 AM',
        )
        await sheet.locator('[data-quick-panel-repeat-link]').tap()
        const region = everyTime(sheet)
        await expect(region.getByRole('combobox', { name: 'Day of the month' })).toHaveText(
          '1st Sat',
        )
        await region.getByRole('combobox', { name: 'Target time' }).tap()
        await page.getByRole('option', { name: '10:00 AM', exact: true }).tap()

        await region.getByRole('button', { name: 'Save', exact: true }).tap()
        await expect
          .poll(async () => (await (await page.request.get(`/api/tasks/${id}`)).json()).data.rrule)
          .toBe('FREQ=MONTHLY;BYDAY=1SA;BYHOUR=10;BYMINUTE=0')
      })
    } finally {
      await page.request.delete(`/api/tasks/${id}`)
    }
  })
})

function unified() {
  return { default_grouping: 'unified' }
}
