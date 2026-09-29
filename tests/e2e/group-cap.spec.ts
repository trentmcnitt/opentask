/**
 * Grouped views cap each group, with everything one tap away (Trent,
 * 2026-09-23: "cap the number of to-dos that are shown at 10… otherwise it's
 * too hard to scroll through the projects when it's not in unified mode").
 * Today's time slots keep their own cap of 5. The flat views (New, Unified)
 * are not capped.
 *
 * This was pinned on the Projects view until it was retired (2026-09-29); All's
 * due-date groups share the same cap. The test's tasks are the only ones on
 * screen (`?project=` filter), so the group holding them holds nothing else.
 */
import { test, expect, backdateCreated, waitForPreferenceSave } from './fixtures'
import type { Page } from '@playwright/test'
import { DateTime } from 'luxon'

async function pressedView(page: Page): Promise<string | null> {
  for (const v of ['Today', 'All', 'New']) {
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

test('All shows 10 per group with the rest behind "Show all"; New shows every row', async ({
  authenticatedPage: page,
}) => {
  const tag = `Cap probe ${Date.now()}`
  const project = await page.request.post('/api/projects', { data: { name: tag } })
  expect(project.ok()).toBeTruthy()
  const projectId = (await project.json()).data.id as number
  const ids: number[] = []
  const before = await pressedView(page)
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
    await page.goto(`/?project=${projectId}`)
    await switchView(page, 'All')
    const rows = page.getByText(new RegExp(`^${tag} task`))
    await expect(rows).toHaveCount(10)
    const more = page.getByRole('button', { name: /Show all 12/ })
    await expect(more).toBeVisible()
    await more.click()
    await expect(rows).toHaveCount(12)
    await expect(page.getByRole('button', { name: 'Show less' })).toBeVisible()

    // New is one flat list: every row, no cap, no "Show all".
    await switchView(page, 'New')
    await expect(rows).toHaveCount(12)
    await expect(page.getByRole('button', { name: /Show all/ })).toHaveCount(0)
  } finally {
    if (before && before !== 'New') await switchView(page, before)
    for (const id of ids) await page.request.delete(`/api/tasks/${id}`)
    await page.request.delete(`/api/projects/${projectId}`)
  }
})
