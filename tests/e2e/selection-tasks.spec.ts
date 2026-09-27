/**
 * Dashboard task multi-select, checked against the SERVER (testing pass WP6).
 *
 * The floating bar (`SelectionActionSheet`) acts on the selection through the
 * bulk endpoints: Done → bulk/done, the trash button → bulk/delete, More → the
 * QuickActionPanel, whose date and priority go out as bulk/snooze and
 * bulk/edit (`saveQuickPanelChanges`). The API suite already pins what those
 * endpoints do; what only a browser shows is that the bar sends exactly the
 * rows that were selected, and that Undo in the page puts the server back.
 * So every test reads the tasks back over the API rather than trusting rows
 * leaving the screen — a row can leave optimistically while the write fails.
 *
 * Isolation:
 * - Every task is created here, with a unique title, and trashed in `finally`,
 *   so a retry never finds a previous attempt's rows.
 * - The dashboard runs in the Unified view (`withPreferences`): one flat list,
 *   uncapped and not cut at the end of today, so a created row is on the page
 *   whatever the earlier specs left the grouping on. The page is loaded with
 *   `waitForPrefsLoaded`, so the view has switched before the first click.
 *
 * Time-agnostic: the tasks are due three hours ago — overdue at any hour,
 * including just after midnight (yesterday's 22:00 is still overdue), and an
 * all-overdue selection is the one a "+1 day" applies to without the
 * "Confirm date change" dialog.
 */

import {
  test,
  expect,
  cmdClickRow,
  uniqueTitle,
  waitForPrefsLoaded,
  withPreferences,
} from './fixtures'
import type { Page } from '@playwright/test'

interface TaskState {
  id: number
  done: boolean
  deleted_at: string | null
  due_at: string | null
  original_due_at: string | null
  priority: number
  progress_current: number | null
}

async function createTask(page: Page, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data })
  expect(res.ok(), `create ${JSON.stringify(data)}`).toBeTruthy()
  return (await res.json()).data.id as number
}

/** Two overdue Low tasks, created under unique titles. */
async function createPair(page: Page, base: string): Promise<{ ids: number[]; titles: string[] }> {
  const due = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
  const titles = [uniqueTitle(`${base} A`), uniqueTitle(`${base} B`)]
  const ids: number[] = []
  for (const title of titles) ids.push(await createTask(page, { title, due_at: due, priority: 1 }))
  return { ids, titles }
}

async function stateOf(page: Page, id: number): Promise<TaskState> {
  const res = await page.request.get(`/api/tasks/${id}`)
  expect(res.ok()).toBeTruthy()
  return (await res.json()).data as TaskState
}

/** Soft-delete whatever a test made. Already-trashed rows are fine to hit again. */
async function trash(page: Page, ids: number[]): Promise<void> {
  if (ids.length > 0) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
}

const row = (page: Page, id: number) => page.locator(`#task-row-${id}`)
const bar = (page: Page) => page.locator('[data-selection-sheet]')
const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b)

/** Open the dashboard in the Unified view, with `first` rendered and prefs applied. */
async function openDashboard(page: Page, first: number): Promise<void> {
  await waitForPrefsLoaded(page, () => page.goto('/'), row(page, first))
}

/** Cmd/Ctrl-click each row: the first enters selection mode, the rest add to it. */
async function select(page: Page, ids: number[]): Promise<void> {
  for (const id of ids) {
    await cmdClickRow(row(page, id))
    await expect(row(page, id)).toHaveAttribute('aria-selected', 'true')
  }
  await expect(bar(page)).toContainText(`${ids.length} selected`)
}

function isPost(path: string) {
  return (r: { url(): string; request(): { method(): string } }) =>
    r.request().method() === 'POST' && new URL(r.url()).pathname === path
}

/** The Undo in the toast whose text matches — not the header's, which is also "Undo". */
function toastUndo(page: Page, text: string | RegExp) {
  return page.locator('[data-sonner-toast]', { hasText: text }).getByRole('button', {
    name: 'Undo',
  })
}

const unified = { default_grouping: 'unified' }

test.describe('Dashboard multi-select — the bar, checked against the server', () => {
  test('Done completes exactly the selected tasks, and Undo reopens them', async ({
    authenticatedPage: page,
  }) => {
    const { ids } = await createPair(page, 'Sel done')
    // A third task, unselected: the control that Done is not "everything".
    const bystander = await createTask(page, { title: uniqueTitle('Sel done C'), priority: 1 })
    try {
      await withPreferences(page, unified, async () => {
        await openDashboard(page, ids[0])
        await select(page, ids)

        const sent = page.waitForResponse(isPost('/api/tasks/bulk/done'))
        await bar(page).getByRole('button', { name: 'Done', exact: true }).click()
        const res = await sent
        expect(res.ok()).toBeTruthy()
        expect(sorted(res.request().postDataJSON().ids)).toEqual(sorted(ids))
        for (const id of ids) expect((await stateOf(page, id)).done).toBe(true)
        expect((await stateOf(page, bystander)).done).toBe(false)
        await expect(bar(page)).toHaveCount(0)

        const undone = page.waitForResponse(isPost('/api/undo'))
        await toastUndo(page, '2 tasks completed').click()
        expect((await undone).ok()).toBeTruthy()
        for (const id of ids) expect((await stateOf(page, id)).done).toBe(false)
        for (const id of ids) await expect(row(page, id)).toBeVisible()
      })
    } finally {
      await trash(page, [...ids, bystander])
    }
  })

  test('the trash button soft-deletes exactly the selection, and Undo restores it', async ({
    authenticatedPage: page,
  }) => {
    const { ids } = await createPair(page, 'Sel trash')
    const bystander = await createTask(page, { title: uniqueTitle('Sel trash C'), priority: 1 })
    try {
      await withPreferences(page, unified, async () => {
        await openDashboard(page, ids[0])
        await select(page, ids)

        const sent = page.waitForResponse(isPost('/api/tasks/bulk/delete'))
        await bar(page).getByRole('button', { name: 'Delete 2 tasks' }).click()
        const res = await sent
        expect(res.ok()).toBeTruthy()
        expect(sorted(res.request().postDataJSON().ids)).toEqual(sorted(ids))
        // Soft: the rows still exist, with `deleted_at` set.
        for (const id of ids) expect((await stateOf(page, id)).deleted_at).not.toBeNull()
        expect((await stateOf(page, bystander)).deleted_at).toBeNull()
        for (const id of ids) await expect(row(page, id)).toHaveCount(0)

        const undone = page.waitForResponse(isPost('/api/undo'))
        await toastUndo(page, '2 tasks deleted').click()
        expect((await undone).ok()).toBeTruthy()
        for (const id of ids) expect((await stateOf(page, id)).deleted_at).toBeNull()
        for (const id of ids) await expect(row(page, id)).toBeVisible()
      })
    } finally {
      await trash(page, [...ids, bystander])
    }
  })

  /**
   * More → the QuickActionPanel for the selection: "+1 day" and a priority,
   * one Save. Pins what reaches the server: both tasks moved by exactly the
   * delta the request carried (relative to each one's own due time), both at
   * the new priority, and the "snoozed from" origin left where it was.
   */
  test('Details: a date and a priority change land on every selected task', async ({
    authenticatedPage: page,
  }) => {
    const { ids } = await createPair(page, 'Sel details')
    try {
      await withPreferences(page, unified, async () => {
        const before = await Promise.all(ids.map((id) => stateOf(page, id)))
        await openDashboard(page, ids[0])
        await select(page, ids)
        const saved = await saveDateAndPriority(page, ids)

        const delta = saved.snooze.delta_minutes as number
        expect(delta).toBe(24 * 60)
        for (const [i, id] of ids.entries()) {
          const after = await stateOf(page, id)
          expect(after.priority).toBe(2)
          expect(Date.parse(after.due_at!)).toBe(Date.parse(before[i].due_at!) + delta * 60_000)
          expect(after.original_due_at).toBe(before[i].original_due_at)
        }
      })
    } finally {
      await trash(page, ids)
    }
  })

  /**
   * One save, one Undo. Trent's call (testing-pass plan, decision 4): a
   * multi-select save with a date AND a priority is one change to him, so one
   * Undo must put back both.
   *
   * FIXME(WP3): on main today `saveBulkPanelChanges` sends bulk/snooze and
   * bulk/edit together (`Promise.all`), which logs TWO undo entries in a racy
   * order — one Undo restores either the date or the priority, never both.
   * WP3 (client logic behind multi-select) makes the save one undo entry;
   * drop the `.fixme` once it merges.
   */
  test.fixme('Details: one Undo puts back both the date and the priority', async ({
    authenticatedPage: page,
  }) => {
    const { ids } = await createPair(page, 'Sel undo')
    try {
      await withPreferences(page, unified, async () => {
        const before = await Promise.all(ids.map((id) => stateOf(page, id)))
        await openDashboard(page, ids[0])
        await select(page, ids)
        await saveDateAndPriority(page, ids)

        const undone = page.waitForResponse(isPost('/api/undo'))
        await toastUndo(page, /./).first().click()
        expect((await undone).ok()).toBeTruthy()
        for (const [i, id] of ids.entries()) {
          const after = await stateOf(page, id)
          expect(after.due_at).toBe(before[i].due_at)
          expect(after.priority).toBe(before[i].priority)
        }
      })
    } finally {
      await trash(page, ids)
    }
  })
})

test.describe('Dashboard multi-select — only tasks', () => {
  /**
   * The dashboard list hides reminders and quotas (`visibleTasks`), and the
   * selection is resolved against what is rendered — so no route into the
   * bar (Select All included) can carry one to a bulk endpoint.
   *
   * A search makes this testable without touching anyone else's rows: the
   * server matches all four items (the positive control below — without it,
   * a server that stopped returning reminders would pass this vacuously),
   * the page renders only the two tasks, and Select All + Done must send
   * exactly those two.
   */
  test('a reminder or a quota never enters the selection, even with Select All', async ({
    authenticatedPage: page,
  }) => {
    const token = uniqueTitle('Zyxleak').replace(' ', '')
    const tasks = [
      await createTask(page, { title: `${token} task one`, priority: 1 }),
      await createTask(page, { title: `${token} task two`, priority: 1 }),
    ]
    const reminder = await createTask(page, {
      title: `${token} reminder`,
      is_reminder: true,
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    })
    const quota = await createTask(page, {
      title: `${token} quota`,
      rrule: 'FREQ=WEEKLY',
      progress_target: 3,
      is_tracked: true,
    })
    const everything = [...tasks, reminder, quota]
    try {
      await withPreferences(page, unified, async () => {
        await openDashboard(page, tasks[0])
        const reminderBefore = await stateOf(page, reminder)
        const quotaBefore = await stateOf(page, quota)

        const searched = page.waitForResponse(
          (r) => r.url().includes('/api/tasks?search=') && r.url().includes(token),
        )
        await page.getByRole('textbox', { name: 'Search tasks' }).fill(token)
        const hits = ((await (await searched).json()).data.tasks as { id: number }[]).map(
          (t) => t.id,
        )
        expect(sorted(hits)).toEqual(sorted(everything))
        await expect(page.getByText(`2 results for “${token}”`)).toBeVisible()
        await expect(row(page, reminder)).toHaveCount(0)
        await expect(row(page, quota)).toHaveCount(0)

        await page.getByRole('button', { name: 'Select All', exact: true }).click()
        await expect(bar(page)).toContainText('2 selected')
        const sent = page.waitForResponse(isPost('/api/tasks/bulk/done'))
        await bar(page).getByRole('button', { name: 'Done', exact: true }).click()
        const res = await sent
        expect(res.ok()).toBeTruthy()
        expect(sorted(res.request().postDataJSON().ids)).toEqual(sorted(tasks))

        for (const id of tasks) expect((await stateOf(page, id)).done).toBe(true)
        const reminderAfter = await stateOf(page, reminder)
        const quotaAfter = await stateOf(page, quota)
        expect(reminderAfter.due_at).toBe(reminderBefore.due_at)
        expect(reminderAfter.done).toBe(false)
        expect(quotaAfter.progress_current).toBe(quotaBefore.progress_current)
        expect(quotaAfter.done).toBe(false)
      })
    } finally {
      await trash(page, everything)
    }
  })
})

/**
 * More → "+1 day" → priority Medium → Save, for a selection of overdue Low
 * tasks. Returns the two request bodies once both responses are in: the date
 * goes out as bulk/snooze, the priority as bulk/edit, at the same time.
 */
async function saveDateAndPriority(
  page: Page,
  ids: number[],
): Promise<{ snooze: Record<string, unknown>; edit: Record<string, unknown> }> {
  await bar(page).getByRole('button', { name: 'More', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: `${ids.length} tasks selected` })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '+1 day', exact: true }).click()
  // The priority picker's trigger reads the selection's shared priority.
  await dialog.getByRole('button', { name: 'Low', exact: true }).click()
  await page
    .locator('[data-radix-popper-content-wrapper]')
    .getByRole('button', { name: 'Medium', exact: true })
    .click()

  const snoozed = page.waitForResponse(isPost('/api/tasks/bulk/snooze'))
  const edited = page.waitForResponse(isPost('/api/tasks/bulk/edit'))
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  const [snoozeRes, editRes] = await Promise.all([snoozed, edited])
  expect(snoozeRes.ok()).toBeTruthy()
  expect(editRes.ok()).toBeTruthy()
  const snooze = snoozeRes.request().postDataJSON()
  const edit = editRes.request().postDataJSON()
  // Explicit picks: the P3/P4 sweep filter must not drop any of them.
  expect(sorted(snooze.ids)).toEqual(sorted(ids))
  expect(sorted(snooze.include_task_ids)).toEqual(sorted(ids))
  expect(sorted(edit.ids)).toEqual(sorted(ids))
  expect(edit.changes).toEqual({ priority: 2 })
  await expect(dialog).toHaveCount(0)
  return { snooze, edit }
}
