/**
 * NEW AS A HEADING (2026-11-17, src/lib/new-tasks.ts), on /reminders and the
 * dashboard's Task queue card:
 *
 * - a task made yesterday with no horizon is in Days under the "New" heading,
 *   before the segment's settled rows, with Grow where On deck tomorrow sits;
 * - a consider takes it off the waiting rows and counts one; Days brings it
 *   back the next day still New (played by moving its stamps back a day), and
 *   a second consider ends that;
 * - Grow's tap: Weeks, "Grown to Weeks", the row leaves, Undo brings it back
 *   New; Grow's hold: every other horizon;
 * - a settled row has no Grow and sits under no heading.
 *
 * Days begin at the server's day start, so "yesterday" is a whole day back
 * from now (`age`), whatever the hour. Isolation: unique titles, every task
 * trashed in `finally`; stray tasks kept out of today's segments.
 */
import path from 'path'
import Database from 'better-sqlite3'
import { test, expect, hideStraySegmentTasks, holdUntil, uniqueTitle } from './fixtures'
import type { Page } from '@playwright/test'

async function create(page: Page, title: string, horizon?: string): Promise<number> {
  const res = await page.request.post('/api/tasks', {
    data: { title, ...(horizon ? { horizon } : {}) },
  })
  expect(res.ok()).toBeTruthy()
  return (await res.json()).data.id as number
}

async function trash(page: Page, ids: number[]) {
  if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
}

const stateOf = async (page: Page, id: number) =>
  (await (await page.request.get(`/api/tasks/${id}`)).json()).data as Record<string, unknown>

/**
 * Move a task's day back by whole days, straight in the E2E database: its
 * creation and, when it has one, its considered stamp. `settled`: New has
 * ended for it.
 */
function age(id: number, days: number, settled = false) {
  const db = new Database(path.join(process.cwd(), 'data', 'test-e2e.db'))
  try {
    db.prepare(
      `UPDATE tasks SET
         created_at = strftime('%Y-%m-%dT%H:%M:%SZ', created_at, ?),
         last_considered_at = strftime('%Y-%m-%dT%H:%M:%SZ', last_considered_at, ?),
         new_ended_at = CASE WHEN ? THEN created_at ELSE new_ended_at END
       WHERE id = ?`,
    ).run(`-${days} day`, `-${days} day`, settled ? 1 : 0, id)
  } finally {
    db.close()
  }
}

const segment = (page: Page, kind: string) => page.locator(`[data-task-segment="${kind}"]`)
const row = (page: Page, kind: string, id: number) =>
  segment(page, kind).locator(`[data-segment-task="${id}"]`)
const heading = (page: Page, kind: string) => segment(page, kind).locator('[data-new-heading]')

test.beforeEach(() => hideStraySegmentTasks())

test.describe('New as a heading', () => {
  test('an unset task made yesterday is under New in Days, first, with Grow; a settled row is not', async ({
    authenticatedPage: page,
  }) => {
    const fresh = await create(page, uniqueTitle('NH fresh'))
    const settled = await create(page, uniqueTitle('NH settled'), 'days')
    age(fresh, 1)
    age(settled, 3, true)
    try {
      await page.goto('/reminders')
      const days = segment(page, 'days')
      await expect(row(page, 'days', fresh)).toBeVisible()
      await expect(heading(page, 'days')).toHaveCount(1)
      await expect(heading(page, 'days')).toContainText('New')
      await expect(heading(page, 'days')).toContainText('1')
      // The heading, the New row, then the settled one.
      const order = await days
        .locator('[data-new-heading], [data-segment-task]')
        .evaluateAll((els) => els.map((el) => el.getAttribute('data-segment-task') ?? 'heading'))
      expect(order.slice(0, 3)).toEqual(['heading', String(fresh), String(settled)])
      // Grow on the New row only, with no word; the settled row keeps its own controls.
      const grow = row(page, 'days', fresh).locator('[data-grow]')
      await expect(grow).toHaveAttribute('data-grow-to', 'weeks')
      await expect(grow.locator('[data-grow-word]')).toHaveCount(0)
      await expect(row(page, 'days', settled).locator('[data-grow]')).toHaveCount(0)
      // No New page.
      await expect(segment(page, 'new')).toHaveCount(0)

      // The dashboard's card draws the same heading.
      await page.goto('/')
      const card = page.locator('[data-tasks-panel]')
      await card.locator('[data-slot-segment="tasks:days"]').click()
      await expect(card.locator('[data-new-heading]')).toContainText('New')
      await expect(card.locator(`[data-segment-task="${fresh}"] [data-grow]`)).toBeVisible()
    } finally {
      await trash(page, [fresh, settled])
    }
  })

  test('New until considered twice: one consider, back the next day still New; a second ends it', async ({
    authenticatedPage: page,
  }) => {
    const task = await create(page, uniqueTitle('NH twice'))
    age(task, 1)
    try {
      await page.goto('/reminders')
      await row(page, 'days', task)
        .getByRole('button', { name: /as considered/ })
        .click()
      await expect.poll(async () => (await stateOf(page, task)).consider_count).toBe(1)

      // The next day: Days comes round again, the row still under New.
      age(task, 1)
      await page.reload()
      await expect(row(page, 'days', task)).toBeVisible()
      await expect(heading(page, 'days')).toHaveCount(1)
      await row(page, 'days', task)
        .getByRole('button', { name: /as considered/ })
        .click()
      await expect.poll(async () => (await stateOf(page, task)).consider_count).toBe(2)

      // The day after: an ordinary row, no heading, no Grow.
      age(task, 1)
      await page.reload()
      await expect(row(page, 'days', task)).toBeVisible()
      await expect(heading(page, 'days')).toHaveCount(0)
      await expect(row(page, 'days', task).locator('[data-grow]')).toHaveCount(0)
    } finally {
      await trash(page, [task])
    }
  })

  test('Grow: a tap grows one step, the row leaves with "Grown to Weeks", Undo brings it back New; a hold offers the others', async ({
    authenticatedPage: page,
  }) => {
    const tapped = await create(page, uniqueTitle('NH tap'))
    const held = await create(page, uniqueTitle('NH hold'))
    age(tapped, 1)
    age(held, 1)
    try {
      await page.goto('/reminders')
      await row(page, 'days', tapped).locator('[data-grow]').click()
      await expect(page.getByText(/^Grown to Weeks/)).toBeVisible()
      await expect(
        segment(page, 'days').locator(
          `[data-segment-task="${tapped}"][data-segment-state="waiting"]`,
        ),
      ).toHaveCount(0)
      await expect
        .poll(async () => {
          const t = await stateOf(page, tapped)
          return [t.horizon, t.consider_count, t.new_ended_at !== null]
        })
        .toEqual(['weeks', 1, true])

      await page.getByRole('button', { name: 'Undo', exact: true }).first().click()
      await expect
        .poll(async () => {
          const t = await stateOf(page, tapped)
          return [t.horizon, t.consider_count, t.new_ended_at]
        })
        .toEqual([null, 0, null])
      await expect(row(page, 'days', tapped).locator('[data-grow]')).toBeVisible()

      // The hold: the horizon menu; Months takes it straight there.
      const grow = row(page, 'days', held).locator('[data-grow]')
      const menu = page.getByRole('menu')
      await holdUntil(grow, async () => {
        await expect(menu).toBeVisible()
      })
      await menu.getByRole('menuitemradio', { name: /Months/ }).click()
      await expect(page.getByText(/^Grown to Months/)).toBeVisible()
      await expect.poll(async () => (await stateOf(page, held)).horizon).toBe('months')
    } finally {
      await trash(page, [tapped, held])
    }
  })
})
