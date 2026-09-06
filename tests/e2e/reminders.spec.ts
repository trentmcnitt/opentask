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

/**
 * The toast's Undo, as opposed to the top bar's. Both are buttons named
 * "Undo"; the toast's lives inside sonner's toast element.
 */
function toastUndo(page: Page) {
  return page.locator('[data-sonner-toast]').getByRole('button', { name: 'Undo' })
}

/**
 * Open the surface and wait for its first fetch to resolve into a rendered state:
 * the headline or an empty-state heading. The loading skeleton has neither.
 */
async function openReminders(page: Page): Promise<void> {
  await page.goto('/reminders')
  await expect(
    page.getByRole('region', { name: 'Reminders' }).getByRole('heading').first(),
  ).toBeVisible()
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
    // The same top bar as Tasks — logo, undo, menu — with this surface's own pills.
    await expect(page.getByRole('img', { name: 'OpenTask' })).toBeVisible()
    await expect(page.getByRole('banner').getByRole('button', { name: /^Undo/ })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Reminders' })).toBeVisible()
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

      // The slot's counter counts up ("1 of 2"), never down: the slot's size
      // stays put and the considered count climbs, like the bar beside it.
      const slot = page.locator('[data-slot-group]', { hasText: 'Stand up and stretch' })
      const counter = slot.locator('span[aria-label*="considered"]')
      await expect(counter).toHaveText('0 of 2')

      await page
        .getByRole('button', { name: 'Mark "Breathe before replying" as considered' })
        .click()
      await expect(counter).toHaveText('1 of 2')

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

      // The considered one sits behind the slot's counter, checked, and its
      // circle puts it back — the direct route when a tap was a slip and the
      // undo stack has moved on.
      await slot.getByRole('button', { name: 'Show 1 considered' }).click()
      await expect(
        slot.locator('li[data-considered-id]', { hasText: 'Breathe before replying' }),
      ).toBeVisible()
      await slot.getByRole('button', { name: 'Put back "Breathe before replying"' }).click()
      await expect(consideredRow).toBeVisible()
      await expect(counter).toHaveText('0 of 2')
      await expect(page.getByText('Put back “Breathe before replying”')).toBeVisible()
      await expect(slot.getByRole('button', { name: /^(Show|Hide) \d+ considered$/ })).toHaveCount(
        0,
      )
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

      // Shift-click extends to a range, and the bar reports the count. Details
      // stays: several selected edit their schedule together.
      await row('Third thought of the range').click({ modifiers: ['Shift'] })
      await expect(row('Second thought of the range')).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByText('3 selected')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Details', exact: true })).toBeVisible()

      // One action considers the whole selection, and one Undo brings it all back.
      await page.getByRole('button', { name: 'Considered', exact: true }).click()
      await expect(row('First thought of the range')).toHaveCount(0)
      await expect(row('Third thought of the range')).toHaveCount(0)
      await expect(page.getByText('Considered 3')).toBeVisible()
      await toastUndo(page).click()
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

  test('headline, nav badge, and "Considered all so far" agree on waiting-so-far', async ({
    authenticatedPage: page,
  }) => {
    // Two reminders whose time has already passed today — in a started slot
    // (or Anytime, before the first slot), so they count "so far".
    const passed = DateTime.now().minus({ hours: 1 })
    const soFar = passed.hasSame(DateTime.now(), 'day')
      ? passed
      : DateTime.now().startOf('day').plus({ minutes: 1 })
    const ids = [
      await createReminder(page, { title: 'Earlier thought one', due_at: soFar.toUTC().toISO() }),
      await createReminder(page, { title: 'Earlier thought two', due_at: soFar.toUTC().toISO() }),
    ]

    try {
      await openReminders(page)
      const headline = page.locator('[data-reminders-headline]')
      await expect(headline).toContainText('2 waiting so far')
      // The sidebar badge (desktop nav) shows the same number.
      await expect(page.locator('[data-reminders-badge]').first()).toHaveText('2')
      // The day's bar starts empty: 0 of 2.
      await expect(headline.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')

      // The sweep asks first. Cancel changes nothing; confirm clears exactly
      // the waiting-so-far set.
      const sweep = page.getByRole('button', { name: /Mark all 2 waiting so far as considered/ })
      await sweep.click()
      const dialog = page.getByRole('alertdialog')
      await expect(dialog).toContainText('Consider all 2 waiting so far?')
      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(dialog).toHaveCount(0)
      await expect(page.locator('li[data-reminder-id]')).toHaveCount(2)

      await sweep.click()
      await dialog.getByRole('button', { name: 'Consider all 2' }).click()
      await expect(page.getByText('Considered 2')).toBeVisible()
      await expect(page.locator('li[data-reminder-id]')).toHaveCount(0)
      await expect(page.locator('[data-reminders-badge]')).toHaveCount(0)
      // The bar filled with what was done.
      await expect(headline.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2')
      await expect(headline).toContainText('All clear for today')

      // Undo restores both, and the numbers follow.
      await toastUndo(page).click()
      await expect(page.locator('li[data-reminder-id]')).toHaveCount(2)
      await expect(headline).toContainText('2 waiting so far')
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
      await expect(page.getByRole('heading', { name: 'All clear for today' })).toBeVisible()
      await expect(
        page.getByRole('heading', { name: 'Reminders are thoughts, not tasks' }),
      ).toHaveCount(0)
      // The slot is still there, finished, and opens to the considered thought
      // so a slip can be put back after the toast is gone.
      const slot = page.locator('[data-slot-group]').filter({ hasText: /1 of 1/ })
      await expect(slot).toBeVisible()
      await slot.getByRole('button', { expanded: false }).click()
      await slot.getByRole('button', { name: 'Show 1 considered' }).click()
      await slot.getByRole('button', { name: 'Put back "The only thought left"' }).click()
      await expect(page.getByRole('option', { name: 'The only thought left' })).toBeVisible()
      // Time-agnostic: before noon the thought is "waiting later" and the
      // headline reads "Caught up until…"; after noon it is "1 waiting so far".
      // Either way its slot's hairline is back to none considered.
      const slotAfter = page
        .locator('[data-slot-group]')
        .filter({ has: page.getByRole('option', { name: 'The only thought left' }) })
      await expect(slotAfter.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
      await expect(page.getByRole('heading', { name: 'All clear for today' })).toHaveCount(0)
    } finally {
      await deleteTasks(page, [id])
    }
  })

  test('is no longer a chip in the dashboard view toggle', async ({ authenticatedPage: page }) => {
    const toggle = page.getByRole('group', { name: 'View mode' })

    await expect(toggle.getByRole('button')).toHaveText(['Today', 'Projects', 'All'])
  })
})

/**
 * The Reminders page shares the Tasks page's top bar (logo, undo with its
 * count, menu) rather than a bare title. The header Undo is a second route to
 * the same undo pipeline the toast uses; this drives that route end to end.
 */
test.describe('Reminders top bar', () => {
  test('shows this surface\u2019s pills and undoes a consideration from the header', async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const id = await createReminder(page, {
      title: 'A thought for the top bar',
      due_at: todayAt(7),
    })
    try {
      await openReminders(page)
      await openAllSlots(page)
      const row = page.getByRole('option', { name: 'A thought for the top bar' })
      await expect(row).toBeVisible()
      // The banner's Undo, not the toast's: once a consideration toasts, both exist.
      const undo = page.getByRole('banner').getByRole('button', { name: /^Undo/ })
      await expect(undo).toHaveAccessibleName('Undo')

      // The waiting pill is neutral and carries the same number as the nav badge.
      const counts = page.getByRole('group', { name: 'Reminder counts' })
      await expect(counts).toBeVisible()
      const waiting = await counts.locator('span').first().innerText()
      await expect(page.locator('[data-reminders-badge]:visible').first()).toHaveText(waiting)

      await row
        .getByRole('button', { name: 'Mark "A thought for the top bar" as considered' })
        .click()
      await expect(row).toHaveCount(0)
      await expect(undo).toHaveAccessibleName('Undo (1 available)')
      // The green pill is the day's score, and the popover spells it out.
      await counts.click()
      await expect(counts.getByText(/^1\/\d+$/)).toBeVisible()
      await expect(page.getByRole('dialog')).toContainText(/1 of \d+ considered today/)
      await page.keyboard.press('Escape')

      await undo.click()
      await expect(row).toBeVisible()
      await expect(undo).toHaveAccessibleName('Undo')
    } finally {
      await deleteTasks(page, [id])
    }
  })
})

/**
 * A slot's "Considered all" is the other sweep, and it confirms the same way.
 * The dialog names the slot and the number so the scope is in the sentence.
 */
test.describe('Considered all confirms', () => {
  test('a slot sweep asks first, names the slot, and honours cancel', async ({
    authenticatedPage: page,
  }) => {
    const ids = [
      await createReminder(page, { title: 'Sweep thought one', due_at: todayAt(7) }),
      await createReminder(page, { title: 'Sweep thought two', due_at: todayAt(7) }),
    ]
    try {
      await openReminders(page)
      await openAllSlots(page)
      const sweep = page.getByRole('button', { name: /^Mark all 2 in .+ as considered$/ })
      await sweep.click()
      const dialog = page.getByRole('alertdialog')
      await expect(dialog).toContainText(/Consider all 2 in .+\?/)
      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(dialog).toHaveCount(0)
      await expect(page.locator('li[data-reminder-id]')).toHaveCount(2)

      await sweep.click()
      await dialog.getByRole('button', { name: 'Consider all 2' }).click()
      await expect(page.getByText('Considered 2')).toBeVisible()
      await expect(page.locator('li[data-reminder-id]')).toHaveCount(0)
    } finally {
      await deleteTasks(page, ids)
    }
  })
})

/**
 * A reminder can be got rid of from its own surface (Trent, 2026-09-05: the
 * bar had Considered and Details and no trash can). The bar's Trash is a soft
 * delete with one Undo, like the task bar's.
 */
test.describe('Reminders trash', () => {
  test('the bar moves a selection to Trash, and Undo brings it back', async ({
    authenticatedPage: page,
  }) => {
    const ids = [
      await createReminder(page, { title: 'A thought to let go of', due_at: todayAt(7) }),
      await createReminder(page, { title: 'A thought to keep', due_at: todayAt(7) }),
    ]
    try {
      await openReminders(page)
      await openAllSlots(page)
      const row = (title: string) => page.locator('li[data-reminder-id]', { hasText: title })
      await row('A thought to let go of').click()
      // The row and the toast are optimistic; the server's answer is what
      // the API check below depends on (on the dev server a first hit of a
      // route compiles it, which can take seconds), so wait for it by name.
      const deleted = page.waitForResponse((r) => r.url().includes('/api/tasks/bulk/delete'))
      await page.getByRole('button', { name: 'Move to Trash' }).click()
      await expect(row('A thought to let go of')).toHaveCount(0)
      await expect(row('A thought to keep')).toBeVisible()
      await expect(
        page.getByText('Moved \u201cA thought to let go of\u201d to Trash'),
      ).toBeVisible()
      await deleted
      await expect
        .poll(
          async () =>
            (await (await page.request.get(`/api/tasks/${ids[0]}`)).json()).data.deleted_at,
        )
        .not.toBeNull()

      const undone = page.waitForResponse((r) => r.url().includes('/api/undo'))
      await toastUndo(page).click()
      await expect(row('A thought to let go of')).toBeVisible()
      await undone
      await expect
        .poll(
          async () =>
            (await (await page.request.get(`/api/tasks/${ids[0]}`)).json()).data.deleted_at,
        )
        .toBeNull()
    } finally {
      await deleteTasks(page, ids)
    }
  })
})

/**
 * A reminder's own details (Trent, 2026-09-05): "there should be a reminder
 * detail page but then we also need an accompanying modal that kind of works
 * the same way… based on the same component". The bar's Details opens the
 * editor in a dialog; the same editor is the page at /tasks/:id. It speaks a
 * reminder's vocabulary — which days, which slot — not a task's.
 */
test.describe('Reminder details', () => {
  const taskField = async (page: Page, id: number, field: string) =>
    (await (await page.request.get(`/api/tasks/${id}`)).json()).data[field]

  test('Details opens the editor; moving it to another slot moves the row, and Undo moves it back', async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const id = await createReminder(page, {
      title: 'A thought for the evening',
      rrule: 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0',
      due_at: todayAt(7),
    })
    try {
      await openReminders(page)
      await openAllSlots(page)
      const row = (slot: string) =>
        page.locator(`[data-slot-group="${slot}"] li[data-reminder-id]`, {
          hasText: 'A thought for the evening',
        })
      await row('Early morning').click()
      await page.getByRole('button', { name: 'Details', exact: true }).click()

      const dialog = page.getByRole('dialog', { name: 'Reminder' })
      await expect(dialog).toBeVisible()
      // The editor reads the stored rule back in its own terms, and offers
      // nothing that treats the thought as an obligation.
      await expect(dialog.locator('[data-cadence="daily"]')).toHaveAttribute('aria-pressed', 'true')
      await expect(dialog.locator('[data-slot-label="Early morning"]')).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      await expect(dialog.getByRole('button', { name: /snooze/i })).toHaveCount(0)

      // A slot pick is staged, not saved; dismissing with it pending asks first.
      await dialog.locator('[data-slot-label="Evening"]').click()
      await expect(dialog.locator('[data-reminder-summary]')).toHaveText(/Every day · Evening/)
      await page.keyboard.press('Escape')
      const unsaved = page.getByRole('alertdialog', { name: 'Unsaved Changes' })
      await expect(unsaved).toBeVisible()
      await unsaved.getByRole('button', { name: 'Cancel' }).click()
      await expect(dialog).toBeVisible()

      await dialog.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expect.poll(() => taskField(page, id, 'anchor_time')).toBe('20:30')
      // The surface re-groups when its own refresh lands, after the save's
      // response — wait for the row to leave its old slot before opening the
      // folded ones, or the new slot may not exist yet to be opened.
      await expect(row('Early morning')).toHaveCount(0)
      await openAllSlots(page)
      await expect(row('Evening')).toBeVisible()

      await toastUndo(page).click()
      await expect.poll(() => taskField(page, id, 'anchor_time')).toBe('07:00')
      await expect(row('Evening')).toHaveCount(0)
      await openAllSlots(page)
      await expect(row('Early morning')).toBeVisible()
    } finally {
      await deleteTasks(page, [id])
    }
  })

  test('double-click opens the editor, and a row says when it is not every day', async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    // Today and the day after, so the weekly one is on today's list whatever
    // day the suite runs; the mark shows both codes.
    const CODES = ['M', 'Tu', 'W', 'Th', 'F', 'Sa', 'Su']
    const RRULE_DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
    const today = DateTime.now().setZone(TEST_TZ).weekday - 1
    const other = (today + 2) % 7
    const days = [today, other].sort((a, b) => a - b)
    const ids = [
      await createReminder(page, {
        title: 'A thought for some days',
        rrule: `FREQ=WEEKLY;BYDAY=${days.map((d) => RRULE_DAYS[d]).join(',')};BYHOUR=7;BYMINUTE=0`,
        due_at: todayAt(7),
      }),
      await createReminder(page, {
        title: 'A thought for every day',
        rrule: 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0',
        due_at: todayAt(7),
      }),
    ]
    try {
      await openReminders(page)
      await openAllSlots(page)
      const row = (title: string) => page.locator('li[data-reminder-id]', { hasText: title })
      await expect(row('A thought for some days').locator('[data-cadence-mark]')).toHaveText(
        days.map((d) => CODES[d]).join(', '),
      )
      await expect(row('A thought for every day').locator('[data-cadence-mark]')).toHaveCount(0)

      await row('A thought for every day').dblclick()
      const dialog = page.getByRole('dialog', { name: 'Reminder' })
      await expect(dialog).toBeVisible()
      await expect(dialog).toContainText('A thought for every day')
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      // The two clicks selected and then deselected the row: nothing is left
      // selected, as after the dashboard's double-click.
      await expect(page.getByRole('button', { name: 'Clear selection' })).toHaveCount(0)

      // The hazard: a row sitting where the selection bar appears. The first
      // click selects it and the bar slides over it, so the second click of
      // the double-click lands on the bar — it must open the editor, not
      // press whatever button it fell on (on dev it landed on "Considered").
      await page.setViewportSize({ width: 1280, height: 480 })
      const target = row('A thought for some days')
      await target.evaluate((el) => {
        const r = el.getBoundingClientRect()
        window.scrollTo(0, window.scrollY + r.bottom - (window.innerHeight - 40))
      })
      await target.dblclick()
      await expect(dialog).toBeVisible()
      await expect(dialog).toContainText('A thought for some days')
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expect(target).toBeVisible()
      expect(await taskField(page, ids[0], 'completion_count')).toBe(0)
    } finally {
      await deleteTasks(page, ids)
    }
  })

  test('several selected edit their schedule together, each keeping its own days', async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const RRULE_DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
    const today = DateTime.now().setZone(TEST_TZ).weekday - 1
    const weeklyDays = [today, (today + 3) % 7].sort((a, b) => a - b).map((d) => RRULE_DAYS[d])
    const ids = [
      await createReminder(page, {
        title: 'A thought every day',
        rrule: 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0',
        due_at: todayAt(7),
      }),
      await createReminder(page, {
        title: 'A thought on some days',
        rrule: `FREQ=WEEKLY;BYDAY=${weeklyDays.join(',')};BYHOUR=7;BYMINUTE=0`,
        due_at: todayAt(7),
      }),
    ]
    const taskField = async (id: number, field: string) =>
      (await (await page.request.get(`/api/tasks/${id}`)).json()).data[field]
    try {
      await openReminders(page)
      await openAllSlots(page)
      const row = (title: string) => page.locator('li[data-reminder-id]', { hasText: title })
      await row('A thought every day').click()
      await row('A thought on some days').click({ modifiers: ['ControlOrMeta'] })
      await expect(page.getByText('2 selected')).toBeVisible()
      await page.getByRole('button', { name: 'Details', exact: true }).click()

      const dialog = page.getByRole('dialog', { name: 'Reminders', exact: true })
      await expect(dialog).toBeVisible()
      await expect(dialog).toContainText('2 reminders')
      // They disagree on days and agree on the slot; the chips say exactly that.
      await expect(dialog.locator('[data-reminder-summary]')).toHaveText(
        /Different days · Early morning/,
      )
      await expect(dialog.locator('[data-cadence][aria-pressed="true"]')).toHaveCount(0)
      await expect(dialog.locator('[data-slot-label="Early morning"]')).toHaveAttribute(
        'aria-pressed',
        'true',
      )

      await dialog.locator('[data-slot-label="Evening"]').click()
      await dialog.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expect(page.getByText('Updated 2 reminders')).toBeVisible()
      await expect.poll(() => taskField(ids[0], 'anchor_time')).toBe('20:30')
      await expect.poll(() => taskField(ids[1], 'anchor_time')).toBe('20:30')
      // The weekly one is still weekly on its own days.
      expect(await taskField(ids[1], 'rrule')).toBe(
        `FREQ=WEEKLY;BYDAY=${weeklyDays.join(',')};BYHOUR=20;BYMINUTE=30`,
      )

      await toastUndo(page).click()
      await expect.poll(() => taskField(ids[0], 'anchor_time')).toBe('07:00')
      await expect.poll(() => taskField(ids[1], 'anchor_time')).toBe('07:00')
    } finally {
      await deleteTasks(page, ids)
    }
  })

  test('a thought typed into the quick add is a daily reminder in the current slot', async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    let id: number | null = null
    try {
      await openReminders(page)
      const input = page.getByRole('textbox', { name: 'Add a reminder' })
      await input.fill('A thought typed in place')
      await input.press('Enter')
      // On screen the moment the server answers, in whichever slot is current.
      const row = page.locator('li[data-reminder-id]', { hasText: 'A thought typed in place' })
      await expect(row).toBeVisible()
      await expect(page.getByText(/^Added to /)).toBeVisible()
      id = Number(await row.getAttribute('data-reminder-id'))
      const task = (await (await page.request.get(`/api/tasks/${id}`)).json()).data
      expect(task.is_reminder).toBe(true)
      expect(task.rrule).toMatch(/^FREQ=DAILY;BYHOUR=\d+;BYMINUTE=\d+$/)
      // It sits in the slot its time falls in, which is the current one.
      const slot = row.locator('xpath=ancestor::*[@data-slot-group]')
      await expect(slot).toHaveCount(1)
    } finally {
      if (id) await deleteTasks(page, [id])
    }
  })

  test('Add Reminder opens the form in place; a weekly thought lands under Not today until its day', async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const RRULE_DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
    const today = DateTime.now().setZone(TEST_TZ).weekday - 1
    const tomorrow = (today + 1) % 7
    let id: number | null = null
    try {
      await openReminders(page)
      // The sidebar's button is this surface's: it says so and stays here.
      await page.getByRole('button', { name: 'Add Reminder' }).click()
      await expect(page).toHaveURL(/\/reminders/)
      const dialog = page.getByRole('dialog', { name: 'New reminder' })
      await expect(dialog).toBeVisible()
      await dialog.getByRole('textbox', { name: 'Reminder text' }).fill('A thought for tomorrow')
      await dialog.locator('[data-cadence="weekly"]').click()
      await dialog.locator(`[data-weekday="${tomorrow}"]`).click()
      await dialog.getByRole('button', { name: 'Add reminder' }).click()
      await expect(dialog).toHaveCount(0)

      // Not on today's list; reachable under the fold, with its day as the mark.
      await expect(
        page.locator('li[data-reminder-id]', { hasText: 'A thought for tomorrow' }),
      ).toHaveCount(0)
      const fold = page.locator('[data-not-today]')
      await expect(fold).toBeVisible()
      await fold.getByRole('button', { name: /Not today/ }).click()
      const entry = fold.locator('[data-not-today-id]', { hasText: 'A thought for tomorrow' })
      await expect(entry).toBeVisible()
      id = Number(await entry.getAttribute('data-not-today-id'))
      const task = (await (await page.request.get(`/api/tasks/${id}`)).json()).data
      expect(task.rrule).toContain(`BYDAY=${RRULE_DAYS[tomorrow]}`)

      // A click opens its editor — that is what the fold is for.
      await entry.getByRole('button').click()
      await expect(page.getByRole('dialog', { name: 'Reminder', exact: true })).toContainText(
        'A thought for tomorrow',
      )
    } finally {
      if (id) await deleteTasks(page, [id])
    }
  })

  test('priority is the same five values, and reads as prominence in the slot', async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const ids = [
      await createReminder(page, {
        title: 'A quiet thought',
        rrule: 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0',
        due_at: todayAt(7),
      }),
      await createReminder(page, {
        title: 'A thought to lift',
        rrule: 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0',
        due_at: todayAt(7),
      }),
    ]
    const taskField = async (id: number, field: string) =>
      (await (await page.request.get(`/api/tasks/${id}`)).json()).data[field]
    try {
      await openReminders(page)
      await openAllSlots(page)
      const rows = page.locator('[data-slot-group="Early morning"] li[data-reminder-id]')
      await expect(rows.nth(0)).toContainText('A quiet thought')

      await rows.nth(1).dblclick()
      const dialog = page.getByRole('dialog', { name: 'Reminder', exact: true })
      await expect(dialog.locator('[data-priority-chip="0"]')).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      await dialog.locator('[data-priority-chip="3"]').click()
      await dialog.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expect.poll(() => taskField(ids[1], 'priority')).toBe(3)
      // Higher priority sits first in the slot, and nothing else about it shouts.
      await expect(rows.nth(0)).toContainText('A thought to lift')

      await toastUndo(page).click()
      await expect.poll(() => taskField(ids[1], 'priority')).toBe(0)
    } finally {
      await deleteTasks(page, ids)
    }
  })

  test('a one-time thought reads as Once and can start repeating in its own slot', async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const id = await createReminder(page, {
      title: 'A thought with a date but no rule',
      due_at: todayAt(12),
    })
    try {
      await openReminders(page)
      await openAllSlots(page)
      await page
        .locator('li[data-reminder-id]', { hasText: 'A thought with a date but no rule' })
        .click()
      await page.getByRole('button', { name: 'Details', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Reminder' })
      await expect(dialog.locator('[data-cadence="once"]')).toHaveAttribute('aria-pressed', 'true')
      // A one-time thought keeps whatever time it has; there is no slot to pick.
      await expect(dialog.locator('[data-slot-chip]')).toHaveCount(0)

      // Repeating it lights the slot its due time already falls in.
      await dialog.locator('[data-cadence="daily"]').click()
      await expect(dialog.locator('[data-slot-label="Midday"]')).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      await dialog.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expect.poll(() => taskField(page, id, 'rrule')).toBe('FREQ=DAILY;BYHOUR=12;BYMINUTE=0')
    } finally {
      await deleteTasks(page, [id])
    }
  })

  test('the page is the same editor, and "Make this a task" hands it to the task editor', async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const id = await createReminder(page, {
      title: 'A thought that became a task',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      due_at: todayAt(9),
    })
    try {
      // The slot chips arrive with the page's own time-slots fetch.
      const slots = page.waitForResponse((r) => r.url().includes('/api/time-slots'))
      await page.goto(`/tasks/${id}`)
      await expect(page.getByRole('heading', { name: 'Reminder' })).toBeVisible()
      await expect(page.locator('[data-cadence="daily"]')).toHaveAttribute('aria-pressed', 'true')
      await slots
      await expect(page.locator('[data-slot-label="Morning"]')).toHaveAttribute(
        'aria-pressed',
        'true',
      )

      await page.getByRole('button', { name: 'Make this a task' }).click()
      // Same URL, now the task editor — where project, labels and priority live.
      await expect(page.getByRole('heading', { name: 'Task Details' })).toBeVisible()
      await expect.poll(() => taskField(page, id, 'is_reminder')).toBe(false)

      await toastUndo(page).click()
      await expect(page.getByRole('heading', { name: 'Reminder' })).toBeVisible()
      await expect.poll(() => taskField(page, id, 'is_reminder')).toBe(true)
    } finally {
      await deleteTasks(page, [id])
    }
  })

  test('the dialog opens the full page, whose back arrow returns to Reminders', async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const id = await createReminder(page, { title: 'A thought worth opening', due_at: todayAt(7) })
    try {
      await openReminders(page)
      await openAllSlots(page)
      await page.locator('li[data-reminder-id]', { hasText: 'A thought worth opening' }).click()
      await page.getByRole('button', { name: 'Details', exact: true }).click()
      await page
        .getByRole('dialog', { name: 'Reminder' })
        .getByRole('button', { name: 'Open full page' })
        .click()
      await page.waitForURL(`/tasks/${id}`)
      await expect(page.getByRole('heading', { name: 'Reminder' })).toBeVisible()
      await page.getByRole('button', { name: 'Back' }).click()
      await page.waitForURL('/reminders')
    } finally {
      await deleteTasks(page, [id])
    }
  })

  test('on a phone the editor is a bottom sheet', async ({ authenticatedPage: page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    const id = await createReminder(page, {
      title: 'A thought on the phone',
      rrule: 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0',
      due_at: todayAt(7),
    })
    try {
      await openReminders(page)
      await openAllSlots(page)
      await page.locator('li[data-reminder-id]', { hasText: 'A thought on the phone' }).click()
      await page.getByRole('button', { name: 'Details', exact: true }).click()
      const sheet = page.getByRole('dialog', { name: 'Reminder' })
      await expect(sheet).toBeVisible()
      await expect(sheet.locator('[data-slot-chip]')).toHaveCount(5)
      await sheet.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(sheet).toHaveCount(0)
    } finally {
      await deleteTasks(page, [id])
    }
  })

  test('a reminder the AI gave up on says so, and Retry hands it back', async ({
    authenticatedPage: page,
  }) => {
    // The quick add puts a thought in a slot with a plausible daily rule before
    // the AI has read a word, so a failure would look exactly like success
    // unless the row says otherwise. `ai-failed` is a system label the API
    // accepts on create, which is how the state is staged without an AI.
    const id = await createReminder(page, {
      title: 'AI failed probe',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      labels: ['ai-failed'],
    })
    try {
      await openReminders(page)
      await openAllSlots(page)
      const row = page.locator(`[data-reminder-id="${id}"]`)
      await expect(row).toHaveAttribute('data-ai-state', 'failed')
      await expect(row.locator('[data-ai-failed]')).toContainText('didn\u2019t read this')

      const reprocess = page.waitForResponse((r) => r.url().includes(`/api/tasks/${id}/reprocess`))
      await row.getByRole('button', { name: 'Retry' }).click()
      expect((await reprocess).ok()).toBeTruthy()
      // AI is off under test, so the swapped label stays and the row keeps
      // its processing pulse rather than resolving.
      await expect(row).toHaveAttribute('data-ai-state', 'processing')
    } finally {
      await deleteTasks(page, [id])
    }
  })
})
