/**
 * Track on the web (REDESIGN-V03 §5): a tracked task's row is a progress row —
 * count, bar, +1 and −1 — and reaching the target reads as "met" without
 * closing the task.
 */
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

async function createTask(page: Page, body: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data: body })
  expect(res.ok()).toBeTruthy()
  const json = await res.json()
  return json.data.id as number
}

async function deleteTasks(page: Page, ids: number[]): Promise<void> {
  for (const id of ids) await page.request.delete(`/api/tasks/${id}`)
}

test.describe('Track', () => {
  test('a tracked task shows its count, logs +1 and −1, and reads "met" at target', async ({
    authenticatedPage: page,
  }) => {
    // Undated so it sits on the Today front door regardless of the wall clock.
    const id = await createTask(page, { title: 'Eggs for the kids', progress_target: 2 })

    try {
      await page.goto('/')
      const row = page.locator(`#task-row-${id}`)
      await expect(row).toBeVisible()
      const count = row.locator('[data-track-count]')
      const plus = row.getByRole('button', { name: 'Log one more for "Eggs for the kids"' })
      const minus = row.getByRole('button', { name: 'Remove one from "Eggs for the kids"' })

      // A quota renders as a progress row, not a due line.
      await expect(count).toContainText('0 / 2')
      await expect(row.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
      await expect(minus).toBeDisabled()

      // +1 moves the count at once (optimistic) and the server agrees.
      await plus.click()
      await expect(count).toContainText('1 / 2')
      await expect
        .poll(async () => {
          const res = await page.request.get(`/api/tasks/${id}`)
          return (await res.json()).data.progress_current
        })
        .toBe(1)

      // −1 is a correction, never below zero.
      await minus.click()
      await expect(count).toContainText('0 / 2')
      await expect(minus).toBeDisabled()

      // Reaching the target is "met": a state, not an exit — the row stays.
      await plus.click()
      await plus.click()
      await expect(count).toContainText('2 / 2')
      await expect(count).toContainText('met')
      await expect(row).toBeVisible()

      // Overflow stays observable (Trent, Jul 26): the third egg shows as 3/2.
      await plus.click()
      await expect(count).toContainText('3 / 2')

      // The task itself is still open — progress is not completion.
      const res = await page.request.get(`/api/tasks/${id}`)
      const task = (await res.json()).data
      expect(task.done).toBe(false)
      expect(task.progress_current).toBe(3)
    } finally {
      await deleteTasks(page, [id])
    }
  })

  test('an ordinary task keeps its due line and has no progress controls', async ({
    authenticatedPage: page,
  }) => {
    const id = await createTask(page, { title: 'Plain one-off task' })
    try {
      await page.goto('/')
      const row = page.locator(`#task-row-${id}`)
      await expect(row).toBeVisible()
      await expect(row.locator('[data-track-progress]')).toHaveCount(0)
    } finally {
      await deleteTasks(page, [id])
    }
  })
})
