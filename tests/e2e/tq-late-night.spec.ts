/**
 * The late night, on purpose (2026-10-26): the deck flows at 01:30 in the
 * user's zone with the default 3:00 AM day start — between midnight and the
 * day start, when the OpenTask day is still YESTERDAY's date
 * (docs/TASK-MODEL.md § The OpenTask day). A spec that computed "today" from
 * the calendar failed only when CI happened to start in that window; this one
 * is always in it.
 *
 * Both clocks are pinned to the same instant: the server's through the
 * test-only POST /api/test/clock (offset-based, src/core/test-clock.ts) and
 * the browser's through `page.clock.install`. The instant is the most recent
 * 01:30 at or before real now — never ahead of it, so the cron jobs, which
 * compute on the shifted clock, never see a day the real clock hasn't reached
 * (the task rollover is stamped as of real now first, switch off, so a
 * shifted cron run finds its day already done). Every expected date here is
 * worked out from the pinned instant, never from the Playwright process's
 * own clock (`openTaskDay` reads that, so it is not used here).
 *
 * The queue user (id 2) with the task-queue switch on, like od-on-deck.spec.ts.
 * The real clock goes back in afterAll, and again in the global teardown.
 */

import path from 'path'
import Database from 'better-sqlite3'
import { DateTime } from 'luxon'
import { addDays, openTaskDayOf } from '@/lib/opentask-day'
import { DEFAULT_DAY_START } from '@/lib/anchor-times'
import { test, expect, uniqueTitle } from './fixtures'
import type { APIRequestContext, Locator, Page } from '@playwright/test'

const TZ = process.env.E2E_TZ || 'America/Chicago'
test.use({ timezoneId: TZ })

/** The most recent 01:30 in the user's zone, at or before real now. */
function lateNight(): DateTime {
  const now = DateTime.now().setZone(TZ)
  const at = now.set({ hour: 1, minute: 30, second: 0, millisecond: 0 })
  return at > now ? at.minus({ days: 1 }) : at
}

const PIN = lateNight()
/** The OpenTask day at the pin: the calendar day before it (01:30 < 3:00). */
const OT_TODAY = openTaskDayOf(PIN.toJSDate(), TZ, DEFAULT_DAY_START)

/** Pin the server's clock (null: the real one); answers the server's now. */
async function setClock(request: APIRequestContext, now: string | null): Promise<string> {
  const res = await request.post('/api/test/clock', { data: { now } })
  expect(res.ok(), await res.text()).toBeTruthy()
  return (await res.json()).data.now as string
}

async function setQueue(request: APIRequestContext, enabled: boolean) {
  const res = await request.post('/api/test/task-queue', { data: { enabled } })
  expect(res.ok()).toBeTruthy()
}

/** Stamp every user's task rollover as of REAL now (switch off: stamp only). */
async function stampRollover(request: APIRequestContext) {
  const res = await request.post('/api/test/rollover', { data: {} })
  expect(res.ok(), await res.text()).toBeTruthy()
}

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

async function stateOf(page: Page, id: number): Promise<Record<string, unknown>> {
  return (await (await page.request.get(`/api/tasks/${id}`)).json()).data
}

const deckOf = async (page: Page, id: number) => (await stateOf(page, id)).on_deck_day

async function trash(page: Page, ids: number[]) {
  if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
}

/**
 * A `days` one-off made the day before the pin (26 hours back, as an
 * explicit instant: SQLite's own 'now' is the real clock, not the pinned
 * one), so it waits in the pinned day's Days segment.
 */
async function daysTask(page: Page, title: string): Promise<number> {
  const id = await create(page, { title, horizon: 'days' })
  const db = new Database(path.join(process.cwd(), 'data', 'test-e2e.db'))
  try {
    db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(
      PIN.minus({ hours: 26 }).toUTC().toISO(),
      id,
    )
  } finally {
    db.close()
  }
  return id
}

const segRow = (scope: Page | Locator, id: number) => scope.locator(`[data-segment-task="${id}"]`)
const daysSegment = (page: Page) =>
  page.locator('[data-task-segments]').locator('[data-task-segment="days"]')
const toast = (page: Page, text: string | RegExp) =>
  page.locator('[data-sonner-toast]').filter({ hasText: text })

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ request }) => {
  await stampRollover(request)
  await setQueue(request, true)
})

test.beforeEach(async ({ page }) => {
  // The server and the browser on the same instant, before the first page.
  await setClock(page.request, PIN.toUTC().toISO())
  await page.clock.install({ time: PIN.toJSDate() })
  await signIn(page)
})

test.afterAll(async ({ request }) => {
  await setClock(request, null)
  await setQueue(request, false)
  await stampRollover(request)
})

test('the pin is inside the late night: the server reads 01:30, its day is yesterday’s date', async ({
  page,
}) => {
  const server = await setClock(page.request, PIN.toUTC().toISO())
  expect(DateTime.fromISO(server).setZone(TZ).toFormat('HH:mm')).toBe('01:30')
  const prefs = (await (await page.request.get('/api/user/preferences')).json()).data
  expect(prefs.rollover_time).toBe(DEFAULT_DAY_START)
  expect(OT_TODAY).toBe(PIN.minus({ days: 1 }).toISODate())
  expect(OT_TODAY).not.toBe(PIN.toISODate())
  const browser = await page.evaluate(() => new Date().toISOString())
  expect(DateTime.fromISO(browser).setZone(TZ).hour).toBe(1)
})

test('a horizon row: tap On deck decks it for the OpenTask today, not the calendar date', async ({
  page,
}) => {
  const ids: number[] = []
  try {
    const title = uniqueTitle('LN deck')
    const id = await daysTask(page, title)
    ids.push(id)
    await page.goto('/reminders')
    const r = segRow(daysSegment(page), id)
    await r.locator('[data-on-deck]').click()
    await expect(r).toHaveCount(0)
    await expect(toast(page, `On deck for today: “${title}”`)).toBeVisible()
    await expect.poll(() => deckOf(page, id)).toBe(OT_TODAY)
  } finally {
    await trash(page, ids)
  }
})

test('On deck tomorrow: one tap decks for the OpenTask tomorrow; the dashboard tag says "On deck tomorrow"', async ({
  page,
}) => {
  const ids: number[] = []
  try {
    const title = uniqueTitle('LN tomorrow')
    const id = await daysTask(page, title)
    ids.push(id)
    await page.goto('/reminders')
    const r = segRow(daysSegment(page), id)
    await r.locator('[data-deck-tomorrow]').click()
    await expect(r).toHaveCount(0)
    await expect(toast(page, `On deck for tomorrow: “${title}”`)).toBeVisible()
    // The OpenTask tomorrow is the pin's own calendar date.
    await expect.poll(() => deckOf(page, id)).toBe(addDays(OT_TODAY, 1))
    expect(addDays(OT_TODAY, 1)).toBe(PIN.toISODate())

    const prefs = await page.request.patch('/api/user/preferences', {
      data: { default_grouping: 'new' },
    })
    expect(prefs.ok()).toBeTruthy()
    await page.goto('/')
    await expect(page.locator(`#task-row-${id} [data-just-added-badge]`)).toHaveText(
      'On deck tomorrow',
    )
  } finally {
    await page.request.patch('/api/user/preferences', { data: { default_grouping: 'project' } })
    await trash(page, ids)
  }
})

test('a picked target: the dashboard row asks "Replaces target …", then decks for the OpenTask today', async ({
  page,
}) => {
  const ids: number[] = []
  try {
    const at = DateTime.fromISO(OT_TODAY, { zone: TZ }).plus({ days: 3 }).set({ hour: 18 })
    const id = await create(page, {
      title: uniqueTitle('LN faded'),
      target_at: at.toUTC().toISO(),
    })
    ids.push(id)
    const prefs = await page.request.patch('/api/user/preferences', {
      data: { default_grouping: 'new' },
    })
    expect(prefs.ok()).toBeTruthy()
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/')
    const r = page.locator(`#task-row-${id}`)
    await r.hover()
    const deck = r.locator('[data-on-deck]')
    await expect(deck).toHaveAttribute('data-replaces', '')
    await deck.click()
    const confirm = page.locator('[data-replace-confirm]')
    await expect(confirm).toContainText(`Replaces target ${at.toFormat('ccc')} 6 PM`)
    await confirm.locator('[data-replace-ok]').click()
    await expect.poll(() => deckOf(page, id)).toBe(OT_TODAY)
    expect((await stateOf(page, id)).target_at).toBeNull()
  } finally {
    await page.request.patch('/api/user/preferences', { data: { default_grouping: 'project' } })
    await trash(page, ids)
  }
})
