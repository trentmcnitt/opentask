/**
 * Cmd/Ctrl+Shift+A selects the FOCUSED row's group — only that group.
 *
 * Two handlers see the key: the task list's own (`useKeyboardNavigation`,
 * which picks the focused row's group) and the dashboard's document-level one
 * (`useDashboardKeyboard`, which picks the first group when nothing in the
 * list has focus). The list's runs first and calls preventDefault, and the
 * document one now skips a prevented event. Before that it was kept from
 * adding the first group on top only by timing (the list's selection change
 * re-registers the document listener mid-dispatch, so it did not fire) — this
 * pins the outcome whichever mechanism provides it.
 *
 * Isolation: the two tasks are created here under a unique search token and
 * trashed in `finally`; the search leaves only them on the page. The All view
 * (`default_grouping = 'time'`) is set with `withPreferences`, which puts the
 * old value back.
 *
 * Time-agnostic: one task is due three hours ago (Overdue at any hour) and
 * the other has no due date ("No Due Date"), so they are always in two
 * different groups, Overdue first.
 */
import { test, expect, uniqueTitle, waitForPrefsLoaded, withPreferences } from './fixtures'
import type { Page } from '@playwright/test'

async function createTask(page: Page, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data })
  expect(res.ok(), `create ${JSON.stringify(data)}`).toBeTruthy()
  return (await res.json()).data.id as number
}

const row = (page: Page, id: number) => page.locator(`#task-row-${id}`)

test('Cmd+Shift+A with focus in the second group selects only that group', async ({
  authenticatedPage: page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const token = uniqueTitle('Qwvgroup').replace(' ', '')
  const overdue = await createTask(page, {
    title: `${token} overdue`,
    due_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    priority: 1,
  })
  const undated = await createTask(page, { title: `${token} undated`, priority: 1 })
  try {
    await withPreferences(page, { default_grouping: 'time' }, async () => {
      const search = page.getByRole('textbox', { name: 'Search tasks' })
      await waitForPrefsLoaded(page, () => page.goto('/'), search)
      await search.fill(token)
      await expect(page.getByText(`2 results for “${token}”`)).toBeVisible()
      await expect(row(page, overdue)).toBeVisible()
      await expect(row(page, undated)).toBeVisible()

      // A click in the row's padding (clear of the Done circle and the title
      // link) gives it keyboard focus without selecting it.
      await row(page, undated).click({ position: { x: 4, y: 4 } })
      await expect(row(page, undated)).toBeFocused()
      await expect(row(page, undated)).not.toHaveAttribute('aria-selected', 'true')

      // Control, not ControlOrMeta: the app picks Cmd or Ctrl from the user
      // agent (`isMacPlatform`), and the Desktop Chrome device reports
      // Windows on every host — Meta on a Mac runner would be ignored.
      await page.keyboard.press('Control+Shift+A')

      await expect(row(page, undated)).toHaveAttribute('aria-selected', 'true')
      await expect(row(page, overdue)).not.toHaveAttribute('aria-selected', 'true')
      await expect(page.locator('[role="option"][aria-selected="true"]')).toHaveCount(1)
    })
  } finally {
    await page.request.post('/api/tasks/bulk/delete', { data: { ids: [overdue, undated] } })
  }
})
