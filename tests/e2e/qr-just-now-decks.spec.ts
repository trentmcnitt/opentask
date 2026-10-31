/**
 * Just now's deck updates fold (Trent's phone review, 2026-10-22): entries
 * whose only news is a deck (`isDeckUpdate`, src/lib/just-added.ts) are ONE
 * row, "N on deck updates", at the place of the newest of them, folded by
 * default and counted toward the card's two like any entry (2026-10-30: with
 * only deck updates recent the card used to show a bare "Show N…" line and
 * nothing above it). A task created inside the window — decked or not — and
 * a targeted one are entries of their own.
 *
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

/** Made an hour ago: outside the 15-minute window, so a later deck is a deck update. */
function madeAnHourAgo(id: number) {
  const db = new Database(path.join(process.cwd(), 'data', 'test-e2e.db'))
  try {
    db.prepare(
      `UPDATE tasks SET created_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 hour') WHERE id = ?`,
    ).run(id)
  } finally {
    db.close()
  }
}

const card = (page: Page) => page.locator('[data-just-added-card]')
const entry = (page: Page, id: number) => page.locator(`[data-just-added-entry="${id}"]`)

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  await signIn(page)
  const res = await page.request.post('/api/test/task-queue', { data: { enabled: true } })
  expect(res.ok()).toBeTruthy()
})
test.afterAll(async ({ request }) => {
  await request.post('/api/test/task-queue', { data: { enabled: false } })
})

test('deck updates are one row among the two; it opens to list them', async ({ page }) => {
  const ids: number[] = []
  try {
    const old1 = await create(page, { title: uniqueTitle('JN old deck 1') })
    const old2 = await create(page, { title: uniqueTitle('JN old deck 2') })
    const fresh = await create(page, { title: uniqueTitle('JN fresh') })
    const freshDecked = await create(page, { title: uniqueTitle('JN fresh deck') })
    ids.push(old1, old2, fresh, freshDecked)
    madeAnHourAgo(old1)
    madeAnHourAgo(old2)
    const res = await page.request.post('/api/tasks/deck', {
      data: { ids: [old1, old2, freshDecked] },
    })
    expect(res.ok(), await res.text()).toBeTruthy()

    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/')
    await expect(card(page)).toBeVisible()
    // The decks are newest: their one row first, then the new-and-decked
    // task — the two. The plain new task waits behind "Show 1 more".
    const toggle = card(page).locator('[data-just-added-deck-toggle]')
    await expect(toggle).toHaveText('2 on deck updates')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(entry(page, freshDecked)).toBeVisible()
    await expect(entry(page, old1)).toHaveCount(0)
    await expect(entry(page, old2)).toHaveCount(0)
    await expect(entry(page, fresh)).toHaveCount(0)
    await card(page).locator('[data-just-added-more]').click()
    await expect(entry(page, fresh)).toBeVisible()

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(entry(page, old1)).toBeVisible()
    await expect(entry(page, old2)).toBeVisible()
    await expect(entry(page, old1)).toContainText('On deck')

    await toggle.click()
    await expect(entry(page, old1)).toHaveCount(0)
    await expect(toggle).toHaveText('2 on deck updates')
  } finally {
    if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
  }
})

test('only deck updates recent: their row shows — never a bare "Show…" with nothing above it', async ({
  page,
}) => {
  const ids: number[] = []
  try {
    for (let i = 0; i < 3; i++) {
      const id = await create(page, { title: uniqueTitle(`JN only deck ${i}`) })
      madeAnHourAgo(id)
      ids.push(id)
    }
    const res = await page.request.post('/api/tasks/deck', { data: { ids } })
    expect(res.ok(), await res.text()).toBeTruthy()

    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/')
    const toggle = card(page).locator('[data-just-added-deck-toggle]')
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveText(/^\d+ on deck updates$/)
    await expect(card(page).locator('[data-just-added-more]')).toHaveCount(0)
    await toggle.click()
    for (const id of ids) await expect(entry(page, id)).toBeVisible()
  } finally {
    if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
  }
})
