/**
 * THE ON DECK ROWS' BUTTONS AND A SELECTED ROW (Trent's Mac, 2026-10-31):
 * - Order, left to right, on Today's On deck rows and the task queue's rows
 *   alike: deck TOMORROW · deck TODAY · CLOCK (right to left reads soonest to
 *   latest).
 * - An On deck row with a mouse: deck-today and the clock at all times;
 *   deck-tomorrow fades in on hover in its own slot. Nothing moves.
 * - Its clock targets today at once: no "Replaces On deck today".
 * - A selected list row wears the queue's pick blue, its ring inset — drawn
 *   whole (it was a grey outline the next row clipped).
 *
 * Its own user (`queue@opentask.local`, the switch on), Today (compact On
 * deck rows), 1600 wide (two columns). Unique titles, trashed in `finally`.
 */
import path from 'path'
import Database from 'better-sqlite3'
import { test, expect, openTaskDay, uniqueTitle } from './fixtures'
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
  expect(res.ok(), JSON.stringify(data)).toBeTruthy()
  return (await res.json()).data.id as number
}

async function trash(page: Page, ids: number[]) {
  if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
}

/** A `days` one-off made yesterday: it waits in today's Days segment (the queue card). */
async function daysTask(page: Page, title: string): Promise<number> {
  const id = await create(page, { title: uniqueTitle(title), horizon: 'days' })
  const db = new Database(path.join(process.cwd(), 'data', 'test-e2e.db'))
  try {
    db.prepare(
      `UPDATE tasks SET created_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 day') WHERE id = ?`,
    ).run(id)
  } finally {
    db.close()
  }
  return id
}

const opacity = (l: Locator) => l.evaluate((el) => Number(getComputedStyle(el).opacity))
const x = async (l: Locator) => (await l.boundingBox())!.x

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1600, height: 900 } })

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('opentask_task_rows', 'lean')
    window.localStorage.setItem('opentask_dashboard_mode', 'today')
  })
  await signIn(page)
  const res = await page.request.post('/api/test/task-queue', { data: { enabled: true } })
  expect(res.ok()).toBeTruthy()
})
test.afterAll(async ({ request }) => {
  await request.post('/api/test/task-queue', { data: { enabled: false } })
})

test('an On deck row: deck tomorrow · deck · clock; the deck and clock at rest, nothing moves on hover; the clock asks nothing', async ({
  page,
}) => {
  const ids = [
    await create(page, { title: uniqueTitle('OB decked one') }),
    await create(page, { title: uniqueTitle('OB decked two') }),
  ]
  try {
    const today = await openTaskDay(page, 0)
    expect((await page.request.post('/api/tasks/deck', { data: { ids, day: today } })).ok()).toBe(
      true,
    )
    await page.goto('/')
    await page.mouse.move(0, 0)
    const section = page.locator('section[data-mode-section="on-deck"]')
    const r = section.locator(`#task-row-${ids[0]}`)
    await expect(r).toBeVisible()
    const tomorrow = r.locator('[data-deck-tomorrow]')
    const deck = r.locator('[data-on-deck]')
    const clock = r.locator('[data-target-today]')
    await expect.poll(() => opacity(deck)).toBe(1)
    await expect.poll(() => opacity(clock)).toBe(1)
    await expect.poll(() => opacity(tomorrow)).toBe(0)
    const rest = [await x(tomorrow), await x(deck), await x(clock)]
    expect(rest[0]).toBeLessThan(rest[1])
    expect(rest[1]).toBeLessThan(rest[2])
    await section.screenshot({ path: '.tmp/screens/od-rows-rest-1600.png', animations: 'disabled' })
    await r.hover()
    await expect.poll(() => opacity(tomorrow)).toBe(1)
    expect([await x(tomorrow), await x(deck), await x(clock)]).toEqual(rest)
    await section.screenshot({
      path: '.tmp/screens/od-rows-hover-1600.png',
      animations: 'disabled',
    })

    // The clock: targeted today at once — no "Replaces On deck today".
    await clock.click()
    await expect(page.locator('[data-replace-confirm]')).toHaveCount(0)
    await expect
      .poll(async () => (await (await page.request.get(`/api/tasks/${ids[0]}`)).json()).data)
      .toMatchObject({ on_deck_day: null })
  } finally {
    await trash(page, ids)
  }
})

test('a task queue row: deck tomorrow · deck · clock', async ({ page }) => {
  const id = await daysTask(page, 'OB queue row')
  try {
    await page.goto('/?tasks=days')
    const r = page.locator(`[data-tasks-panel] [data-segment-task="${id}"]`)
    await expect(r).toBeVisible()
    const order = [
      await x(r.locator('[data-deck-tomorrow]')),
      await x(r.locator('[data-on-deck]')),
      await x(r.locator('[data-target-today]')),
    ]
    expect(order[0]).toBeLessThan(order[1])
    expect(order[1]).toBeLessThan(order[2])
    await r.screenshot({ path: '.tmp/screens/queue-row-order-1600.png', animations: 'disabled' })
  } finally {
    await trash(page, [id])
  }
})

test('a selected list row: the pick blue, its ring inset and drawn whole', async ({ page }) => {
  const ids = [
    await create(page, { title: uniqueTitle('OB selected') }),
    await create(page, { title: uniqueTitle('OB below') }),
  ]
  try {
    const today = await openTaskDay(page, 0)
    expect((await page.request.post('/api/tasks/deck', { data: { ids, day: today } })).ok()).toBe(
      true,
    )
    await page.goto('/')
    const r = page.locator(`section[data-mode-section="on-deck"] #task-row-${ids[0]}`)
    await r.getByText(/^OB selected/).click({ modifiers: ['ControlOrMeta'] })
    await expect(r).toHaveAttribute('aria-selected', 'true')
    const shadow = await r.evaluate((el) => getComputedStyle(el).boxShadow)
    // The theme's blue-500 ring, 2px and inset (drawn inside the row's own
    // box), resolved in the page so the colour's serialisation can't differ.
    const blue = await page.evaluate(() => {
      const probe = document.createElement('span')
      probe.style.color = 'var(--color-blue-500)'
      document.body.append(probe)
      const color = getComputedStyle(probe).color
      probe.remove()
      return color
    })
    expect(shadow).toContain(`${blue} 0px 0px 0px 2px inset`)
    await r.screenshot({ path: '.tmp/screens/selected-row-1600.png', animations: 'disabled' })
  } finally {
    await trash(page, ids)
  }
})
