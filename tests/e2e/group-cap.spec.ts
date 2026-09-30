/**
 * All groups by project and caps each project group, with everything one tap
 * away (2026-09-23: "cap the number of to-dos that are shown at 10… otherwise
 * it's too hard to scroll through the projects when it's not in unified
 * mode"). Since 2026-09-30 the cap is a setting — Settings → Projects → "Tasks
 * shown per project" (`project_preview_count`, default 6). Today's time slots
 * keep their own cap of 5. The flat views (New, Unified) are not capped.
 *
 * The test's tasks are the only ones on screen (`?project=` filter), so the
 * group holding them holds nothing else.
 */
import { test, expect, backdateCreated, waitForPreferenceSave, withPreferences } from './fixtures'
import type { Page } from '@playwright/test'
import { DateTime } from 'luxon'

async function pressedView(page: Page): Promise<string | null> {
  for (const v of ['Today', 'All', 'Newest']) {
    const b = page.getByRole('button', { name: v, exact: true })
    if ((await b.getAttribute('aria-pressed')) === 'true') return v
  }
  return null
}
async function switchView(page: Page, v: string) {
  if ((await pressedView(page)) === v) return
  const saved = waitForPreferenceSave(page, 'default_grouping')
  await page.getByRole('button', { name: v, exact: true }).click()
  await saved
}

/** A project of its own holding twelve tasks; removed afterwards, view put back. */
async function withTwelveTasks(page: Page, run: (projectId: number, tag: string) => Promise<void>) {
  const tag = `Cap probe ${Date.now()}`
  const project = await page.request.post('/api/projects', { data: { name: tag } })
  expect(project.ok()).toBeTruthy()
  const projectId = (await project.json()).data.id as number
  const ids: number[] = []
  // The view is a server preference every spec shares: put it back by API.
  const before = (await (await page.request.get('/api/user/preferences')).json()).data
    .default_grouping as string
  try {
    for (let i = 0; i < 12; i++) {
      const res = await page.request.post('/api/tasks', {
        data: {
          title: `${tag} task ${String(i).padStart(2, '0')}`,
          project_id: projectId,
          due_at: DateTime.now().plus({ days: 3, minutes: i }).toUTC().toISO(),
        },
      })
      expect(res.ok()).toBeTruthy()
      ids.push((await res.json()).data.id as number)
    }
    // Not "just added": twelve fresh tasks would also each be listed in the
    // Just added card above the list (`src/lib/just-added.ts`), doubling the titles.
    backdateCreated(ids)
    await run(projectId, tag)
  } finally {
    await page.request.patch('/api/user/preferences', { data: { default_grouping: before } })
    for (const id of ids) await page.request.delete(`/api/tasks/${id}`)
    await page.request.delete(`/api/projects/${projectId}`)
  }
}

test('All shows 6 per project by default with the rest behind "Show all"; New shows every row', async ({
  authenticatedPage: page,
}) => {
  await withTwelveTasks(page, async (projectId, tag) => {
    await page.goto(`/?project=${projectId}`)
    await switchView(page, 'All')
    // The group is the project itself, headed by its name.
    await expect(page.getByRole('button', { name: `Collapse ${tag}`, exact: true })).toBeVisible()
    const rows = page.getByText(new RegExp(`^${tag} task`))
    await expect(rows).toHaveCount(6)
    const more = page.getByRole('button', { name: /Show all 12/ })
    await expect(more).toBeVisible()
    await more.click()
    await expect(rows).toHaveCount(12)
    await expect(page.getByRole('button', { name: 'Show less' })).toBeVisible()

    // New is one flat list: every row, no cap, no "Show all".
    await switchView(page, 'Newest')
    await expect(rows).toHaveCount(12)
    await expect(page.getByRole('button', { name: /Show all/ })).toHaveCount(0)
  })
})

test('the per-project cap follows the Settings choice', async ({ authenticatedPage: page }) => {
  await withTwelveTasks(page, async (projectId, tag) => {
    await withPreferences(page, { project_preview_count: 6 }, async () => {
      await page.goto('/settings')
      const select = page.getByRole('combobox', { name: 'Tasks shown per project' })
      await expect(select).toHaveValue('6')
      const saved = waitForPreferenceSave(page, 'project_preview_count')
      await select.selectOption('8')
      await saved

      await page.goto(`/?project=${projectId}`)
      await switchView(page, 'All')
      const rows = page.getByText(new RegExp(`^${tag} task`))
      await expect(rows).toHaveCount(8)
      await expect(page.getByRole('button', { name: /Show all 12/ })).toBeVisible()
    })
  })
})
