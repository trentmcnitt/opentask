/**
 * The dashboard's view switch is Today · All · New (Trent, 2026-09-29).
 *
 * New is every open task in one flat list, newest-added first, each row naming
 * its project. Its order is fixed — the saved sort is ignored there and the
 * sort dropdown is replaced by a plain "Newest added" caption — and the choice
 * persists like the other views (`default_grouping = 'new'`). The Projects view
 * is gone; a user whose stored preference is still 'project' lands on All.
 *
 * Isolation: tasks and projects are created per test and deleted in `finally`;
 * preferences are put back by `withPreferences` (every spec shares one user).
 */
import path from 'path'
import Database from 'better-sqlite3'
import {
  test,
  expect,
  backdateCreated,
  uniqueTitle,
  waitForPreferenceSave,
  waitForPrefsLoaded,
  withPreferences,
  TEST_EMAIL,
} from './fixtures'
import type { Page } from '@playwright/test'

const DAY = 24 * 60 * 60 * 1000
const inDays = (d: number) => new Date(Date.now() + d * DAY).toISOString()

async function post(page: Page, url: string, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post(url, { data })
  expect(res.ok(), `POST ${url} ${JSON.stringify(data)}`).toBeTruthy()
  return (await res.json()).data.id as number
}

const toggle = (page: Page) => page.getByRole('group', { name: 'View mode' })
const viewButton = (page: Page, name: string) =>
  toggle(page).getByRole('button', { name, exact: true })
const taskList = (page: Page) => page.getByRole('listbox', { name: 'Task list' })
const realRow = (page: Page, id: number) => page.locator(`#task-row-${id}`)

/** The list's rows, as ids in on-screen order. */
function rowOrder(page: Page): Promise<string[]> {
  return taskList(page)
    .locator('[role="option"]')
    .evaluateAll((els) => els.map((el) => el.id.replace('task-row-', '')))
}

async function getPrefs(page: Page): Promise<Record<string, unknown>> {
  return (await (await page.request.get('/api/user/preferences')).json()).data
}

test.describe('New view', () => {
  test('the switch reads All · Today · New — no Projects', async ({ authenticatedPage: page }) => {
    await expect(toggle(page).getByRole('button')).toHaveText(['All', 'Today', 'New'])
  })

  test('is one flat list, newest added first whatever the saved sort, with project names', async ({
    authenticatedPage: page,
  }) => {
    const ids: number[] = []
    let projectId: number | null = null
    try {
      const projectName = uniqueTitle('New view project')
      projectId = await post(page, '/api/projects', { name: projectName })
      // Older but due sooner: the saved due-date sort would put it FIRST.
      const older = await post(page, '/api/tasks', {
        title: uniqueTitle('New view older'),
        project_id: projectId,
        due_at: inDays(1),
      })
      backdateCreated([older])
      // Newer but due later: New puts it first anyway.
      const newer = await post(page, '/api/tasks', {
        title: uniqueTitle('New view newer'),
        project_id: projectId,
        due_at: inDays(20),
      })
      ids.push(older, newer)

      await withPreferences(
        page,
        { default_grouping: 'new', default_sort: 'due_date', default_sort_reversed: false },
        async () => {
          await waitForPrefsLoaded(page, () => page.goto('/'), realRow(page, older))
          await expect(viewButton(page, 'New')).toHaveAttribute('aria-pressed', 'true')

          const order = await rowOrder(page)
          expect(order.indexOf(String(newer))).toBeGreaterThanOrEqual(0)
          expect(order.indexOf(String(newer))).toBeLessThan(order.indexOf(String(older)))

          // Flat: no group headers to fold.
          await expect(taskList(page).getByRole('button', { name: /^Collapse / })).toHaveCount(0)
          // Each row names its project.
          await expect(realRow(page, older)).toContainText(projectName)
          await expect(realRow(page, newer)).toContainText(projectName)
          // The sort dropdown is replaced by a caption; no "Unified" button.
          await expect(page.locator('[data-new-order]')).toHaveText('Newest added')
          await expect(page.getByRole('button', { name: 'Soonest' })).toHaveCount(0)
          await expect(page.getByRole('button', { name: 'Unified' })).toHaveCount(0)

          // The saved sort is untouched, and All still uses it.
          expect((await getPrefs(page)).default_sort).toBe('due_date')
          const saved = waitForPreferenceSave(page, 'default_grouping')
          await viewButton(page, 'All').click()
          await saved
          await expect(page.getByRole('button', { name: 'Soonest' })).toBeVisible()
        },
      )
    } finally {
      if (ids.length > 0) {
        await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
      }
      if (projectId !== null) await page.request.delete(`/api/projects/${projectId}`)
    }
  })

  test('the switch remembers New across a reload', async ({ authenticatedPage: page }) => {
    await withPreferences(page, { default_grouping: 'time' }, async () => {
      await waitForPrefsLoaded(page, () => page.goto('/'), toggle(page))
      await expect(viewButton(page, 'All')).toHaveAttribute('aria-pressed', 'true')
      const saved = waitForPreferenceSave(page, 'default_grouping')
      await viewButton(page, 'New').click()
      await saved
      expect((await getPrefs(page)).default_grouping).toBe('new')

      await waitForPrefsLoaded(page, () => page.reload(), toggle(page))
      await expect(viewButton(page, 'New')).toHaveAttribute('aria-pressed', 'true')
    })
  })

  test("a stored 'project' preference lands on All", async ({ authenticatedPage: page }) => {
    // Through the API it can't be stored any more (a PATCH of 'project' is
    // saved as 'time'), so write it the way a pre-2026-09-29 database holds
    // it. `withPreferences` puts the real value back afterwards.
    await withPreferences(page, { default_grouping: 'slot' }, async () => {
      const db = new Database(path.join(process.cwd(), 'data', 'test-e2e.db'))
      try {
        db.prepare(`UPDATE users SET default_grouping = 'project' WHERE email = ?`).run(TEST_EMAIL)
      } finally {
        db.close()
      }
      expect((await getPrefs(page)).default_grouping).toBe('time')
      await waitForPrefsLoaded(page, () => page.reload(), toggle(page))
      await expect(viewButton(page, 'All')).toHaveAttribute('aria-pressed', 'true')
      await expect(viewButton(page, 'Today')).toHaveAttribute('aria-pressed', 'false')
    })
  })
})
