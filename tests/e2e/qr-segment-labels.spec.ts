/**
 * Labels on task-segment rows (Trent's phone review, 2026-10-22): a queue or
 * segment row shows the task's labels on its meta line with the dashboard
 * row's chips (`LabelBadges`: two, then "+N"), clipped into what the line has
 * left — never a line of their own, never wider than the screen.
 *
 * Two Days-horizon tasks with the same title, one with four long labels and
 * one with none: at 375 and 1280, on the dashboard's Tasks card and the
 * /reminders section, the labelled row shows its chips, is exactly as tall as
 * the bare one, and nothing scrolls sideways.
 *
 * The queue's own user. Isolation: unique titles and label names; tasks
 * trashed and labels deleted in `finally`.
 */
import path from 'path'
import Database from 'better-sqlite3'
import { test, expect, uniqueTitle } from './fixtures'
import type { Locator, Page } from '@playwright/test'

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill('queue@opentask.local')
  await page.getByLabel('Password').fill('testpass123')
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL('/', { timeout: 10_000 })
}

async function create(page: Page, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data })
  expect(res.ok(), `create ${JSON.stringify(data)}`).toBeTruthy()
  return (await res.json()).data.id as number
}

function madeYesterday(ids: number[]) {
  const db = new Database(path.join(process.cwd(), 'data', 'test-e2e.db'))
  try {
    const stmt = db.prepare(
      `UPDATE tasks SET created_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 day') WHERE id = ?`,
    )
    for (const id of ids) stmt.run(id)
  } finally {
    db.close()
  }
}

/** The row fits its box and the page doesn't scroll sideways. */
async function fits(page: Page, row: Locator) {
  const { rowOver, pageOver } = await row.evaluate((el) => ({
    rowOver: el.scrollWidth - el.clientWidth,
    pageOver: document.documentElement.scrollWidth - window.innerWidth,
  }))
  expect(rowOver).toBeLessThanOrEqual(0)
  expect(pageOver).toBeLessThanOrEqual(0)
}

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

test('segment rows show their labels, clipped, with no height jump or sideways scroll', async ({
  page,
}) => {
  const ids: number[] = []
  const stamp = Date.now().toString(36)
  const labels = [
    'household-errands',
    'waiting-on-someone',
    'ai-added-long',
    'weekend-projects',
  ].map((l) => `${l}-${stamp}`)
  try {
    for (const name of labels) {
      await page.request.post('/api/labels', { data: { name } })
    }
    const title = uniqueTitle('SL row')
    const labelled = await create(page, { title, horizon: 'days', labels })
    const bare = await create(page, { title, horizon: 'days' })
    ids.push(labelled, bare)
    madeYesterday(ids)

    for (const size of [
      { width: 375, height: 812 },
      { width: 1280, height: 800 },
    ]) {
      await page.setViewportSize(size)
      for (const url of ['/', '/reminders']) {
        await page.goto(url)
        const row = page.locator(`[data-segment-task="${labelled}"]`)
        const plain = page.locator(`[data-segment-task="${bare}"]`)
        await expect(row).toBeVisible()
        const chips = row.locator('[data-label-badges]')
        await expect(chips).toBeVisible()
        await expect(chips).toContainText(labels[0])
        await expect(chips).toContainText('+2')
        await expect(plain.locator('[data-label-badges]')).toHaveCount(0)
        expect((await row.boundingBox())!.height).toBe((await plain.boundingBox())!.height)
        await fits(page, row)
      }
    }
  } finally {
    if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
    for (const name of labels) await page.request.delete(`/api/labels/${encodeURIComponent(name)}`)
  }
})
