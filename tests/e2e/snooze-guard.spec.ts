/**
 * Snooze guard prompts (REDESIGN-V03 §4.3)
 *
 * The behavioral suite (sg-snooze-guard.test.ts) pins *when* a guard fires.
 * These tests cover what only a browser can show: that the dialog actually
 * appears on the real single-task snooze surfaces, that "snooze anyway" stays a
 * real first-class choice, and — most importantly — that cancelling leaves the
 * task alone.
 *
 * Tasks are created through the API rather than added to the shared seed so
 * these tests can't perturb the counts other specs assert on.
 */

import { test, expect } from './fixtures'
import { DateTime } from 'luxon'

/**
 * The seeded test user's timezone — recurrence and the snooze menu's
 * "Tomorrow" default are both computed in the user's own zone server-side.
 * Must track `globalSetup.ts`'s `E2E_TZ` override (default America/Chicago).
 */
const TEST_TZ = process.env.E2E_TZ || 'America/Chicago'

/** Create a task via the API using the logged-in page's cookies. */
async function createTask(
  page: import('@playwright/test').Page,
  body: Record<string, unknown>,
): Promise<number> {
  const res = await page.request.post('/api/tasks', { data: body })
  expect(res.ok()).toBeTruthy()
  const json = await res.json()
  return json.data.id
}

test.describe('Snooze guards', () => {
  test('snoozing a task with no due date asks before adding one', async ({
    authenticatedPage: page,
  }) => {
    const title = 'Guard undated task'
    const taskId = await createTask(page, { title, priority: 1 })
    await page.reload()

    await expect(page.getByText(title)).toBeVisible({ timeout: 10_000 })

    // Not overdue (no due date at all), so the snooze button opens the menu
    // rather than instant-snoozing.
    await page.getByRole('button', { name: new RegExp(`snooze "${title}"`, 'i') }).click({
      force: true,
    })

    const menu = page.getByRole('menu', { name: 'Snooze options' })
    await expect(menu).toBeVisible({ timeout: 3000 })
    await menu.getByRole('menuitem', { name: '1 hour' }).click()

    // The guard, not a silent snooze.
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible({ timeout: 3000 })
    await expect(dialog.getByText('Add a due date?')).toBeVisible()

    // Cancelling must leave the task exactly as it was — this is the whole
    // point of the prompt.
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden({ timeout: 3000 })

    const check = await page.request.get(`/api/tasks/${taskId}`)
    const body = await check.json()
    expect(body.data.due_at ?? null).toBeNull()
  })

  test('snoozing past the next occurrence offers all three choices', async ({
    authenticatedPage: page,
  }) => {
    const title = 'Guard daily task'
    // Due at the most recent 08:00 *in the seeded user's own zone* that has
    // ALREADY PASSED, so the row is overdue and the menu offers "Tomorrow",
    // which lands past the next occurrence. Anchoring on "08:00 today" was a
    // latent time bomb: run the suite before 08:00 and that timestamp is in
    // the future, the row is not overdue, and the menu this test needs never
    // appears. CI runs in UTC, so it failed every night between 00:00 and
    // 08:00 UTC while passing all day locally (found 2026-09-06, reproduced
    // with TZ=UTC on clean main).
    //
    // A SECOND, independent time bomb lived here even after that fix: the
    // overdue check above was zone-agnostic (any zone keeps `dueAt <= now`
    // self-consistently), but recurrence and the snooze menu's "Tomorrow"
    // default are computed by the app in the seeded user's own zone
    // (`TEST_TZ`), not the test process's. Anchoring "08:00" to the test
    // PROCESS's zone (`DateTime.now()` with no `.setZone`) meant the
    // recurring task's schedule, as the app understood it, silently drifted
    // away from 08:00 — and whenever it drifted to 09:00 or later in
    // `TEST_TZ`, "Tomorrow" (fixed at 9:00 AM in the user's own zone) no
    // longer landed past the next occurrence, and the guard this test exists
    // to prove never fired. Reproduced with `TZ=Etc/GMT+7` on clean main
    // (found 2026-09-22, independent of the E2E_TZ/midnight sweep this file
    // is otherwise untouched by). Anchoring explicitly to `TEST_TZ`, the same
    // zone the app itself uses, fixes both bombs at once.
    let dueAt = DateTime.now()
      .setZone(TEST_TZ)
      .set({ hour: 8, minute: 0, second: 0, millisecond: 0 })
    if (dueAt > DateTime.now().setZone(TEST_TZ)) dueAt = dueAt.minus({ days: 1 })
    await createTask(page, {
      title,
      due_at: dueAt.toUTC().toISO(),
      rrule: 'FREQ=DAILY',
      recurrence_mode: 'from_due',
      priority: 1,
    })
    await page.reload()

    await expect(page.getByText(title)).toBeVisible({ timeout: 10_000 })

    // Long-press to reach the menu (a quick tap on an overdue row would
    // instant-snooze by the default option instead).
    const snoozeBtn = page.getByRole('button', { name: new RegExp(`snooze "${title}"`, 'i') })
    await page.getByText(title).hover()
    await expect(snoozeBtn).toBeVisible({ timeout: 3000 })
    const box = await snoozeBtn.boundingBox()
    if (!box) throw new Error('Snooze button bounding box not found')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.waitForTimeout(500)
    await page.mouse.up()

    const menu = page.getByRole('menu', { name: 'Snooze options' })
    await expect(menu).toBeVisible({ timeout: 3000 })
    // "Tomorrow at 9:00 AM", or — when a time slot already lands there — that
    // slot's "… · tomorrow 9:00 AM" in its place (see SnoozeMenu).
    await menu.getByRole('menuitem', { name: /tomorrow( at)? 9:00 AM$/i }).click()

    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible({ timeout: 3000 })
    await expect(dialog.getByText('Snooze past the next occurrence?')).toBeVisible()

    // All three choices present — the app warns, it does not overrule.
    await expect(dialog.getByRole('button', { name: 'Snooze anyway' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Snooze to next occurrence' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible()

    // Proceeding as asked works.
    await dialog.getByRole('button', { name: 'Snooze anyway' }).click()
    await expect(dialog).toBeHidden({ timeout: 3000 })
    await expect(page.getByText('Undo')).toBeVisible({ timeout: 5000 })
  })

  test('an ordinary snooze is not interrupted by any prompt', async ({
    authenticatedPage: page,
  }) => {
    // Regression guard: the common case must stay frictionless. An overdue
    // one-off with a due date and no recurrence meets neither §4.3 condition.
    //
    // This creates its own task rather than reusing a seeded one. Specs share a
    // database and Playwright orders files alphabetically, so snoozing a seeded
    // task here would clear its overdue state before snooze.spec.ts runs and
    // break that suite from a distance.
    const title = 'Plain snooze'
    const dueAt = DateTime.now().minus({ hours: 2 })
    await createTask(page, { title, due_at: dueAt.toUTC().toISO(), priority: 1 })
    await page.reload()

    await expect(page.getByText(title)).toBeVisible({ timeout: 10_000 })

    await page
      .getByRole('button', { name: new RegExp(`snooze "${title}"`, 'i') })
      .click({ force: true })

    await expect(page.getByText(new RegExp(`Snoozed to .+ — "${title}"`))).toBeVisible({
      timeout: 5000,
    })
    await expect(page.getByRole('alertdialog')).toBeHidden()
  })
})
