/**
 * A deck's tag on a dashboard row names its day (Trent's phone review,
 * 2026-10-22; `deckTagLabel`, src/lib/just-added.ts): a row decked for a
 * later day read just "On deck", as if it were today's. Now: "On deck
 * tomorrow", "On deck Nov 15" (month and day, the dashboard date chips'
 * format); today's deck keeps the plain "On deck".
 *
 * The queue's own user (decks need the task-queue switch, on for this file,
 * off after it), the flat Newest view so every row is on screen. Isolation:
 * unique titles, every task trashed in `finally`.
 */
import path from 'path'
import Database from 'better-sqlite3'
import { DateTime } from 'luxon'
import { test, expect, openTaskDay, uniqueTitle, withPreferences } from './fixtures'
import type { Page } from '@playwright/test'

const TZ = process.env.E2E_TZ || 'America/Chicago'

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

async function deck(page: Page, ids: number[], day: string) {
  const res = await page.request.post('/api/tasks/deck', { data: { ids, day } })
  expect(res.ok(), await res.text()).toBeTruthy()
  expect((await res.json()).data.decked).toBe(ids.length)
}

/** Made an hour ago, so the tag the row wears is the deck's, not "New". */
function madeAnHourAgo(ids: number[]) {
  const db = new Database(path.join(process.cwd(), 'data', 'test-e2e.db'))
  try {
    const stmt = db.prepare(
      `UPDATE tasks SET created_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 hour') WHERE id = ?`,
    )
    for (const id of ids) stmt.run(id)
  } finally {
    db.close()
  }
}

const badge = (page: Page, id: number) => page.locator(`#task-row-${id} [data-just-added-badge]`)

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  await signIn(page)
  const res = await page.request.post('/api/test/task-queue', { data: { enabled: true } })
  expect(res.ok()).toBeTruthy()
})
test.afterAll(async ({ request }) => {
  await request.post('/api/test/task-queue', { data: { enabled: false } })
})

test('a future deck\'s tag says the day: "On deck tomorrow", "On deck Nov 15"', async ({
  page,
}) => {
  const ids: number[] = []
  try {
    const today = await create(page, { title: uniqueTitle('DB today') })
    const tomorrow = await create(page, { title: uniqueTitle('DB tomorrow') })
    const later = await create(page, { title: uniqueTitle('DB later') })
    ids.push(today, tomorrow, later)
    madeAnHourAgo(ids)
    await deck(page, [today], await openTaskDay(page, 0))
    await deck(page, [tomorrow], await openTaskDay(page, 1))
    await deck(page, [later], await openTaskDay(page, 5))
    const laterWords = DateTime.fromISO(await openTaskDay(page, 5), { zone: TZ }).toFormat('LLL d')

    await withPreferences(page, { default_grouping: 'new' }, async () => {
      for (const size of [
        { width: 375, height: 812 },
        { width: 1280, height: 800 },
      ]) {
        await page.setViewportSize(size)
        await page.goto('/')
        await expect(badge(page, tomorrow)).toHaveText('On deck tomorrow')
        await expect(badge(page, later)).toHaveText(`On deck ${laterWords}`)
        // Today's deck keeps the plain tag.
        await expect(badge(page, today)).toHaveText('On deck')
      }
    })
  } finally {
    if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
  }
})
