/**
 * Task queue: "Roll over now" from Settings → Advanced (src/components/
 * settings/RolloverNowRow.tsx, POST /api/rollover/run-now), and the task-segment
 * rows' hover boxes staying inside their rows (the Today button's grey block
 * poked out of the row, 2026-10-20).
 *
 * The queue's own user (`queue@opentask.local`, as tq-queue-panels.spec.ts):
 * a run strips every below-High one-off past its target, which on the shared
 * user would take targets off tasks other specs rely on. The switch is
 * turned on per test and off after the file. Clock-independent: every
 * target is days away. Isolation: unique titles, every task trashed in
 * `finally`.
 */
import path from 'path'
import Database from 'better-sqlite3'
import { DateTime } from 'luxon'
import { test, expect, uniqueTitle } from './fixtures'
import type { Locator, Page } from '@playwright/test'

const TZ = process.env.E2E_TZ || 'America/Chicago'
const DAY = 24 * 60 * 60 * 1000
const daysFromNow = (n: number) => new Date(Date.now() + n * DAY).toISOString()
const tomorrowAt = (hour: number) =>
  DateTime.now().setZone(TZ).plus({ days: 1 }).set({ hour, minute: 0 }).toUTC().toISO()!

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill('queue@opentask.local')
  await page.getByLabel('Password').fill('testpass123')
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL('/', { timeout: 10_000 })
}

async function setQueue(page: Page, enabled: boolean) {
  const res = await page.request.post('/api/test/task-queue', { data: { enabled } })
  expect(res.ok()).toBeTruthy()
}

async function create(page: Page, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data })
  expect(res.ok(), `create ${JSON.stringify(data)}`).toBeTruthy()
  return (await res.json()).data.id as number
}

async function stateOf(page: Page, id: number): Promise<Record<string, unknown>> {
  return (await (await page.request.get(`/api/tasks/${id}`)).json()).data
}

async function trash(page: Page, ids: number[]) {
  if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
}

/** Write columns the API always stamps with now, straight in the E2E database. */
function sql(statement: string, ...args: unknown[]) {
  const db = new Database(path.join(process.cwd(), 'data', 'test-e2e.db'))
  try {
    db.prepare(statement).run(...args)
  } finally {
    db.close()
  }
}

/** The RRULE weekday of an instant in the user's zone: "MO" … "SU". */
function weekdayCode(iso: string): string {
  const day = DateTime.fromISO(iso).setZone(TZ).weekday
  return ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'][day - 1]
}

/** Settings, with the Advanced fold (closed on every visit) opened. */
async function openAdvanced(page: Page) {
  await page.goto('/settings')
  const toggle = page.getByRole('button', { name: 'Advanced' })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
}

const tasks = (n: number) => `${n} ${n === 1 ? 'task' : 'tasks'}`
const segRow = (scope: Page | Locator, id: number) => scope.locator(`[data-segment-task="${id}"]`)

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  await signIn(page)
  await setQueue(page, true)
})
test.afterAll(async ({ request }) => {
  await request.post('/api/test/task-queue', { data: { enabled: false } })
})

test('Settings → Roll over now: confirm names the count, Undo puts it back, the queue shows them', async ({
  page,
}) => {
  const ids: number[] = []
  try {
    const a = await create(page, { title: uniqueTitle('RN a'), due_at: daysFromNow(-2) })
    const b = await create(page, { title: uniqueTitle('RN b'), due_at: daysFromNow(-3) })
    const later = await create(page, { title: uniqueTitle('RN later'), due_at: daysFromNow(2) })
    // A weekly task whose last occurrence was four days ago and whose next is
    // in three: it has no occurrence before the next rollover, so it waits.
    const weekly = await create(page, {
      title: uniqueTitle('RN weekly'),
      rrule: `FREQ=WEEKLY;BYDAY=${weekdayCode(daysFromNow(3))}`,
      due_at: daysFromNow(3),
    })
    sql(
      'UPDATE tasks SET due_at = ?, occurrence_at = ? WHERE id = ?',
      daysFromNow(-4),
      daysFromNow(-4),
      weekly,
    )
    ids.push(a, b, later, weekly)

    const dry = (await (await page.request.post('/api/rollover/run-now?dry_run=1')).json()).data
    expect(dry.ids.stripped).toEqual(expect.arrayContaining([a, b]))
    expect(dry.ids.stripped).not.toContain(later)
    expect(dry.ids.waiting).toEqual([weekly])
    expect(dry.rolled + dry.released).toBe(0)

    await openAdvanced(page)
    const button = page.locator('[data-rollover-now]')
    await button.click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toContainText(`Move ${tasks(dry.stripped)} to the queue?`)
    // One full sentence per line: the repeating count, then the undo line.
    await expect(dialog.locator('[data-rollover-now-detail] > span')).toHaveText([
      '1 repeating task will wait there until its next time.',
      'You can undo afterward.',
    ])
    await dialog.locator('[data-rollover-now-confirm]').click()
    const toast = page.locator('[data-sonner-toast]').filter({ hasText: /to the queue/ })
    await expect(toast).toContainText(`Moved ${tasks(dry.stripped)} to the queue`)
    await expect.poll(async () => (await stateOf(page, a)).queued_at).not.toBeNull()
    expect((await stateOf(page, a)).target_at).toBeNull()
    expect((await stateOf(page, later)).target_at).not.toBeNull()

    // Undo reverses exactly this run.
    await toast.getByRole('button', { name: 'Undo' }).click()
    await expect.poll(async () => (await stateOf(page, a)).queued_at).toBeNull()
    expect((await stateOf(page, a)).target_at).not.toBeNull()
    expect((await stateOf(page, b)).target_at).not.toBeNull()

    // Again, and the queue's "today" panel has them.
    await button.click()
    await page.getByRole('alertdialog').locator('[data-rollover-now-confirm]').click()
    await expect.poll(async () => (await stateOf(page, b)).queued_at).not.toBeNull()
    await page.goto('/reminders')
    const today = page.locator('[data-task-segments] [data-task-segment="queue_today"]')
    await expect(segRow(today, a)).toBeVisible()
    await expect(segRow(today, b)).toBeVisible()
  } finally {
    await trash(page, ids)
  }
})

test('Roll over now with nothing to move says so, without a dialog', async ({ page }) => {
  const ids: number[] = []
  try {
    // Clear anything eligible first (a real run), then ask again.
    await page.request.post('/api/rollover/run-now')
    ids.push(await create(page, { title: uniqueTitle('RN later'), due_at: daysFromNow(2) }))
    await openAdvanced(page)
    await page.locator('[data-rollover-now]').click()
    await expect(page.locator('[data-sonner-toast]')).toContainText('Nothing to roll over')
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
  } finally {
    await trash(page, ids)
  }
})

/** The hover box of each control lies inside its row, hovered. */
async function expectBoxesInside(page: Page, row: Locator) {
  await expect(row).toBeVisible()
  for (const sel of ['[data-target-today-box]', '[data-deck-tomorrow-box]', '[data-on-deck-box]']) {
    const box = row.locator(sel)
    if ((await box.count()) === 0) continue
    await box.hover()
    const inner = (await box.boundingBox())!
    const outer = (await row.boundingBox())!
    const where = `${sel} in row ${await row.getAttribute('data-segment-task')}`
    expect(inner.y, where).toBeGreaterThanOrEqual(outer.y)
    expect(inner.y + inner.height, where).toBeLessThanOrEqual(outer.y + outer.height)
    expect(inner.x, where).toBeGreaterThanOrEqual(outer.x)
    expect(inner.x + inner.width, where).toBeLessThanOrEqual(outer.x + outer.width)
  }
}

test("task-segment rows: the row buttons' hover boxes stay inside the row", async ({ page }) => {
  const ids: number[] = []
  try {
    const queued = await create(page, { title: uniqueTitle('RN q'), due_at: daysFromNow(-2) })
    const days = await create(page, { title: uniqueTitle('RN days'), horizon: 'days' })
    const upcoming = await create(page, {
      title: uniqueTitle('RN upcoming'),
      target_at: tomorrowAt(10),
      horizon: 'days',
    })
    ids.push(queued, days, upcoming)
    sql(
      `UPDATE tasks SET created_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 day') WHERE id = ?`,
      days,
    )
    sql('UPDATE tasks SET target_set_at = ? WHERE id = ?', daysFromNow(-10), upcoming)
    await page.request.post('/api/rollover/run-now')

    for (const size of [
      { width: 1280, height: 800 },
      { width: 375, height: 812 },
    ]) {
      await page.setViewportSize(size)
      await page.goto('/reminders')
      for (const id of [queued, days, upcoming]) await expectBoxesInside(page, segRow(page, id))
    }

    // The dashboard's right panel (desktop): it opens on the queue.
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/')
    const panel = page.locator('[data-tasks-panel]')
    await expect(panel).toHaveAttribute('data-tasks-page', 'tasks:queue_today')
    await expectBoxesInside(page, segRow(panel, queued))
  } finally {
    await trash(page, ids)
  }
})
