/**
 * Grouped views cap each group, with everything one tap away (Trent,
 * 2026-09-23: "cap the number of to-dos that are shown at 10… otherwise it's
 * too hard to scroll through the projects when it's not in unified mode").
 * Today's time slots keep their own cap of 5.
 */
import { test, expect, waitForPreferenceSave } from './fixtures'
import type { Page } from '@playwright/test'
import { DateTime } from 'luxon'

async function pressedView(page: Page): Promise<string | null> {
  for (const v of ['Today', 'Projects', 'All']) {
    const b = page.getByRole('button', { name: v, exact: true })
    if ((await b.getAttribute('aria-pressed')) === 'true') return v
  }
  return null
}
async function switchView(page: Page, v: string) {
  const saved = waitForPreferenceSave(page, 'default_grouping')
  await page.getByRole('button', { name: v, exact: true }).click()
  await saved
}

test('the Projects view shows 10 per project, with the rest behind "Show all"', async ({
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
    await page.goto('/')
    await switchView(page, 'Projects')
    const section = page.locator('section', {
      has: page.getByText(tag.toUpperCase(), { exact: false }),
    })
    // The heading is a tag in the project's color (2026-09-23): a new
    // project is always given a color, so this one has a tag.
    await expect(page.locator('[data-project-heading-tag]', { hasText: tag })).toBeVisible()
    const rows = page.getByText(new RegExp(`^${tag} task`))
    await expect(rows).toHaveCount(10)
    const more = page.getByRole('button', { name: /Show all 12/ })
    await expect(more).toBeVisible()
    await more.click()
    await expect(rows).toHaveCount(12)
    await expect(
      section
        .getByRole('button', { name: 'Show less' })
        .or(page.getByRole('button', { name: 'Show less' })),
    ).toBeVisible()
  } finally {
    if (before && before !== 'Projects') await switchView(page, before)
    for (const id of ids) await page.request.delete(`/api/tasks/${id}`)
    await page.request.delete(`/api/projects/${projectId}`)
  }
})
