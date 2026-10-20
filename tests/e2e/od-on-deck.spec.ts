/**
 * On deck on the web (D2, 2026-10-20; spec rules 7–9, docs/TASK-MODEL.md
 * § On deck): the On deck button's tap and hold on the task-segment rows
 * (horizon panels, Queued, Upcoming), the dashboard rows and the Quick panel;
 * the filled state and the tap that takes today's deck off (A10); Remove in
 * the hold menu; Now's On deck section; re-deck to Tomorrow from Queued; an
 * Upcoming deck row and Today on it; the A1 refusal toast; Undo; the hover
 * box inside the row; the 375px row with four controls.
 *
 * The queue's own user (`queue@opentask.local`, as tq-queue-panels.spec.ts),
 * with the server's task-queue switch on (decks need it) and off after the
 * file. Isolation: unique titles, every task trashed in `finally`.
 * Clock-independent: "today" is the user's calendar day, read at run time.
 */
import path from 'path'
import Database from 'better-sqlite3'
import { DateTime } from 'luxon'
import { test, expect, uniqueTitle } from './fixtures'
import type { Locator, Page } from '@playwright/test'

const QUEUE_USER_ID = 2
const TZ = process.env.E2E_TZ || 'America/Chicago'
const DAY = 24 * 60 * 60 * 1000
const daysFromNow = (n: number) => new Date(Date.now() + n * DAY).toISOString()
/** The user's calendar day, `n` days from today (yyyy-MM-dd). */
const calendarDay = (n = 0) => DateTime.now().setZone(TZ).plus({ days: n }).toFormat('yyyy-MM-dd')

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

async function deck(page: Page, ids: number[], day?: string | null) {
  const res = await page.request.post('/api/tasks/deck', {
    data: day === undefined ? { ids } : { ids, day },
  })
  expect(res.ok(), await res.text()).toBeTruthy()
}

async function stateOf(page: Page, id: number): Promise<Record<string, unknown>> {
  return (await (await page.request.get(`/api/tasks/${id}`)).json()).data
}

const deckOf = async (page: Page, id: number) => (await stateOf(page, id)).on_deck_day

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

/** Made yesterday: a horizon segment lists a task from the day after it was made. */
const madeYesterday = (id: number) =>
  sql(
    `UPDATE tasks SET created_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 day') WHERE id = ?`,
    id,
  )

const segRow = (scope: Page | Locator, id: number) => scope.locator(`[data-segment-task="${id}"]`)
const segment = (page: Page, kind: string) =>
  page.locator('[data-task-segments]').locator(`[data-task-segment="${kind}"]`)
const toast = (page: Page, text: string | RegExp) =>
  page.locator('[data-sonner-toast]').filter({ hasText: text })
const dashRow = (page: Page, id: number) => page.locator(`#task-row-${id}`)

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  await signIn(page)
  const res = await page.request.post('/api/test/task-queue', { data: { enabled: true } })
  expect(res.ok()).toBeTruthy()
})
test.afterAll(async ({ request }) => {
  await request.post('/api/test/task-queue', { data: { enabled: false } })
})

test('a horizon row: tap decks it for today (the row leaves), Undo puts it back', async ({
  page,
}) => {
  const ids: number[] = []
  try {
    const title = uniqueTitle('OD days')
    const id = await create(page, { title, horizon: 'days' })
    ids.push(id)
    madeYesterday(id)
    await page.goto('/reminders')
    const r = segRow(segment(page, 'days'), id)
    const button = r.locator('[data-on-deck]')
    await expect(button).toBeVisible()
    await expect(button).not.toHaveAttribute('data-on-deck-active', '')
    // Order: details · On deck · Today · done.
    const order = await r
      .locator('[data-segment-details], [data-on-deck], [data-target-today], [aria-label^="Done"]')
      .evaluateAll((els) =>
        els.map((e) =>
          e.hasAttribute('data-segment-details')
            ? 'details'
            : e.hasAttribute('data-on-deck')
              ? 'deck'
              : e.hasAttribute('data-target-today')
                ? 'today'
                : 'done',
        ),
      )
    expect(order).toEqual(['details', 'deck', 'today', 'done'])

    await button.click()
    await expect(r).toHaveCount(0)
    const t = toast(page, `On deck for today: “${title}”`)
    await expect(t).toBeVisible()
    await expect.poll(() => deckOf(page, id)).toBe(calendarDay())
    expect((await stateOf(page, id)).last_considered_at).not.toBeNull()

    await t.getByRole('button', { name: 'Undo' }).click()
    await expect.poll(() => deckOf(page, id)).toBeNull()
    await expect(segRow(segment(page, 'days'), id)).toBeVisible()
  } finally {
    await trash(page, ids)
  }
})

test("Now's On deck section: appears below the projects, sorts by priority, empties", async ({
  page,
}) => {
  const ids: number[] = []
  try {
    const low = await create(page, { title: uniqueTitle('OD low'), priority: 1 })
    const high = await create(page, { title: uniqueTitle('OD high'), priority: 3 })
    const plain = await create(page, { title: uniqueTitle('OD plain'), priority: 3 })
    ids.push(low, high, plain)
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/')
    // Nothing on deck: no section at all.
    await expect(dashRow(page, plain)).toBeVisible()
    await expect(page.locator('[data-deck-section]')).toHaveCount(0)

    await deck(page, [low, high])
    await page.reload()
    const section = page.locator('[data-deck-section]')
    await expect(section).toBeVisible()
    await expect(section).toContainText('On deck')
    // The last group on the page, priority first.
    await expect(page.locator('[data-task-group]').last()).toHaveAttribute('data-deck-section', '')
    const rows = await section.locator('[role="option"]').evaluateAll((els) => els.map((e) => e.id))
    expect(rows).toEqual([`task-row-${high}`, `task-row-${low}`])
    await section.scrollIntoViewIfNeeded()
    await page.screenshot({ path: '.tmp/od-now-section-1280.png' })
    await page.setViewportSize({ width: 375, height: 812 })
    await section.scrollIntoViewIfNeeded()
    await page.screenshot({ path: '.tmp/od-now-section-375.png' })
    await page.setViewportSize({ width: 1280, height: 800 })
    // Each deck is drawn once, with its filled (active) On deck button.
    await expect(dashRow(page, high)).toHaveCount(1)
    const highDeck = dashRow(page, high).locator('[data-on-deck]')
    await expect(highDeck).toHaveAttribute('data-on-deck-active', '')
    await expect(highDeck).toBeVisible()

    // Tapping the filled button takes today's deck off (A10).
    await dashRow(page, high).hover()
    await highDeck.click()
    await expect(toast(page, 'Taken off deck')).toBeVisible()
    await expect.poll(() => deckOf(page, high)).toBeNull()
    await expect(section.locator(`#task-row-${high}`)).toHaveCount(0)

    // Remove from the hold menu (right-click) empties the section entirely.
    await dashRow(page, low).hover()
    await dashRow(page, low).locator('[data-on-deck]').click({ button: 'right' })
    await page
      .getByRole('menu', { name: 'On deck options' })
      .getByRole('menuitem', { name: 'Remove' })
      .click()
    await expect.poll(() => deckOf(page, low)).toBeNull()
    await expect(page.locator('[data-deck-section]')).toHaveCount(0)

    // And the hover On deck sits left of Today on an undated row.
    await dashRow(page, plain).hover()
    const plainDeck = dashRow(page, plain).locator('[data-on-deck]')
    await expect(plainDeck).toBeVisible()
    const deckBox = (await plainDeck.boundingBox())!
    const todayBox = (await dashRow(page, plain).locator('[data-target-today]').boundingBox())!
    expect(deckBox.x).toBeLessThan(todayBox.x)
    await plainDeck.click()
    await expect(toast(page, 'On deck for today')).toBeVisible()
    await expect(page.locator('[data-deck-section]').locator(`#task-row-${plain}`)).toBeVisible()
  } finally {
    await trash(page, ids)
  }
})

test('re-deck to Tomorrow from Queued (hold menu)', async ({ page }) => {
  const ids: number[] = []
  try {
    const id = await create(page, { title: uniqueTitle('OD queued'), due_at: daysFromNow(-2) })
    ids.push(id)
    sql('UPDATE tasks SET target_set_at = ? WHERE id = ?', daysFromNow(-3), id)
    const res = await page.request.post('/api/test/rollover', {
      data: { user_id: QUEUE_USER_ID, force: true },
    })
    expect(res.ok(), await res.text()).toBeTruthy()
    expect((await stateOf(page, id)).queued_at).not.toBeNull()

    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/reminders')
    const r = segRow(segment(page, 'queue_today'), id)
    await r.locator('[data-on-deck]').click({ button: 'right' })
    const menu = page.getByRole('menu', { name: 'On deck options' })
    await expect(menu.getByRole('menuitem', { name: /check-in/ })).toHaveCount(1)
    await expect(menu.getByRole('menuitem', { name: 'Remove' })).toHaveCount(0)
    await menu.getByRole('menuitem', { name: /^Tomorrow/ }).click()
    await expect(toast(page, 'On deck for tomorrow')).toBeVisible()
    await expect.poll(() => deckOf(page, id)).toBe(calendarDay(1))
    const after = await stateOf(page, id)
    expect(after.queued_at).toBeNull()
    await expect(r).toHaveCount(0)
  } finally {
    await trash(page, ids)
  }
})

test('an Upcoming deck row reads "On deck <day>", and Today on it is a pick', async ({ page }) => {
  const ids: number[] = []
  try {
    const id = await create(page, { title: uniqueTitle('OD upcoming') })
    ids.push(id)
    await deck(page, [id], calendarDay(1))
    // Decked ten days ago for tomorrow: today is its heads-up day (and the
    // deck's own "considered" stamp, A7, goes back with it).
    sql(
      'UPDATE tasks SET target_set_at = ?, last_considered_at = ?, segment_targeted_at = NULL WHERE id = ?',
      daysFromNow(-10),
      daysFromNow(-10),
      id,
    )
    await page.goto('/reminders')
    const r = segRow(segment(page, 'upcoming'), id)
    const day = DateTime.fromISO(calendarDay(1)).toFormat('ccc LLL d')
    await expect(r.locator('[data-target-chip]')).toHaveText(`On deck ${day}`)
    await expect(r.locator('[data-on-deck]')).toHaveAttribute('data-on-deck-active', '')
    await r.locator('[data-target-today]').click()
    await expect(toast(page, /Targeted/)).toBeVisible()
    await expect.poll(() => deckOf(page, id)).toBeNull()
    expect((await stateOf(page, id)).target_at).not.toBeNull()

    // A repeating Upcoming row has no On deck (rule 6, B9) — seeded as
    // up-upcoming.spec.ts does: due tomorrow, its target set ten days ago.
    const repeating = await create(page, {
      title: uniqueTitle('OD repeating'),
      rrule: 'FREQ=DAILY;INTERVAL=3;BYHOUR=11;BYMINUTE=0',
      target_at: DateTime.now()
        .setZone(TZ)
        .plus({ days: 1 })
        .set({ hour: 11, minute: 0 })
        .toUTC()
        .toISO(),
    })
    ids.push(repeating)
    sql('UPDATE tasks SET target_set_at = ? WHERE id = ?', daysFromNow(-10), repeating)
    await page.reload()
    const w = segRow(segment(page, 'upcoming'), repeating)
    await expect(w).toBeVisible()
    await expect(w.locator('[data-target-today]')).toBeVisible()
    await expect(w.locator('[data-on-deck]')).toHaveCount(0)
  } finally {
    await trash(page, ids)
  }
})

test('A1: a deadline already reminding refuses On deck with the toast', async ({ page }) => {
  const ids: number[] = []
  try {
    const title = uniqueTitle('OD deadline')
    const id = await create(page, { title, deadline_at: daysFromNow(2) })
    ids.push(id)
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/')
    await dashRow(page, id).hover()
    await dashRow(page, id).locator('[data-on-deck]').click()
    await expect(
      toast(page, 'This deadline is close and already reminding you — use Today.'),
    ).toBeVisible()
    expect(await deckOf(page, id)).toBeNull()
    await expect(dashRow(page, id)).toBeVisible()
  } finally {
    await trash(page, ids)
  }
})

test('the Quick panel: an On deck line, staged until Save; "was on deck" in details only', async ({
  page,
}) => {
  const ids: number[] = []
  try {
    const id = await create(page, { title: uniqueTitle('OD panel'), horizon: 'days' })
    ids.push(id)
    madeYesterday(id)
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/reminders')
    await segRow(segment(page, 'days'), id)
      .getByRole('button', { name: /^Details:/ })
      .click()
    const dialog = page.getByRole('dialog')
    const line = dialog.locator('[data-quick-panel-deck]')
    await expect(line).toContainText('Not on deck')
    await line.locator('[data-on-deck]').click()
    await expect(line.locator('[data-quick-panel-deck-day]')).toHaveText('today')
    await expect(line.locator('[data-quick-panel-deck-day]')).toHaveClass(/text-blue-500/)
    expect(await deckOf(page, id)).toBeNull()
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect.poll(() => deckOf(page, id)).toBe(calendarDay())

    // A deck the rollover sent to the queue: "was on deck" in details, not on the row (A9).
    const queued = await create(page, { title: uniqueTitle('OD was') })
    ids.push(queued)
    sql(
      'UPDATE tasks SET queued_at = ?, queued_from_deck_day = ? WHERE id = ?',
      new Date().toISOString(),
      calendarDay(-1),
      queued,
    )
    await page.reload()
    const r = segRow(page.locator('[data-task-segments]'), queued).first()
    await expect(r).toBeVisible()
    await expect(r).not.toContainText('was on deck')
    await r.getByRole('button', { name: /^Details:/ }).click()
    await expect(page.getByRole('dialog').locator('[data-quick-panel-was-on-deck]')).toContainText(
      `was on deck ${DateTime.fromISO(calendarDay(-1)).toFormat('ccc LLL d')}`,
    )
  } finally {
    await trash(page, ids)
  }
})

test('segment rows: the On deck hover box stays inside the row; the 375px row fits', async ({
  page,
}) => {
  const ids: number[] = []
  try {
    const id = await create(page, {
      title: uniqueTitle('OD a long enough title to wrap on a phone screen'),
      horizon: 'days',
      deadline_at: daysFromNow(20),
    })
    ids.push(id)
    madeYesterday(id)
    for (const size of [
      { width: 1280, height: 800 },
      { width: 375, height: 812 },
    ]) {
      await page.setViewportSize(size)
      await page.goto('/reminders')
      const r = segRow(segment(page, 'days'), id)
      await expect(r).toBeVisible()
      const box = r.locator('[data-on-deck-box]')
      await box.hover()
      const inner = (await box.boundingBox())!
      const outer = (await r.boundingBox())!
      expect(inner.y).toBeGreaterThanOrEqual(outer.y)
      expect(inner.y + inner.height).toBeLessThanOrEqual(outer.y + outer.height)
      expect(inner.x).toBeGreaterThanOrEqual(outer.x)
      expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width)
      // No horizontal overflow: the row and the page keep their width.
      const overflow = await r.evaluate((el) => el.scrollWidth - el.clientWidth)
      expect(overflow).toBeLessThanOrEqual(0)
      const pageOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(pageOverflow).toBeLessThanOrEqual(0)
      await page.screenshot({ path: `.tmp/od-segment-row-${size.width}.png` })
    }
  } finally {
    await trash(page, ids)
  }
})
