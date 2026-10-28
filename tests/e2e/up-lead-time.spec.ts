/**
 * Upcoming's two sections and lead time on the web (2026-10-25, the Upcoming
 * split PR B; docs/TASK-MODEL.md § Upcoming):
 *
 * - the Upcoming section on /reminders draws "Tomorrow" then "Later", each
 *   with its own count; an empty one reads "Nothing today ✓" (1280 light and
 *   375 dark, no sideways scroll); a Tomorrow row says only the time;
 * - seen is per section: a row seen in Later still shows in Tomorrow, one
 *   seen in Later before Tomorrow's day does not show at all;
 * - the editor's Lead time row on a task with a target: its words, the
 *   clamp, and a lead override saved from it moving the task into Later;
 * - every-time mode's Lead time stepper on a weekly repeat.
 *
 * Days are counted from today in the E2E zone; each spec backdates
 * `target_set_at` / `last_considered_at` straight in the E2E database (the
 * API stamps every write with now). `hideStraySegmentTasks` keeps other
 * specs' tasks out of Upcoming, so only this spec's rows are in it.
 *
 * Isolation: every task is created here under a unique title and trashed in
 * `finally`.
 */
import path from 'path'
import Database from 'better-sqlite3'
import { DateTime } from 'luxon'
import { test, expect, hideStraySegmentTasks, uniqueTitle } from './fixtures'
import type { Page } from '@playwright/test'

const TZ = process.env.E2E_TZ || 'America/Chicago'
const DAY = 24 * 60 * 60 * 1000

async function create(page: Page, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data })
  expect(res.ok(), `create ${JSON.stringify(data)}`).toBeTruthy()
  return (await res.json()).data.id as number
}

async function stateOf(page: Page, id: number): Promise<Record<string, unknown>> {
  const res = await page.request.get(`/api/tasks/${id}`)
  return (await res.json()).data as Record<string, unknown>
}

async function trash(page: Page, ids: number[]) {
  if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
}

/** Set a column to `days` days ago (now − days), straight in the E2E database. */
function backdate(column: 'target_set_at' | 'last_considered_at', ids: number[], days: number) {
  const db = new Database(path.join(process.cwd(), 'data', 'test-e2e.db'))
  try {
    const stmt = db.prepare(`UPDATE tasks SET ${column} = ? WHERE id = ?`)
    for (const id of ids) stmt.run(new Date(Date.now() - days * DAY).toISOString(), id)
  } finally {
    db.close()
  }
}

const today = () => DateTime.now().setZone(TZ).startOf('day')
/** Today + `days` at `hour`, as UTC ISO. */
const dayAt = (days: number, hour = 9) =>
  today().plus({ days }).set({ hour, minute: 0 }).toUTC().toISO()!
const fmt = (days: number) => today().plus({ days }).toFormat('ccc LLL d')

const upcoming = (page: Page) => page.locator('[data-task-segment="upcoming"]')
const section = (page: Page, name: 'tomorrow' | 'later') =>
  upcoming(page).locator(`[data-upcoming-section="${name}"]`)

test.describe('Upcoming: Tomorrow and Later', () => {
  test('two sections in order, each its own count; Nothing today ✓; a Tomorrow row says only the time — 1280 light, 375 dark', async ({
    authenticatedPage: page,
  }) => {
    hideStraySegmentTasks()
    // Target tomorrow 9:00, set 10 days ago: Tomorrow today.
    const soon = await create(page, { title: uniqueTitle('UPL tomorrow'), target_at: dayAt(1) })
    backdate('target_set_at', [soon], 10)
    try {
      await page.setViewportSize({ width: 1280, height: 900 })
      await page.emulateMedia({ colorScheme: 'light' })
      await page.goto('/reminders')
      // Wait for the sections to draw before reading their order.
      await expect(upcoming(page).locator('[data-upcoming-section]')).toHaveCount(2)
      const names = await upcoming(page)
        .locator('[data-upcoming-section]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-upcoming-section')))
      expect(names).toEqual(['tomorrow', 'later'])
      await expect(section(page, 'tomorrow').locator('[data-upcoming-section-title]')).toHaveText(
        'Tomorrow',
      )
      await expect(section(page, 'later').locator('[data-upcoming-section-title]')).toHaveText(
        'Later',
      )
      const row = section(page, 'tomorrow').locator(`[data-segment-task="${soon}"]`)
      await expect(row).toBeVisible()
      // The day goes without saying: "9:00 AM" (the time chip, no "Target" word).
      await expect(row.locator('[data-target-chip]')).toHaveText(/^9:00 AM/)
      await expect(section(page, 'tomorrow').locator('[data-upcoming-section-count]')).toHaveText(
        '0 of 1',
      )
      // Later is empty today: done from the start.
      await expect(section(page, 'later').locator('[data-segment-empty]')).toHaveText(
        'Nothing today',
      )
      await expect(section(page, 'later').locator('[data-upcoming-section-count]')).toHaveText(
        '0 of 0',
      )
      // No segment-level empty line besides the sections' own.
      await expect(upcoming(page).locator('[data-segment-empty]')).toHaveCount(1)

      // Consider it: Tomorrow "1 of 1", its own "Show 1 considered".
      await row.getByRole('button', { name: /as considered/ }).click()
      await expect(row).toHaveCount(0)
      await expect(section(page, 'tomorrow').locator('[data-upcoming-section-count]')).toHaveText(
        '1 of 1',
      )
      await section(page, 'tomorrow').locator('[data-segment-considered-toggle]').click()
      await expect(
        section(page, 'tomorrow').locator(`[data-considered-task-id="${soon}"]`),
      ).toBeVisible()
      await expect(section(page, 'later').locator('[data-segment-considered-toggle]')).toHaveCount(
        0,
      )

      await page.setViewportSize({ width: 375, height: 812 })
      await page.emulateMedia({ colorScheme: 'dark' })
      await page.goto('/reminders')
      await expect(section(page, 'tomorrow')).toBeVisible()
      await expect(section(page, 'later').locator('[data-segment-empty]')).toBeVisible()
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      )
      expect(overflow).toBeLessThanOrEqual(0)
    } finally {
      await page.emulateMedia({ colorScheme: null })
      await trash(page, [soon])
    }
  })

  test('seen is per section: seen in Later, still in Tomorrow on the day before; seen in Later before it — gone', async ({
    authenticatedPage: page,
  }) => {
    hideStraySegmentTasks()
    // Tomorrow 9:00, lead 5, set 10 days ago: Later 4 days ago, Tomorrow today.
    const tomorrow = await create(page, {
      title: uniqueTitle('UPL seen then tomorrow'),
      target_at: dayAt(1),
      lead_days: 5,
    })
    // In 3 days, lead 5, set 10 days ago: Later 2 days ago — seen yesterday.
    const later = await create(page, {
      title: uniqueTitle('UPL seen in later'),
      target_at: dayAt(3),
      lead_days: 5,
    })
    backdate('target_set_at', [tomorrow, later], 10)
    // Both seen in Later (after their Later day, before today).
    backdate('last_considered_at', [tomorrow], 3)
    backdate('last_considered_at', [later], 1)
    try {
      await page.goto('/reminders')
      await expect(
        section(page, 'tomorrow').locator(`[data-segment-task="${tomorrow}"]`),
      ).toBeVisible()
      await expect(upcoming(page).locator(`[data-segment-task="${later}"]`)).toHaveCount(0)
      // The API agrees, and names the section.
      const body = (await (await page.request.get('/api/reminders?handled=1')).json()).data
      const seg = (
        body.task_segments as { horizon: string; tasks: Record<string, unknown>[] }[]
      ).find((s) => s.horizon === 'upcoming')!
      expect(seg.tasks.find((t) => t.id === tomorrow)?.upcoming_section).toBe('tomorrow')
      expect(seg.tasks.find((t) => t.id === later)).toBeUndefined()
    } finally {
      await trash(page, [tomorrow, later])
    }
  })

  test('the dashboard Tasks card: the Upcoming page has both sections, Tomorrow first', async ({
    authenticatedPage: page,
  }) => {
    hideStraySegmentTasks()
    await page.setViewportSize({ width: 1600, height: 900 })
    const soon = await create(page, {
      title: uniqueTitle('UPL card tomorrow'),
      target_at: dayAt(1),
    })
    // In 10 days, lead 10, set 5 days ago: Later today.
    const far = await create(page, {
      title: uniqueTitle('UPL card later'),
      target_at: dayAt(10),
      lead_days: 10,
    })
    backdate('target_set_at', [soon, far], 5)
    try {
      await page.goto('/')
      const card = page.locator('[data-tasks-panel]')
      const strip = card.getByRole('group', { name: "Today's task segments" })
      await strip.locator('[data-slot-segment="tasks:upcoming"]').click()
      await expect(card).toHaveAttribute('data-tasks-page', 'tasks:upcoming')
      const ids = await card
        .locator('[data-upcoming-section] [data-segment-task]')
        .evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-segment-task'))))
      expect(ids).toEqual([soon, far])
      await expect(
        card.locator('[data-upcoming-section="later"]').locator(`[data-segment-task="${far}"]`),
      ).toContainText(fmt(10))
      // The page's count covers both sections.
      await expect(card.locator('[data-slot-header-toggle]')).toHaveText('Task queue · Upcoming')
    } finally {
      await trash(page, [soon, far])
    }
  })
})

test.describe('Lead time', () => {
  test('the editor row on a task with a target: its words, the clamp, and Default', async ({
    authenticatedPage: page,
  }) => {
    // Made today for tomorrow: no Upcoming rows at all.
    const made = await create(page, { title: uniqueTitle('UPL made today'), target_at: dayAt(1) })
    // In 4 days, set today: the day before only.
    const short = await create(page, { title: uniqueTitle('UPL short'), target_at: dayAt(4) })
    // In 4 days with a lead of 10: clamped to tomorrow.
    const clamped = await create(page, {
      title: uniqueTitle('UPL clamped'),
      target_at: dayAt(4),
      lead_days: 10,
    })
    try {
      const lead = page.locator('[data-quick-panel-lead="upcoming"]')
      await page.goto(`/tasks/${made}`)
      await expect(page.locator('[data-task-model-fields]')).toContainText('Lead time')
      await expect(lead.locator('[data-lead-words]')).toHaveText(
        'Not in Upcoming (the target is tomorrow)',
      )

      await page.goto(`/tasks/${short}`)
      await expect(lead.locator('[data-lead-words]')).toHaveText(
        `Tomorrow on ${fmt(3)} (the day before)`,
      )
      await expect(lead.locator('[data-lead-days]')).toHaveText('1 day')

      await page.goto(`/tasks/${clamped}`)
      await expect(lead.locator('[data-lead-words]')).toHaveText(
        `Later on ${fmt(1)} (3 days before) · Tomorrow on ${fmt(3)}`,
      )
      await expect(lead.locator('[data-lead-clamped]')).toHaveText('(as early as it can be)')
      await expect(lead.getByRole('button', { name: 'One day more' })).toBeDisabled()
      // Default: the table again (a wait of 4 → the day before), previewed.
      await lead.getByRole('button', { name: 'Default lead' }).click()
      await expect(lead.locator('[data-lead-words]')).toHaveText(
        `Tomorrow on ${fmt(3)} (the day before)`,
      )
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect.poll(async () => (await stateOf(page, clamped)).lead_days).toBeNull()
    } finally {
      await trash(page, [made, short, clamped])
    }
  })

  test('a lead override from the editor moves a task into Later today', async ({
    authenticatedPage: page,
  }) => {
    hideStraySegmentTasks()
    // In 10 days, set 5 days ago: a wait of 15 → the default 3 → Later in 7 days.
    const id = await create(page, { title: uniqueTitle('UPL override'), target_at: dayAt(10) })
    backdate('target_set_at', [id], 5)
    try {
      await page.goto('/reminders')
      await expect(upcoming(page).locator(`[data-segment-task="${id}"]`)).toHaveCount(0)

      await page.goto(`/tasks/${id}`)
      const lead = page.locator('[data-quick-panel-lead="upcoming"]')
      await expect(lead.locator('[data-lead-words]')).toHaveText(
        `Later on ${fmt(7)} (3 days before) · Tomorrow on ${fmt(9)}`,
      )
      const more = lead.getByRole('button', { name: 'One day more' })
      for (let n = 4; n <= 10; n++) {
        await more.click()
        await expect(lead.locator('[data-lead-days]')).toHaveText(`${n} days`)
      }
      await expect(lead.locator('[data-lead-words]')).toHaveText(
        `Later on ${fmt(0)} (10 days before) · Tomorrow on ${fmt(9)}`,
      )
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect.poll(async () => (await stateOf(page, id)).lead_days).toBe(10)
      // A lead change does not restamp the set day (decision 12): Later today.
      await page.goto('/reminders')
      await expect(section(page, 'later').locator(`[data-segment-task="${id}"]`)).toBeVisible()
    } finally {
      await trash(page, [id])
    }
  })

  test('every-time mode: the Lead time stepper on a weekly repeat', async ({
    authenticatedPage: page,
  }) => {
    const id = await create(page, {
      title: uniqueTitle('UPL weekly'),
      rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=16;BYMINUTE=0',
    })
    try {
      await page.goto(`/tasks/${id}`)
      // A repeat's lead is the series': words only in this-one mode.
      await expect(
        page
          .locator('[data-quick-panel-lead="upcoming"]')
          .getByRole('group', { name: 'Lead time' }),
      ).toHaveCount(0)
      await page.locator('[data-quick-panel-repeat-link]').click()
      const region = page.getByRole('region', { name: 'Editing every time' })
      const row = region.locator('[data-every-time-upcoming-lead]')
      await expect(row.locator('[data-every-time-upcoming-lead-words]')).toHaveText(
        'Tomorrow the day before each one',
      )
      const more = row.getByRole('button', { name: 'One day more' })
      await more.click()
      await more.click()
      await expect(row.locator('[data-every-time-upcoming-lead-words]')).toHaveText(
        'Later 3 days before each one · Tomorrow the day before',
      )
      // Up to the rule's wait − 1 (6 for a weekly).
      for (let n = 4; n <= 6; n++) await more.click()
      await expect(row.locator('[data-every-time-upcoming-lead-days]')).toHaveText('6 days')
      await expect(more).toBeDisabled()
      await row.getByRole('button', { name: 'One day less' }).click()
      await row.getByRole('button', { name: 'One day less' }).click()
      await row.getByRole('button', { name: 'One day less' }).click()
      await region.getByRole('button', { name: 'Save', exact: true }).click()
      await expect.poll(async () => (await stateOf(page, id)).lead_days).toBe(3)
    } finally {
      await trash(page, [id])
    }
  })

  test('a shorter rule resets a lead it makes too long: weekly with lead 3 made daily saves, lead_days null', async ({
    authenticatedPage: page,
  }) => {
    const id = await create(page, {
      title: uniqueTitle('UPL weekly to daily'),
      rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=16;BYMINUTE=0',
      lead_days: 3,
    })
    try {
      const failed: number[] = []
      page.on('response', (r) => {
        if (r.request().method() === 'PATCH' && r.url().includes(`/api/tasks/${id}`) && !r.ok())
          failed.push(r.status())
      })
      await page.goto(`/tasks/${id}`)
      await page.locator('[data-quick-panel-repeat-link]').click()
      const region = page.getByRole('region', { name: 'Editing every time' })
      await region.getByRole('combobox', { name: 'How often' }).click()
      await page.getByRole('option', { name: 'Daily' }).click()
      await expect(region.locator('[data-every-time-lead-reset]')).toHaveText(
        'Lead time back to default for the new rule',
      )
      // Every 2 days: the stepper shows the default (the day before), no Default button.
      await region.getByLabel('Every how many days').fill('2')
      await region.getByLabel('Every how many days').press('Tab')
      const row = region.locator('[data-every-time-upcoming-lead]')
      await expect(row.locator('[data-every-time-upcoming-lead-days]')).toHaveText('1 day')
      await expect(row).toContainText('Lead time back to default for the new rule')
      await expect(row.getByRole('button', { name: 'Default lead' })).toHaveCount(0)
      await region.getByLabel('Every how many days').fill('1')
      await region.getByLabel('Every how many days').press('Tab')
      await region.getByRole('button', { name: 'Save', exact: true }).click()
      await expect.poll(async () => (await stateOf(page, id)).rrule).toMatch(/^FREQ=DAILY/)
      expect((await stateOf(page, id)).lead_days).toBeNull()
      expect(failed).toEqual([])
      await expect(page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0)
    } finally {
      await trash(page, [id])
    }
  })
})
