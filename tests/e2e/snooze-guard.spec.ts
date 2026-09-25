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
 *
 * WHY THE FILE IS BUILT THE WAY IT IS (it failed around 10:00 and 14:30 CDT
 * until 2026-09-25). Four separate causes, each closed here:
 *
 * 1. Fixed titles poisoned retries. Nothing was cleaned up, so a retry found
 *    the failed attempt's row as well, and every `getByText(title)` failed
 *    strict mode. Titles now come from `uniqueTitle()`, every task and the
 *    project are deleted in `finally`, and locators are scoped to the task's
 *    own row (`#task-row-<id>`).
 * 2. The snooze menu grows after it opens. It renders its fixed options first
 *    and inserts the user's time slots when `/api/time-slots` answers
 *    (`useSlotsWhenOpen`, SnoozeMenu.tsx). That moves every item below them,
 *    and after 09:00 it replaces "Tomorrow at 9:00 AM" with the Morning slot.
 *    A click resolved before the fetch landed on whatever slid into its place.
 *    `openedMenu` waits for a slot item before anything is chosen.
 * 3. The long-press was hand-timed: 500ms against the app's 400ms. Under load
 *    it registered as a tap, which instant-snoozes an overdue row. `holdUntil`
 *    holds until the menu is visible instead.
 * 4. The rows sat in Inbox, which the Projects view caps at 10 behind "Show
 *    all", so earlier specs' leftovers could push the undated row out of
 *    sight. Each test now works in a project of its own, with the view pinned
 *    to Projects (a server preference every spec shares) and put back after.
 */

import { test, expect, holdUntil, uniqueTitle } from './fixtures'
import type { Page } from '@playwright/test'
import { DateTime } from 'luxon'

/**
 * The seeded test user's timezone — recurrence and the snooze menu's
 * "Tomorrow" default are both computed in the user's own zone server-side.
 * Must track `globalSetup.ts`'s `E2E_TZ` override (default America/Chicago).
 */
const TEST_TZ = process.env.E2E_TZ || 'America/Chicago'

/** Create a task via the API using the logged-in page's cookies. */
async function createTask(page: Page, body: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data: body })
  expect(res.ok()).toBeTruthy()
  const json = await res.json()
  return json.data.id
}

/**
 * Give `run` a project of its own and the dashboard in Projects view, then put
 * everything back. Tasks are deleted before the project, because deleting a
 * project moves its tasks to Inbox rather than removing them.
 */
async function inOwnProject(
  page: Page,
  run: (projectId: number, taskIds: number[]) => Promise<void>,
): Promise<void> {
  const prefs = (await (await page.request.get('/api/user/preferences')).json()).data
  const grouping = prefs.default_grouping as string
  const res = await page.request.post('/api/projects', {
    // First in the list (`sort_order: -1`), so the rows sit near the top of
    // the viewport. The desktop snooze menu always opens BELOW its button, in
    // a fixed-position portal that never flips or scrolls, so from a row near
    // the bottom its lower items are unreachable (a product gap, listed as a
    // follow-up; found 2026-09-25 when these rows moved out of Inbox).
    data: { name: uniqueTitle('Snooze guard'), sort_order: -1 },
  })
  expect(res.ok()).toBeTruthy()
  const projectId = (await res.json()).data.id as number
  const taskIds: number[] = []
  try {
    if (grouping !== 'project') {
      const set = await page.request.patch('/api/user/preferences', {
        data: { default_grouping: 'project' },
      })
      expect(set.ok()).toBeTruthy()
    }
    await run(projectId, taskIds)
  } finally {
    for (const id of taskIds) await page.request.delete(`/api/tasks/${id}`)
    await page.request.delete(`/api/projects/${projectId}`)
    if (grouping !== 'project') {
      await page.request.patch('/api/user/preferences', { data: { default_grouping: grouping } })
    }
  }
}

/**
 * The snooze menu once its time slots are in. "Early morning" is one of the
 * default slots every user is given (`backfillTimeSlots`, src/core/db/index.ts),
 * so its item showing means the list has reached its final shape.
 */
async function openedMenu(page: Page) {
  const menu = page.getByRole('menu', { name: 'Snooze options' })
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: /^Early morning · / })).toBeVisible()
  return menu
}

test.describe('Snooze guards', () => {
  test('snoozing a task with no due date asks before adding one', async ({
    authenticatedPage: page,
  }) => {
    await inOwnProject(page, async (projectId, taskIds) => {
      const title = uniqueTitle('Guard undated task')
      const taskId = await createTask(page, { title, priority: 1, project_id: projectId })
      taskIds.push(taskId)
      await page.reload()

      const row = page.locator(`#task-row-${taskId}`)
      await expect(row).toBeVisible({ timeout: 10_000 })

      // Not overdue (no due date at all), so the snooze button opens the menu
      // rather than instant-snoozing.
      await row
        .getByRole('button', { name: new RegExp(`snooze "${title}"`, 'i') })
        .click({ force: true })

      const menu = await openedMenu(page)
      await menu.getByRole('menuitem', { name: '1 hour' }).click()

      // The guard, not a silent snooze.
      const dialog = page.getByRole('alertdialog')
      await expect(dialog).toBeVisible()
      await expect(dialog.getByText('Add a due date?')).toBeVisible()

      // Cancelling must leave the task exactly as it was — this is the whole
      // point of the prompt.
      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(dialog).toBeHidden()

      const check = await page.request.get(`/api/tasks/${taskId}`)
      const body = await check.json()
      expect(body.data.due_at ?? null).toBeNull()
    })
  })

  test('snoozing past the next occurrence offers all three choices', async ({
    authenticatedPage: page,
  }) => {
    await inOwnProject(page, async (projectId, taskIds) => {
      const title = uniqueTitle('Guard daily task')
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
      // (found 2026-09-22). Anchoring explicitly to `TEST_TZ`, the same zone
      // the app itself uses, fixes both bombs at once.
      const now = DateTime.now().setZone(TEST_TZ)
      let dueAt = now.set({ hour: 8, minute: 0, second: 0, millisecond: 0 })
      if (dueAt > now) dueAt = dueAt.minus({ days: 1 })
      const taskId = await createTask(page, {
        title,
        due_at: dueAt.toUTC().toISO(),
        rrule: 'FREQ=DAILY',
        recurrence_mode: 'from_due',
        priority: 1,
        project_id: projectId,
      })
      taskIds.push(taskId)
      await page.reload()

      const row = page.locator(`#task-row-${taskId}`)
      await expect(row).toBeVisible({ timeout: 10_000 })

      // Long-press to reach the menu: a quick tap on an overdue row would
      // instant-snooze by the default option instead. The button only shows
      // while its row is hovered.
      const snoozeBtn = row.getByRole('button', { name: new RegExp(`snooze "${title}"`, 'i') })
      await row.hover()
      await expect(snoozeBtn).toBeVisible()
      const menuShown = page.getByRole('menu', { name: 'Snooze options' })
      await holdUntil(snoozeBtn, () => expect(menuShown).toBeVisible())

      const menu = await openedMenu(page)
      // "Tomorrow at 9:00 AM", or — when a time slot already lands there — that
      // slot's "… · tomorrow 9:00 AM" in its place (see SnoozeMenu).
      await menu.getByRole('menuitem', { name: /tomorrow( at)? 9:00 AM$/i }).click()

      const dialog = page.getByRole('alertdialog')
      await expect(dialog).toBeVisible()
      await expect(dialog.getByText('Snooze past the next occurrence?')).toBeVisible()

      // All three choices present — the app warns, it does not overrule.
      await expect(dialog.getByRole('button', { name: 'Snooze anyway' })).toBeVisible()
      await expect(dialog.getByRole('button', { name: 'Snooze to next occurrence' })).toBeVisible()
      await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible()

      // Proceeding as asked works: the toast (not the top bar) offers its Undo,
      // and the server holds 9:00 in the user's own zone, past the next
      // occurrence (dueAt + 1 day) — which is what "anyway" agreed to.
      await dialog.getByRole('button', { name: 'Snooze anyway' }).click()
      await expect(dialog).toBeHidden()
      await expect(
        page.locator('[data-sonner-toast]').getByRole('button', { name: 'Undo' }),
      ).toBeVisible()
      await expect
        .poll(async () => {
          const task = (await (await page.request.get(`/api/tasks/${taskId}`)).json()).data
          const due = DateTime.fromISO(task.due_at).setZone(TEST_TZ)
          return { time: due.toFormat('HH:mm'), pastNext: due > dueAt.plus({ days: 1 }) }
        })
        .toEqual({ time: '09:00', pastNext: true })
    })
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
    await inOwnProject(page, async (projectId, taskIds) => {
      const title = uniqueTitle('Plain snooze')
      const dueAt = DateTime.now().minus({ hours: 2 })
      const taskId = await createTask(page, {
        title,
        due_at: dueAt.toUTC().toISO(),
        priority: 1,
        project_id: projectId,
      })
      taskIds.push(taskId)
      await page.reload()

      const row = page.locator(`#task-row-${taskId}`)
      await expect(row).toBeVisible({ timeout: 10_000 })

      await row
        .getByRole('button', { name: new RegExp(`snooze "${title}"`, 'i') })
        .click({ force: true })

      // The toast truncates titles to 20 characters, so match the base only;
      // the server check below is what ties the snooze to this task.
      await expect(
        page.locator('[data-sonner-toast]', { hasText: /Snoozed to .+ — "Plain snooze/ }),
      ).toBeVisible()
      await expect(page.getByRole('alertdialog')).toBeHidden()
      // It really moved: no longer overdue on the server.
      await expect
        .poll(async () => {
          const task = (await (await page.request.get(`/api/tasks/${taskId}`)).json()).data
          return new Date(task.due_at).getTime() > Date.now()
        })
        .toBe(true)
    })
  })
})
