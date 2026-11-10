/**
 * NEW (2026-11-10, src/lib/new-tasks.ts): the task queue's one-off pass for
 * the day after a task is written, on /reminders.
 *
 * - made yesterday → on New today, not on Days;
 * - consider → it leaves New's waiting rows, and isn't on Days today;
 * - Not today → back tomorrow under "Carried over" (tomorrow is played by
 *   moving the stamps back a day: made two days ago, deferred yesterday);
 * - untouched past the next rollover (made two days ago) → on Days, not New;
 * - made today → not on New until tomorrow.
 *
 * Days begin at the server's day start, so "yesterday" here is a whole day
 * back from now (`backdate`), whatever the hour. Isolation: unique titles,
 * every task trashed in `finally`; stray tasks kept out of today's segments.
 */
import path from 'path'
import Database from 'better-sqlite3'
import { test, expect, hideStraySegmentTasks, uniqueTitle } from './fixtures'
import type { Page } from '@playwright/test'

async function create(page: Page, title: string): Promise<number> {
  const res = await page.request.post('/api/tasks', { data: { title, horizon: 'days' } })
  expect(res.ok()).toBeTruthy()
  return (await res.json()).data.id as number
}

async function trash(page: Page, ids: number[]) {
  if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
}

/** Move a task's stamps back by whole days, straight in the E2E database. */
function backdate(id: number, created: number, deferred?: number) {
  const db = new Database(path.join(process.cwd(), 'data', 'test-e2e.db'))
  try {
    db.prepare(
      `UPDATE tasks SET created_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?) WHERE id = ?`,
    ).run(`-${created} day`, id)
    if (deferred !== undefined) {
      db.prepare(
        `UPDATE tasks SET segment_deferred_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?) WHERE id = ?`,
      ).run(`-${deferred} day`, id)
    }
  } finally {
    db.close()
  }
}

const segment = (page: Page, kind: string) => page.locator(`[data-task-segment="${kind}"]`)
const row = (page: Page, kind: string, id: number) =>
  segment(page, kind).locator(`[data-segment-task="${id}"]`)

test.beforeEach(() => hideStraySegmentTasks())

test.describe('New', () => {
  test('made yesterday: on New, not Days; consider takes it off; made today: not yet', async ({
    authenticatedPage: page,
  }) => {
    const yesterday = await create(page, uniqueTitle('NW yesterday'))
    const today = await create(page, uniqueTitle('NW today'))
    backdate(yesterday, 1)
    try {
      await page.goto('/reminders')
      await expect(row(page, 'new', yesterday)).toBeVisible()
      await expect(segment(page, 'new').getByText('New', { exact: true }).first()).toBeVisible()
      await expect(page.locator(`[data-segment-task="${yesterday}"]`)).toHaveCount(1)
      await expect(page.locator(`[data-segment-task="${today}"]`)).toHaveCount(0)

      // Consider: off New's waiting rows, and not on Days today either.
      await row(page, 'new', yesterday)
        .getByRole('button', { name: /as considered/ })
        .click()
      await expect(row(page, 'new', yesterday)).toHaveCount(0)
      await expect(row(page, 'days', yesterday)).toHaveCount(0)
      await expect
        .poll(
          async () =>
            (await (await page.request.get(`/api/tasks/${yesterday}`)).json()).data
              .last_considered_at,
        )
        .not.toBeNull()
    } finally {
      await trash(page, [yesterday, today])
    }
  })

  test('Not today: back the next day under "Carried over", after the fresh ones', async ({
    authenticatedPage: page,
  }) => {
    const fresh = await create(page, uniqueTitle('NW fresh'))
    const carried = await create(page, uniqueTitle('NW carried'))
    try {
      // Today's Not today, on New.
      backdate(carried, 1)
      await page.goto('/reminders')
      await segment(page, 'new')
        .getByRole('button', { name: /^Not today: all/ })
        .click()
      await expect(row(page, 'new', carried)).toHaveCount(0)
      await expect
        .poll(
          async () =>
            (await (await page.request.get(`/api/tasks/${carried}`)).json()).data
              .segment_deferred_at,
        )
        .not.toBeNull()

      // The next day: made two days ago, deferred yesterday — carried; a
      // fresh one made yesterday comes first.
      backdate(carried, 2, 1)
      backdate(fresh, 1)
      await page.reload()
      const line = segment(page, 'new').locator('[data-carried-over]')
      await expect(line).toBeVisible()
      await expect(line).toContainText('Carried over')
      const order = await segment(page, 'new')
        .locator('[data-segment-task], [data-carried-over]')
        .evaluateAll((els) =>
          els.map((e) =>
            e.hasAttribute('data-carried-over') ? 'line' : e.getAttribute('data-segment-task'),
          ),
        )
      expect(order).toEqual([String(fresh), 'line', String(carried)])
    } finally {
      await trash(page, [fresh, carried])
    }
  })

  test('untouched past the next rollover: off New, into Days', async ({
    authenticatedPage: page,
  }) => {
    const id = await create(page, uniqueTitle('NW untouched'))
    backdate(id, 2)
    try {
      await page.goto('/reminders')
      await expect(row(page, 'days', id)).toBeVisible()
      await expect(row(page, 'new', id)).toHaveCount(0)
    } finally {
      await trash(page, [id])
    }
  })
})
