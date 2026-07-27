/**
 * The Reminders surface (REDESIGN-V03 §6)
 *
 * The behavioral suite (rm-reminders.test.ts) pins what a reminder IS — no
 * debt, no badge, slot-locked. These tests cover what only a browser can show:
 * that the surface is reachable as a tab, that it groups by time slot, that
 * completing an item drops it out of its slot without touching the overdue
 * count, and that both empty states read as deliberate rather than broken.
 *
 * Reminders are created through the API rather than added to the shared seed,
 * and removed again afterwards, so these tests cannot perturb the counts other
 * specs assert on. The view preference is restored after every test for the
 * same reason: it persists per user, and leaving it on "Reminders" would open
 * every later spec on the wrong surface.
 */

import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import { DateTime } from 'luxon'

/** The seeded test user's timezone — slot assignment is done in local time. */
const TEST_TZ = 'America/Chicago'

/** Today at HH:MM in the user's timezone, as a UTC ISO string. */
function todayAt(hour: number, minute = 0): string {
  return DateTime.now()
    .setZone(TEST_TZ)
    .set({ hour, minute, second: 0, millisecond: 0 })
    .toUTC()
    .toISO() as string
}

async function createReminder(page: Page, body: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data: { is_reminder: true, ...body } })
  expect(res.ok()).toBeTruthy()
  const json = await res.json()
  return json.data.id as number
}

async function deleteTasks(page: Page, ids: number[]): Promise<void> {
  for (const id of ids) {
    await page.request.delete(`/api/tasks/${id}`)
  }
}

/** Switch the dashboard to a view via the toggle that looks like a tab (§6). */
async function switchView(page: Page, name: string): Promise<void> {
  await page.getByRole('group', { name: 'View mode' }).getByRole('button', { name }).click()
}

test.describe('Reminders surface', () => {
  test.afterEach(async ({ authenticatedPage: page }) => {
    // default_grouping is a persisted user preference — put it back so the next
    // spec opens on the task list.
    await page.request.patch('/api/user/preferences', { data: { default_grouping: 'project' } })
  })

  test('explains itself when the user has no reminders', async ({ authenticatedPage: page }) => {
    await switchView(page, 'Reminders')

    await expect(
      page.getByRole('heading', { name: 'Reminders are thoughts, not tasks' }),
    ).toBeVisible()
    // The hint has to be actionable without documentation.
    await expect(page.getByText(/turn on/i)).toBeVisible()
  })

  test('groups by time slot, orders by prominence, and stays out of the task list', async ({
    authenticatedPage: page,
  }) => {
    const ids = [
      await createReminder(page, {
        title: 'Consider the evening wind-down',
        due_at: todayAt(20, 30),
      }),
      await createReminder(page, { title: 'Morning supplements', due_at: todayAt(7), priority: 3 }),
      await createReminder(page, {
        title: 'Depressed = Past, Anxious = Future',
        due_at: todayAt(7),
      }),
      await createReminder(page, { title: 'A thought with no hour' }),
    ]

    try {
      await switchView(page, 'Reminders')

      // Slot headers carry the label and the boundary time.
      await expect(page.getByText('Early morning', { exact: true })).toBeVisible()
      await expect(page.getByText('7:00 AM')).toBeVisible()
      await expect(page.getByText('Evening', { exact: true })).toBeVisible()
      // Un-slotted reminders get an honest group rather than disappearing.
      await expect(page.getByText('Anytime', { exact: true })).toBeVisible()

      // Priority is prominence: the higher-priority thought sits first inside
      // its slot. Nothing else about it shouts.
      const rows = page.locator('li[data-reminder-id]')
      await expect(rows.first()).toContainText('Morning supplements')

      // A reminder row is a circle and a sentence — no snooze affordance, no
      // due chip, nothing that treats it as an obligation.
      await expect(page.getByRole('button', { name: /snooze "Morning supplements"/i })).toHaveCount(
        0,
      )
      await expect(
        page.getByRole('button', { name: 'Mark "Morning supplements" as considered' }),
      ).toBeVisible()

      // §7.3: the dashboard is tasks. Reminders live only on their own surface.
      await switchView(page, 'All')
      await expect(page.getByText('Morning supplements')).toHaveCount(0)
    } finally {
      await deleteTasks(page, ids)
    }
  })

  test('completing an item drops it out without touching the overdue count', async ({
    authenticatedPage: page,
  }) => {
    // Due earlier today: an ordinary task with this date would be overdue and
    // counted. A reminder never is — that is the §6 carve-out.
    const ids = [
      await createReminder(page, { title: 'Breathe before replying', due_at: todayAt(7) }),
      await createReminder(page, { title: 'Stand up and stretch', due_at: todayAt(7) }),
    ]

    try {
      // The tab title carries the overdue count; capture it after the reminders
      // exist so the assertion covers "they never counted in the first place".
      await page.reload()
      await switchView(page, 'Reminders')
      await expect(
        page.getByRole('button', { name: 'Mark "Breathe before replying" as considered' }),
      ).toBeVisible()
      const titleBefore = await page.title()

      await page
        .getByRole('button', { name: 'Mark "Breathe before replying" as considered' })
        .click()

      // Completed items leave the slot rather than burying the rest.
      await expect(page.getByText('Breathe before replying')).toHaveCount(0)
      await expect(page.getByText('Stand up and stretch')).toBeVisible()

      // Completion is the ordinary complete/undo pipeline, so undo is offered.
      await expect(page.getByText('Considered')).toBeVisible()
      await expect(page.getByText('Undo')).toBeVisible()

      // The badge is untouched — no reminder ever entered it.
      await expect(page).toHaveTitle(titleBefore)
    } finally {
      await deleteTasks(page, ids)
    }
  })

  test('says "all clear" once today is done', async ({ authenticatedPage: page }) => {
    const id = await createReminder(page, { title: 'The only thought left', due_at: todayAt(12) })

    try {
      await switchView(page, 'Reminders')
      await page.getByRole('button', { name: 'Mark "The only thought left" as considered' }).click()

      // Calm, not an error state — and distinctly not the "what is this?"
      // explainer, which would be wrong for someone who just finished.
      await expect(page.getByRole('heading', { name: 'All clear' })).toBeVisible()
      await expect(
        page.getByRole('heading', { name: 'Reminders are thoughts, not tasks' }),
      ).toHaveCount(0)
    } finally {
      await deleteTasks(page, [id])
    }
  })
})
