/**
 * A task segment's "N of M" is fixed for the day (Trent's phone review,
 * 2026-10-22; the day roster, src/core/tasks/segment-roster.ts): On deck,
 * Today and done take a row out of its segment, and used to shrink M ("29 of
 * 44" → "29 of 43"). Now each RAISES N and M stays; the row is listed behind
 * the count with the considered ones, saying how it left, with no put-back.
 *
 * The dashboard's Tasks card and the /reminders section, at 375 and 1280.
 * The queue's own user (decks need the task-queue switch, on for this file,
 * off after it). Isolation: unique titles, every task trashed in `finally`.
 */
import path from 'path'
import Database from 'better-sqlite3'
import { test, expect, uniqueTitle } from './fixtures'
import type { Page } from '@playwright/test'

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

/** Made yesterday: a Days segment lists a task from the day after it was made. */
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

const segRow = (page: Page, id: number) => page.locator(`[data-segment-task="${id}"]`)
const toast = (page: Page, text: string | RegExp) =>
  page.locator('[data-sonner-toast]').filter({ hasText: text })

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  await signIn(page)
  const res = await page.request.post('/api/test/task-queue', { data: { enabled: true } })
  expect(res.ok()).toBeTruthy()
})
test.afterAll(async ({ request }) => {
  await request.post('/api/test/task-queue', { data: { enabled: false } })
})

for (const size of [
  { width: 375, height: 812 },
  { width: 1280, height: 800 },
]) {
  test(`dashboard Tasks card at ${size.width}: deck, Today and done raise N; M stays`, async ({
    page,
  }) => {
    const ids: number[] = []
    try {
      for (const name of ['deck', 'today', 'done', 'stay']) {
        ids.push(await create(page, { title: uniqueTitle(`SC ${name}`), horizon: 'days' }))
      }
      madeYesterday(ids)
      const [decked, targeted, done, stays] = ids
      await page.setViewportSize(size)
      await page.goto('/')
      const card = page.locator('[data-tasks-panel]')
      await expect(card).toHaveAttribute('data-tasks-page', 'tasks:days')
      await expect(card.getByLabel('0 of 4 considered', { exact: true })).toBeVisible()

      await segRow(page, decked).locator('[data-deck-tomorrow]').click()
      await expect(toast(page, /On deck for tomorrow/)).toBeVisible()
      const count = card.locator('[data-considered-toggle]')
      await expect(count).toHaveText(/^1 of 4/)

      await segRow(page, targeted).locator('[data-target-today]').click()
      await expect(count).toHaveText(/^2 of 4/)
      await segRow(page, done).getByRole('button', { name: /^Done/ }).click()
      await expect(count).toHaveText(/^3 of 4/)
      // Still 3 of 4 once the server answers (the refresh is the truth).
      await page.reload()
      await expect(card.locator('[data-considered-toggle]')).toHaveText(/^3 of 4/)
      await expect(segRow(page, stays)).toBeVisible()

      // Behind the count: the three, saying how they left, no put-back.
      await card.locator('[data-considered-toggle]').click()
      for (const [id, word] of [
        [decked, 'on deck'],
        [targeted, 'targeted'],
        [done, 'done'],
      ] as const) {
        const row = card.locator(`[data-considered-task-id="${id}"]`)
        await expect(row).toContainText(`· ${word}`)
        await expect(row.getByRole('button', { name: /^Put back/ })).toHaveCount(0)
      }
    } finally {
      if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
    }
  })
}

test('/reminders section: a deck raises N, M stays, the row behind "Show N considered"', async ({
  page,
}) => {
  const ids: number[] = []
  try {
    for (const name of ['deck', 'stay']) {
      ids.push(await create(page, { title: uniqueTitle(`SC2 ${name}`), horizon: 'days' }))
    }
    madeYesterday(ids)
    const [decked] = ids
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/reminders')
    const section = page.locator('[data-task-segments] [data-task-segment="days"]')
    await expect(section).toContainText('0 of 2')
    await segRow(page, decked).locator('[data-deck-tomorrow]').click()
    await expect(section).toContainText('1 of 2')
    const toggle = section.locator('[data-segment-considered-toggle]')
    await expect(toggle).toHaveText('Show 1 considered')
    await toggle.click()
    await expect(section.locator(`[data-considered-task-id="${decked}"]`)).toContainText(
      '· on deck',
    )
  } finally {
    if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
  }
})
