/**
 * The Reminders surface (REDESIGN-V03 §6)
 *
 * The behavioral suite (rm-reminders.test.ts) pins what a reminder IS — no
 * debt, no badge, slot-locked. These tests cover what only a browser can show:
 * that `/reminders` is a real page reachable from the nav, that it groups by
 * time slot, that completing an item drops it out of its slot without touching
 * the overdue count, and that both empty states read as deliberate rather than
 * broken. The last test guards the other direction — the dashboard's view
 * toggle went back to three groupings when this became a route.
 *
 * Reminders are created through the API rather than added to the shared seed,
 * and removed again afterwards, so these tests cannot perturb the counts other
 * specs assert on.
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

/** Open the surface and wait for its first fetch to resolve into a rendered state. */
async function openReminders(page: Page): Promise<void> {
  await page.goto('/reminders')
  await expect(page.getByRole('heading', { name: 'Reminders', level: 1 })).toBeVisible()
}

/**
 * Only the current time slot is open by default; the rest fold behind their
 * header with a count. Tests assert on rows regardless of the wall clock, so
 * they open every folded slot first — without toggling one that is already
 * open, which would hide the rows they are about to look for.
 */
async function openAllSlots(page: Page) {
  // Scoped to the surface itself so a folded nav menu elsewhere is never clicked.
  const surface = page.getByRole('region', { name: 'Reminders' })
  const n = await surface.getByRole('button', { expanded: false }).count()
  for (let i = 0; i < n; i++) {
    // Re-query each time: opening a slot re-renders the list.
    await surface.getByRole('button', { expanded: false }).first().click()
  }
}

test.describe('Reminders surface', () => {
  test('is a top-level page reachable from the nav', async ({ authenticatedPage: page }) => {
    // Desktop sidebar carries every destination; the mobile tab bar is checked
    // implicitly by sharing the same href.
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.getByRole('link', { name: 'Reminders' }).click()

    await page.waitForURL('/reminders')
    await expect(page.getByRole('heading', { name: 'Reminders', level: 1 })).toBeVisible()
  })

  test('explains itself when the user has no reminders', async ({ authenticatedPage: page }) => {
    await openReminders(page)

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
      await openReminders(page)

      // Slot headers carry the label and the boundary time — visible whether the
      // slot is open or folded.
      await expect(page.getByText('Early morning', { exact: true })).toBeVisible()
      await expect(page.getByText('7:00 AM')).toBeVisible()
      await expect(page.getByText('Evening', { exact: true })).toBeVisible()
      // Un-slotted reminders get an honest group rather than disappearing.
      await expect(page.getByText('Anytime', { exact: true })).toBeVisible()

      // Priority is prominence: the higher-priority thought sits first inside
      // its slot. Nothing else about it shouts.
      await openAllSlots(page)
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

      // §7.3: the dashboard is tasks. Reminders live only on their own page.
      await page.goto('/')
      await expect(page.getByText('Morning supplements')).toHaveCount(0)
    } finally {
      await deleteTasks(page, ids)
    }
  })

  test('completing an item drops it out, undoes, and never enters the counts', async ({
    authenticatedPage: page,
  }) => {
    // The header's count badges are rendered from the same data as the overdue
    // badge, and only after the task list has loaded — so reading them is a
    // settled measurement, not a race against an effect.
    const counts = page.getByRole('group', { name: 'Task counts' })
    await expect(counts).toBeVisible()
    const countsBefore = (await counts.textContent()) ?? ''

    // Due earlier today: ordinary tasks with this date would be overdue and
    // counted. A reminder never is — that is the §6 carve-out.
    const ids = [
      await createReminder(page, { title: 'Breathe before replying', due_at: todayAt(7) }),
      await createReminder(page, { title: 'Stand up and stretch', due_at: todayAt(7) }),
    ]

    try {
      // Two reminders now exist and are past due; the dashboard must not notice.
      await page.reload()
      await expect(counts).toHaveText(countsBefore)

      await openReminders(page)
      await openAllSlots(page)
      await expect(
        page.getByRole('button', { name: 'Mark "Breathe before replying" as considered' }),
      ).toBeVisible()

      await page
        .getByRole('button', { name: 'Mark "Breathe before replying" as considered' })
        .click()

      // Completed items leave the slot rather than burying the rest. Matched by
      // the row element rather than by page text: undo toasts quote the title
      // back, so bare text would match the toast as well as the row.
      const consideredRow = page.locator('li[data-reminder-id]', {
        hasText: 'Breathe before replying',
      })
      await expect(consideredRow).toHaveCount(0)
      await expect(
        page.locator('li[data-reminder-id]', { hasText: 'Stand up and stretch' }),
      ).toBeVisible()

      // Completion is the ordinary complete/undo pipeline, so undo is offered —
      // and the page has to carry that pipeline itself now that it is standalone.
      // The toast names what was considered; a bare "Considered" would also match
      // the slot header's "Considered all".
      await expect(page.getByText('Considered “Breathe before replying”')).toBeVisible()

      // Undo puts the item back on the surface, which proves the page's refresh
      // chain reaches the reminders list and not just the toast.
      await page.getByRole('button', { name: 'Undo' }).click()
      await expect(consideredRow).toBeVisible()
    } finally {
      await deleteTasks(page, ids)
    }
  })

  test('selects like the dashboard: click, shift-click a range, act from the bar', async ({
    authenticatedPage: page,
  }) => {
    const ids = [
      await createReminder(page, { title: 'First thought of the range', due_at: todayAt(7) }),
      await createReminder(page, { title: 'Second thought of the range', due_at: todayAt(7) }),
      await createReminder(page, { title: 'Third thought of the range', due_at: todayAt(7) }),
    ]

    try {
      await openReminders(page)
      await openAllSlots(page)
      const row = (title: string) => page.locator('li[data-reminder-id]', { hasText: title })

      // A plain click selects the row and raises the bar — it does NOT navigate.
      await row('First thought of the range').click()
      await expect(page).toHaveURL(/\/reminders/)
      await expect(row('First thought of the range')).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByRole('button', { name: 'Considered', exact: true })).toBeVisible()
      // Single selection offers Details; that is the deliberate way to open one.
      await expect(page.getByRole('button', { name: 'Details', exact: true })).toBeVisible()

      // Shift-click extends to a range, and the bar reports the count.
      await row('Third thought of the range').click({ modifiers: ['Shift'] })
      await expect(row('Second thought of the range')).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByText('3 selected')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Details', exact: true })).toHaveCount(0)

      // One action considers the whole selection, and one Undo brings it all back.
      await page.getByRole('button', { name: 'Considered', exact: true }).click()
      await expect(row('First thought of the range')).toHaveCount(0)
      await expect(row('Third thought of the range')).toHaveCount(0)
      await expect(page.getByText('Considered 3')).toBeVisible()
      await page.getByRole('button', { name: 'Undo' }).click()
      await expect(row('First thought of the range')).toBeVisible()
      await expect(row('Second thought of the range')).toBeVisible()
      await expect(row('Third thought of the range')).toBeVisible()

      // Escape clears a selection.
      await row('Second thought of the range').click()
      await expect(page.getByRole('button', { name: 'Considered', exact: true })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('button', { name: 'Considered', exact: true })).toHaveCount(0)
    } finally {
      await deleteTasks(page, ids)
    }
  })

  test('says "all clear" once today is done', async ({ authenticatedPage: page }) => {
    const id = await createReminder(page, { title: 'The only thought left', due_at: todayAt(12) })

    try {
      await openReminders(page)
      await openAllSlots(page)
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

  test('is no longer a chip in the dashboard view toggle', async ({ authenticatedPage: page }) => {
    const toggle = page.getByRole('group', { name: 'View mode' })

    await expect(toggle.getByRole('button')).toHaveText(['Today', 'Projects', 'All'])
  })
})
