/**
 * Upcoming (2026-10-12, docs/TASK-MODEL.md § Upcoming) and the check-in day.
 *
 * A heads-up day is always AFTER the day the target was set, and the API
 * stamps every write with now, so each spec backdates `target_set_at` straight
 * in the E2E database: targeted 10 days ago for tomorrow is a wait of 11, so
 * today (T−1) is a heads-up day at any hour.
 *
 * The deadline (2026-10-22, the deadlines page) is the DeadlineChip that
 * leads every row's second line; "Back to auto" is gone — a deadline row's
 * target menu offers Remove target, like any one-off. (The page's own
 * Upcoming hand-off — a target-less deadline task's heads-up counted to its
 * lead day — is in deadlines-page.spec.ts, with the task queue on.)
 *
 * Isolation: every task is created here under a unique title and trashed in
 * `finally`; the check-in day is put back to Saturday.
 */
import path from 'path'
import Database from 'better-sqlite3'
import { DateTime } from 'luxon'
import { test, expect, backdateCreated, uniqueTitle } from './fixtures'
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

function backdateTargetSet(ids: number[], days: number) {
  const db = new Database(path.join(process.cwd(), 'data', 'test-e2e.db'))
  try {
    const stmt = db.prepare('UPDATE tasks SET target_set_at = ? WHERE id = ?')
    for (const id of ids) stmt.run(new Date(Date.now() - days * DAY).toISOString(), id)
  } finally {
    db.close()
  }
}

const tomorrowAt = (hour: number) =>
  DateTime.now().setZone(TZ).plus({ days: 1 }).set({ hour, minute: 0 }).toUTC().toISO()!

/** A one-off with a deadline, one without, and a repeating task — all due tomorrow. */
async function upcomingTrio(page: Page) {
  const withDeadline = await create(page, {
    title: uniqueTitle('UP deadline'),
    target_at: tomorrowAt(9),
    deadline_at: DateTime.now()
      .setZone(TZ)
      .plus({ days: 5 })
      .set({ hour: 23, minute: 59 })
      .toUTC()
      .toISO(),
  })
  const plain = await create(page, {
    title: uniqueTitle('UP plain'),
    target_at: tomorrowAt(10),
    horizon: 'days',
  })
  const repeating = await create(page, {
    title: uniqueTitle('UP repeating'),
    rrule: 'FREQ=DAILY;INTERVAL=3;BYHOUR=11;BYMINUTE=0',
    target_at: tomorrowAt(11),
  })
  backdateTargetSet([withDeadline, plain, repeating], 10)
  return { withDeadline, plain, repeating }
}

const upcoming = (page: Page) => page.locator('[data-task-segment="upcoming"]')
const row = (page: Page, id: number) => upcoming(page).locator(`[data-segment-task="${id}"]`)

test.describe('Upcoming', () => {
  test('on /reminders: after Days, rows in target order with the gap text; Today on every row', async ({
    authenticatedPage: page,
  }) => {
    const t = await upcomingTrio(page)
    const days = await create(page, { title: uniqueTitle('UP days'), horizon: 'days' })
    backdateCreated([days], { inSegments: true })
    try {
      await page.goto('/reminders')
      const section = upcoming(page)
      await expect(section).toBeVisible()
      // "Task queue · Upcoming", no "Heads-up" hint (2026-10-20).
      await expect(section).toHaveAttribute('aria-label', 'Task queue · Upcoming')
      await expect(section.getByText('Task queue · Upcoming', { exact: true })).toBeVisible()
      await expect(section.getByText('Heads-up')).toHaveCount(0)
      // Directly after Days.
      const order = await page
        .locator('[data-task-segments] [data-task-segment]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-task-segment')))
      expect(order.indexOf('upcoming')).toBe(order.indexOf('days') + 1)
      // Target order: 9:00, 10:00, 11:00.
      const ids = await section
        .locator('[data-segment-task]')
        .evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-segment-task'))))
      expect(ids.filter((id) => Object.values(t).includes(id))).toEqual([
        t.withDeadline,
        t.plain,
        t.repeating,
      ])
      // The gap text: the project, the deadline chip right after it, the target.
      const gap = row(page, t.withDeadline).locator('[data-upcoming-gap]')
      await expect(gap.locator('> *').nth(0)).toHaveAttribute('data-segment-project')
      await expect(gap.locator('> *').nth(1)).toHaveAttribute('data-deadline-chip', 'ahead')
      await expect(gap.locator('[data-deadline-chip]')).toHaveText(/^Deadline \w+/)
      // A Tomorrow row (2026-10-25, the Upcoming split): just the time, in
      // the target's chip (no "Target" word since the time chips, 10-28).
      const targetChip = '[data-target-chip], [data-time-chip="target"]'
      await expect(gap.locator(targetChip)).toHaveText(/^9:00 AM$/)
      // The repeating row names its schedule, never a bare "repeats".
      await expect(row(page, t.repeating).locator('[data-upcoming-gap]')).not.toContainText(
        'repeats',
      )
      await expect(
        row(page, t.plain).locator('[data-upcoming-gap]').locator(targetChip),
      ).toHaveText(/^10:00 AM$/)
      // All three are due tomorrow: in the Tomorrow section.
      for (const id of Object.values(t)) {
        await expect(
          section
            .locator('[data-upcoming-section="tomorrow"]')
            .locator(`[data-segment-task="${id}"]`),
        ).toBeVisible()
      }
      // Every row has Today — the repeating one too since §6 (its occurrence
      // stays put; only the target moves) — plus circle and done.
      await expect(row(page, t.withDeadline).locator('[data-target-today]')).toHaveCount(1)
      await expect(row(page, t.plain).locator('[data-target-today]')).toHaveCount(1)
      await expect(row(page, t.repeating).locator('[data-target-today]')).toHaveCount(1)
      await expect(
        row(page, t.repeating).getByRole('button', { name: /as considered/ }),
      ).toHaveCount(1)
      await expect(row(page, t.repeating).getByRole('button', { name: /^Done:/ })).toHaveCount(1)
      // No horizon chip on any Upcoming row.
      await expect(section.locator('[data-horizon-chip]')).toHaveCount(0)
      // The one-offs' target chips open a menu (Remove target);
      // the repeating row's doesn't.
      await expect(row(page, t.withDeadline).getByRole('button', { name: /Options$/ })).toHaveCount(
        1,
      )
      await expect(row(page, t.repeating).getByRole('button', { name: /Options$/ })).toHaveCount(0)
      await expect(row(page, t.plain).getByRole('button', { name: /Options$/ })).toHaveCount(1)
    } finally {
      await trash(page, [...Object.values(t), days])
    }
  })

  test('Remove target sends a no-deadline one-off back to its horizon segment; Undo restores it', async ({
    authenticatedPage: page,
  }) => {
    const t = await upcomingTrio(page)
    try {
      const before = await stateOf(page, t.plain)
      await page.goto('/reminders')
      await row(page, t.plain)
        .getByRole('button', { name: /Options$/ })
        .click()
      await page.locator('[data-remove-target]').click()
      await expect(row(page, t.plain)).toHaveCount(0)
      await expect(
        page.locator('[data-task-segment="days"]').locator(`[data-segment-task="${t.plain}"]`),
      ).toBeVisible()
      await expect.poll(async () => (await stateOf(page, t.plain)).target_at).toBeNull()
      await page.locator('[data-sonner-toast]').getByRole('button', { name: 'Undo' }).click()
      await expect.poll(async () => (await stateOf(page, t.plain)).target_at).toBe(before.target_at)
      expect((await stateOf(page, t.plain)).target_set_at).toBe(before.target_set_at)
      await expect(row(page, t.plain)).toBeVisible()
    } finally {
      await trash(page, Object.values(t))
    }
  })

  test('a deadline row offers Remove target too (no Back to auto); it leaves Upcoming; Undo restores the pick', async ({
    authenticatedPage: page,
  }) => {
    const t = await upcomingTrio(page)
    try {
      const before = await stateOf(page, t.withDeadline)
      expect(before.target_auto).toBe(false)
      await page.goto('/reminders')
      await row(page, t.withDeadline)
        .getByRole('button', { name: /Options$/ })
        .click()
      await expect(page.locator('[data-back-to-auto]')).toHaveCount(0)
      await page.locator('[data-remove-target]').click()
      await expect(row(page, t.withDeadline)).toHaveCount(0)
      // With the task queue off the server still keeps an automatic target
      // (A1, one release); with it on there is none (deadlines-page.spec.ts).
      await expect
        .poll(async () => (await stateOf(page, t.withDeadline)).target_at)
        .not.toBe(before.target_at)
      await page.locator('[data-sonner-toast]').getByRole('button', { name: 'Undo' }).click()
      await expect
        .poll(async () => (await stateOf(page, t.withDeadline)).target_at)
        .toBe(before.target_at)
      expect((await stateOf(page, t.withDeadline)).target_auto).toBe(false)
    } finally {
      await trash(page, Object.values(t))
    }
  })

  test('on the dashboard Tasks card: its own page and bar, considered with "X of Y"', async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 })
    const t = await upcomingTrio(page)
    // A second segment, so the card shows its strip (one segment is not a bar).
    const days = await create(page, { title: uniqueTitle('UP card days'), horizon: 'days' })
    backdateCreated([days], { inSegments: true })
    try {
      await page.goto('/')
      const card = page.locator('[data-tasks-panel]')
      const strip = card.getByRole('group', { name: "Today's task segments" })
      await expect(strip.locator('[data-slot-segment="tasks:upcoming"]')).toHaveCount(1)
      await strip.locator('[data-slot-segment="tasks:upcoming"]').click()
      await expect(card).toHaveAttribute('data-tasks-page', 'tasks:upcoming')
      await expect(card.locator('[data-slot-header-toggle]')).toHaveText('Task queue · Upcoming')
      const r = card.locator(`[data-segment-task="${t.repeating}"]`)
      await expect(r.locator('[data-target-today]')).toHaveCount(1)
      await r.getByRole('button', { name: /as considered/ }).click()
      await expect(r).toHaveCount(0)
      await expect
        .poll(async () => (await stateOf(page, t.repeating)).last_considered_at)
        .not.toBeNull()
      await expect(card.locator('[data-considered-toggle]')).toHaveText(/^1 of \d+/)
    } finally {
      await trash(page, [...Object.values(t), days])
    }
  })
})

test.describe('Check-in day', () => {
  test('the setting moves Weeks to its weekday, under its one-word title', async ({
    authenticatedPage: page,
  }) => {
    const today = DateTime.now().setZone(TZ)
    const weeks = await create(page, { title: uniqueTitle('UP weeks'), horizon: 'weeks' })
    // Made yesterday: shown on today's check-in day, not on tomorrow's.
    backdateCreated([weeks], { inSegments: true })
    try {
      await page.goto('/settings')
      const select = page.locator('[data-check-in-day-select]')
      await expect(select).toHaveValue('6')
      await select.selectOption(String(today.weekday))
      await expect
        .poll(
          async () =>
            (await (await page.request.get('/api/user/preferences')).json()).data.check_in_day,
        )
        .toBe(today.weekday)

      await page.goto('/reminders')
      const section = page.locator('[data-task-segment="weeks"]')
      await expect(section.locator(`[data-segment-task="${weeks}"]`)).toBeVisible()
      // The header is "Task queue · Weekly" alone: the weekday hint went
      // with the panel titles (2026-10-20).
      await expect(section).toHaveAttribute('aria-label', 'Task queue · Weekly')
      await expect(section.getByText(`${today.toFormat('cccc')}s`)).toHaveCount(0)

      const tomorrow = today.plus({ days: 1 }).weekday
      await page.request.patch('/api/user/preferences', { data: { check_in_day: tomorrow } })
      await page.goto('/reminders')
      await expect(page.locator(`[data-segment-task="${weeks}"]`)).toHaveCount(0)
    } finally {
      await page.request.patch('/api/user/preferences', { data: { check_in_day: 6 } })
      await trash(page, [weeks])
    }
  })
})
