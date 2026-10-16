/**
 * The task editor's "Originally: …" line (2026-10-16): the raw text a task was
 * created from (`original_title`, usually dictated) shows under the title when
 * it differs from the current title, and is absent when it is the same.
 *
 * `original_title` is set from the title on create and never changed by PATCH,
 * so creating a task and then renaming it gives one whose original differs.
 */
import { test, expect, uniqueTitle } from './fixtures'
import type { Page } from '@playwright/test'

async function createTask(page: Page, title: string): Promise<number> {
  const res = await page.request.post('/api/tasks', { data: { title } })
  expect(res.ok()).toBeTruthy()
  return (await res.json()).data.id as number
}

test.describe('Task detail: the original dictated text', () => {
  test('a renamed task shows "Originally:" with its first title; an untouched one does not', async ({
    authenticatedPage: page,
  }) => {
    const raw = uniqueTitle('um so call the dentist tomorrow about the cleaning')
    const renamed = uniqueTitle('Call the dentist')
    const plain = uniqueTitle('Water the plants')
    const renamedId = await createTask(page, raw)
    const plainId = await createTask(page, plain)
    try {
      const patch = await page.request.patch(`/api/tasks/${renamedId}`, {
        data: { title: renamed },
      })
      expect(patch.ok()).toBeTruthy()

      await page.goto(`/tasks/${renamedId}`)
      const line = page.locator('[data-quick-panel-original-title]')
      await expect(line).toHaveText(`Originally: ${raw}`)
      // Read-only: clicking it opens no editor and stages nothing.
      await line.click()
      await expect(page.locator('textarea')).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()

      await page.goto(`/tasks/${plainId}`)
      await expect(page.getByText(plain).first()).toBeVisible()
      await expect(page.locator('[data-quick-panel-original-title]')).toHaveCount(0)
    } finally {
      await page.request.delete(`/api/tasks/${renamedId}`)
      await page.request.delete(`/api/tasks/${plainId}`)
    }
  })
})
