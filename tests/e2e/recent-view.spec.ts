/**
 * The dashboard's Recent view: tasks added in the last 7 days, newest first,
 * across every project, each row naming its project and when it was added.
 *
 * Isolation: every task is created here under a unique title and trashed in
 * `finally`; the `default_grouping` preference is set per test and put back
 * by `withPreferences` (every spec shares one test user).
 *
 * Time-agnostic: nothing depends on the hour. The 7-day window is exercised by
 * backdating one task's `created_at` in the E2E database directly (the API has
 * no way to create a task in the past) — the server reads SQLite in WAL mode,
 * so the next page load sees the write.
 */

import path from 'path'
import Database from 'better-sqlite3'
import {
  test,
  cmdClickRow,
  expect,
  uniqueTitle,
  waitForPreferenceSave,
  waitForPrefsLoaded,
  withPreferences,
} from './fixtures'
import type { Page } from '@playwright/test'

const DB_PATH = path.join(process.cwd(), 'data', 'test-e2e.db')
const WORK_PROJECT_ID = 3 // seeded as "Work" (scripts/seed-test.ts)

async function createTask(page: Page, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data })
  expect(res.ok(), `create ${JSON.stringify(data)}`).toBeTruthy()
  return (await res.json()).data.id as number
}

async function trash(page: Page, ids: number[]): Promise<void> {
  if (ids.length > 0) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
}

const list = (page: Page) => page.getByRole('listbox', { name: 'Task list' })
const rows = (page: Page) => list(page).getByRole('option')
const viewButton = (page: Page, name: string) =>
  page.getByRole('group', { name: 'View mode' }).getByRole('button', { name, exact: true })

test.describe('Recent view', () => {
  test('a quick add lands at the top, with its project and when it was added', async ({
    authenticatedPage: page,
  }) => {
    const ids: number[] = []
    try {
      await withPreferences(page, { default_grouping: 'recent' }, async () => {
        // An older-but-recent task in another project, created first.
        const workTitle = uniqueTitle('Recent work')
        ids.push(await createTask(page, { title: workTitle, project_id: WORK_PROJECT_ID }))

        await waitForPrefsLoaded(page, () => page.goto('/'), page.getByText(workTitle))
        await expect(viewButton(page, 'Recent')).toHaveAttribute('aria-pressed', 'true')

        // The fixed order replaces the sort control.
        await expect(page.getByText('Last 7 days · newest first')).toBeVisible()
        await expect(list(page).getByRole('button', { name: /Soonest|Latest|Newest/ })).toHaveCount(
          0,
        )

        const quickTitle = uniqueTitle('Recent quick')
        const created = page.waitForResponse(
          (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/tasks',
        )
        await page.getByRole('textbox', { name: 'Quick add task' }).fill(quickTitle)
        await page.keyboard.press('Enter')
        ids.push((await (await created).json()).data.id as number)

        // Newest first: the quick add, then the Work task.
        await expect(rows(page).nth(0)).toContainText(quickTitle)
        await expect(rows(page).nth(0)).toContainText('Inbox')
        await expect(rows(page).nth(0)).toContainText('added just now')
        await expect(rows(page).nth(1)).toContainText(workTitle)
        await expect(rows(page).nth(1)).toContainText('Work')
      })
    } finally {
      await trash(page, ids)
    }
  })

  test('shift-click selects a range in the order on screen, whatever the stored sort', async ({
    authenticatedPage: page,
  }) => {
    const ids: number[] = []
    try {
      // Due-date sort would order these B, A, C; Recent shows C, B, A.
      await withPreferences(
        page,
        { default_grouping: 'recent', default_sort: 'due_date', default_sort_reversed: false },
        async () => {
          const inDays = (d: number) => new Date(Date.now() + d * 24 * 60 * 60 * 1000).toISOString()
          const a = await createTask(page, { title: uniqueTitle('Range A'), due_at: inDays(5) })
          const b = await createTask(page, { title: uniqueTitle('Range B'), due_at: inDays(1) })
          const c = await createTask(page, { title: uniqueTitle('Range C') })
          ids.push(a, b, c)

          const row = (id: number) => page.locator(`#task-row-${id}`)
          await waitForPrefsLoaded(page, () => page.goto('/'), row(c))
          await expect(rows(page).nth(0)).toHaveAttribute('id', `task-row-${c}`)
          await expect(rows(page).nth(1)).toHaveAttribute('id', `task-row-${b}`)
          await expect(rows(page).nth(2)).toHaveAttribute('id', `task-row-${a}`)

          await cmdClickRow(row(c))
          await expect(row(c)).toHaveAttribute('aria-selected', 'true')
          await row(a).click({ modifiers: ['Shift'], position: { x: 56, y: 8 } })
          for (const id of [a, b, c]) await expect(row(id)).toHaveAttribute('aria-selected', 'true')
          await expect(page.locator('[data-selection-sheet]')).toContainText('3 selected')
          await page.keyboard.press('Escape')
        },
      )
    } finally {
      await trash(page, ids)
    }
  })

  test('shows only the last 7 days', async ({ authenticatedPage: page }) => {
    const ids: number[] = []
    try {
      await withPreferences(page, { default_grouping: 'recent' }, async () => {
        const fresh = uniqueTitle('Recent fresh')
        const old = uniqueTitle('Recent old')
        ids.push(await createTask(page, { title: fresh }))
        const oldId = await createTask(page, { title: old })
        ids.push(oldId)

        const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
        const db = new Database(DB_PATH)
        try {
          db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(eightDaysAgo, oldId)
        } finally {
          db.close()
        }

        await waitForPrefsLoaded(page, () => page.goto('/'), page.getByText(fresh))
        await expect(page.getByText(old)).toHaveCount(0)

        // Out of the view, not out of the list: it is still an open task.
        const res = await page.request.get(`/api/tasks/${oldId}`)
        expect((await res.json()).data.done).toBe(false)
      })
    } finally {
      await trash(page, ids)
    }
  })

  test('the choice persists across a reload', async ({ authenticatedPage: page }) => {
    await withPreferences(page, { default_grouping: 'project' }, async () => {
      await waitForPrefsLoaded(page, () => page.goto('/'), viewButton(page, 'Projects'))
      await expect(viewButton(page, 'Projects')).toHaveAttribute('aria-pressed', 'true')

      const saved = waitForPreferenceSave(page, 'default_grouping')
      await viewButton(page, 'Recent').click()
      await saved
      await expect(viewButton(page, 'Recent')).toHaveAttribute('aria-pressed', 'true')

      await waitForPrefsLoaded(page, () => page.reload(), viewButton(page, 'Recent'))
      await expect(viewButton(page, 'Recent')).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByText('Last 7 days · newest first')).toBeVisible()
    })
  })
})
