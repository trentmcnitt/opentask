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
 * Clock-independent: "today" is the user's OpenTask day (`openTaskDay`), read at run time.
 */
import path from 'path'
import Database from 'better-sqlite3'
import { DateTime } from 'luxon'
import { test, expect, openTaskDay, uniqueTitle } from './fixtures'
import type { Locator, Page } from '@playwright/test'

const QUEUE_USER_ID = 2
const TZ = process.env.E2E_TZ || 'America/Chicago'
const DAY = 24 * 60 * 60 * 1000
const daysFromNow = (n: number) => new Date(Date.now() + n * DAY).toISOString()

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

/**
 * A row's controls in DOM order, the reserved empty places included: On deck
 * · On deck tomorrow · Today · done since 2026-10-21 (Trent: today's deck,
 * then the next day's, then Today).
 */
async function controlOrder(row: Locator): Promise<string[]> {
  return row
    .locator(
      '[data-on-deck], [data-deck-slot-empty], [data-deck-tomorrow], [data-deck-tomorrow-empty], [data-target-today], [aria-label^="Done"]',
    )
    .evaluateAll((els) =>
      els.map((e) =>
        e.hasAttribute('data-on-deck')
          ? 'deck'
          : e.hasAttribute('data-deck-slot-empty')
            ? 'deck-empty'
            : e.hasAttribute('data-deck-tomorrow')
              ? 'deck-tomorrow'
              : e.hasAttribute('data-deck-tomorrow-empty')
                ? 'deck-tomorrow-empty'
                : e.hasAttribute('data-target-today')
                  ? 'today'
                  : 'done',
      ),
    )
}

/**
 * A task-segment row's details (2026-10-20, the pencil gone): right-click the
 * row's title for its peek bubble, then the bubble's Open.
 */
async function openDetails(row: Locator) {
  const page = row.page()
  await row.locator('p').first().click({ button: 'right' })
  await page.locator('[data-task-peek]').getByRole('button', { name: 'Open' }).click()
}

/** The user's overdue set (the badge's): `GET /api/tasks?overdue=true`. */
async function overdueIds(page: Page): Promise<number[]> {
  const res = await page.request.get('/api/tasks?overdue=true&limit=1000')
  return ((await res.json()).data.tasks as { id: number }[]).map((t) => t.id)
}

/** The rrule weekday code of an instant in the user's zone. */
function weekdayCode(iso: string): string {
  const day = DateTime.fromISO(iso).setZone(TZ).weekday
  return ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'][day - 1]
}

/**
 * A weekly task whose occurrence was four days ago (over target), its next
 * one three days out — so the rollover makes it WAIT in the queue.
 */
async function missedWeekly(page: Page, title: string): Promise<number> {
  const id = await create(page, {
    title,
    rrule: `FREQ=WEEKLY;BYDAY=${weekdayCode(daysFromNow(3))}`,
    due_at: daysFromNow(3),
  })
  sql(
    'UPDATE tasks SET due_at = ?, occurrence_at = ?, target_set_at = ? WHERE id = ?',
    daysFromNow(-4),
    daysFromNow(-4),
    daysFromNow(-5),
    id,
  )
  return id
}

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
    // Order: On deck · On deck tomorrow · Today · done (no pencil, 2026-10-20;
    // On deck first, 2026-10-21).
    await expect(r.locator('[data-segment-details]')).toHaveCount(0)
    expect(await controlOrder(r)).toEqual(['deck', 'deck-tomorrow', 'today', 'done'])

    await button.click()
    await expect(r).toHaveCount(0)
    const t = toast(page, `On deck for today: “${title}”`)
    await expect(t).toBeVisible()
    await expect.poll(() => deckOf(page, id)).toBe(await openTaskDay(page))
    expect((await stateOf(page, id)).last_considered_at).not.toBeNull()

    await t.getByRole('button', { name: 'Undo' }).click()
    await expect.poll(() => deckOf(page, id)).toBeNull()
    await expect(segRow(segment(page, 'days'), id)).toBeVisible()
  } finally {
    await trash(page, ids)
  }
})

test("Now's On deck section: at the top of Now, sorts by priority, empties", async ({ page }) => {
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
    // Priority first.
    const rows = await section.locator('[role="option"]').evaluateAll((els) => els.map((e) => e.id))
    expect(rows).toEqual([`task-row-${high}`, `task-row-${low}`])
    // A section row has On deck and Today, in that order (no On deck
    // tomorrow on dashboard rows).
    expect(await controlOrder(section.locator(`#task-row-${high}`))).toEqual(['deck', 'today'])
    // At the TOP of Now (designer, 10-20): under the filter row, above the
    // task-segment panel and the project groups — desktop and phone.
    for (const size of [
      { width: 1280, height: 800 },
      { width: 375, height: 812 },
    ]) {
      await page.setViewportSize(size)
      await expect(section).toBeVisible()
      const where = await page.evaluate(() => {
        const deckList = document.querySelector('[data-deck-list]')!
        const pos = (el: Element | null | undefined) =>
          el ? deckList.compareDocumentPosition(el) : null
        const filters = [...document.querySelectorAll('button')].find((b) =>
          b.textContent?.trim().startsWith('Filters'),
        )
        return {
          filters: pos(filters),
          list: pos(document.querySelector('[aria-label="Task list"]')),
          panel: pos(document.querySelector('[data-tasks-panel]')),
        }
      })
      // The filter row before it; the project list and the panel after it.
      expect(where.filters! & 2 /* PRECEDING */).toBeTruthy()
      expect(where.list! & 4 /* FOLLOWING */).toBeTruthy()
      if (where.panel !== null) expect(where.panel & 4 /* FOLLOWING */).toBeTruthy()
      const deckTop = (await section.boundingBox())!.y
      const projectTop = (await page
        .locator('[aria-label="Task list"] [data-task-group]')
        .first()
        .boundingBox())!.y
      expect(deckTop).toBeLessThan(projectTop)
      // The row inside the section has no "On deck" pill: the heading says it.
      await expect(
        section.locator(`#task-row-${high}`).getByText('On deck', { exact: true }),
      ).toHaveCount(0)
      await page.screenshot({ path: `.tmp/od-now-section-${size.width}.png` })
    }
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
    // A queue row reads like every segment row (2026-10-21).
    await expect(r.locator('[data-on-deck]')).toBeVisible()
    expect(await controlOrder(r)).toEqual(['deck', 'deck-tomorrow', 'today', 'done'])
    await r.locator('[data-on-deck]').click({ button: 'right' })
    const menu = page.getByRole('menu', { name: 'On deck options' })
    await expect(menu.getByRole('menuitem', { name: /check-in/ })).toHaveCount(1)
    await expect(menu.getByRole('menuitem', { name: 'Remove' })).toHaveCount(0)
    await menu.getByRole('menuitem', { name: /^Tomorrow/ }).click()
    await expect(toast(page, 'On deck for tomorrow')).toBeVisible()
    await expect.poll(() => deckOf(page, id)).toBe(await openTaskDay(page, 1))
    const after = await stateOf(page, id)
    expect(after.queued_at).toBeNull()
    await expect(r).toHaveCount(0)
  } finally {
    await trash(page, ids)
  }
})

test('an Upcoming deck row reads "On deck tomorrow" in Tomorrow, On deck tomorrow lit, and Today on it is a pick', async ({
  page,
}) => {
  const ids: number[] = []
  try {
    const id = await create(page, { title: uniqueTitle('OD upcoming') })
    ids.push(id)
    await deck(page, [id], await openTaskDay(page, 1))
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
    // On deck tomorrow: in Upcoming's Tomorrow section (2026-10-25). Its
    // rows say only the time, but a deck has none: "On deck tomorrow"
    // (2026-10-27; a Later row says "On deck Mon Oct 26").
    await expect(
      segment(page, 'upcoming')
        .locator('[data-upcoming-section="tomorrow"]')
        .locator(`[data-segment-task="${id}"]`),
    ).toBeVisible()
    await expect(r.locator('[data-target-chip]')).toHaveText('On deck tomorrow')
    // The button that names the day is the lit one (2026-10-27): On deck
    // tomorrow, not On deck (today's).
    await expect(r.locator('[data-deck-tomorrow]')).toHaveAttribute('data-deck-tomorrow-active', '')
    await expect(r.locator('[data-deck-tomorrow]')).toHaveAttribute('aria-pressed', 'true')
    await expect(r.locator('[data-on-deck]')).not.toHaveAttribute('data-on-deck-active', '')
    // An Upcoming row reads like every segment row (2026-10-21).
    expect(await controlOrder(r)).toEqual(['deck', 'deck-tomorrow', 'today', 'done'])
    // A one-off with a picked target (2026-10-22, plan §5): On deck and On
    // deck tomorrow are there, FADED — a deck would replace the target.
    const picked = await create(page, {
      title: uniqueTitle('OD picked'),
      target_at: DateTime.now()
        .setZone(TZ)
        .plus({ days: 1 })
        .set({ hour: 10, minute: 0 })
        .toUTC()
        .toISO(),
    })
    ids.push(picked)
    sql('UPDATE tasks SET target_set_at = ? WHERE id = ?', daysFromNow(-10), picked)
    await page.reload()
    const p = segRow(segment(page, 'upcoming'), picked)
    await expect(p).toBeVisible()
    expect(await controlOrder(p)).toEqual(['deck', 'deck-tomorrow', 'today', 'done'])
    await expect(p.locator('[data-on-deck]')).toHaveAttribute('data-replaces', '')
    await expect(p.locator('[data-deck-tomorrow]')).toHaveAttribute('data-replaces', '')
    // Today on the decked row is faded too, and asks first (it takes it off deck).
    await r.locator('[data-target-today]').click()
    await expect(page.locator('[data-replace-confirm]')).toContainText(`Replaces On deck`)
    await page.locator('[data-replace-confirm] [data-replace-ok]').click()
    await expect(toast(page, /Targeted/)).toBeVisible()
    await expect.poll(() => deckOf(page, id)).toBeNull()
    expect((await stateOf(page, id)).target_at).not.toBeNull()

    // A repeating Upcoming row has On deck too (2026-10-20: it decks the
    // occurrence) — seeded as up-upcoming.spec.ts does: due tomorrow, its
    // target set ten days ago.
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
    await expect(w.locator('[data-on-deck]')).toHaveCount(1)
    await expect(w.locator('[data-on-deck]')).not.toHaveAttribute('data-on-deck-active', '')
  } finally {
    await trash(page, ids)
  }
})

/**
 * A LIT BUTTON TOGGLES OFF (2026-10-27, Trent): tomorrow's deck lights On deck
 * tomorrow, and a tap on it takes the task off deck — as a tap on a lit On
 * deck does for today's. One rule.
 */
test('a lit On deck tomorrow: a tap takes the task off deck', async ({ page }) => {
  const ids: number[] = []
  try {
    const id = await create(page, { title: uniqueTitle('OD lit tomorrow') })
    ids.push(id)
    await deck(page, [id], await openTaskDay(page, 1))
    sql(
      'UPDATE tasks SET target_set_at = ?, last_considered_at = ?, segment_targeted_at = NULL WHERE id = ?',
      daysFromNow(-10),
      daysFromNow(-10),
      id,
    )
    await page.goto('/reminders')
    const button = segRow(segment(page, 'upcoming'), id).locator('[data-deck-tomorrow]')
    await expect(button).toHaveAttribute('data-deck-tomorrow-active', '')
    await expect(button).toHaveAttribute('title', /tap to take off/)
    await button.click()
    await expect.poll(() => deckOf(page, id)).toBeNull()
  } finally {
    await trash(page, ids)
  }
})

test('A1: a deadline that has passed refuses On deck with the toast', async ({ page }) => {
  const ids: number[] = []
  try {
    const title = uniqueTitle('OD deadline')
    // A deadline an hour ago: passed whatever the time of day (the deadlines
    // page's A1, 2026-10-22: any day up to the deadline's own, while it is ahead).
    const id = await create(page, { title, deadline_at: daysFromNow(-1 / 24) })
    ids.push(id)
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/')
    await dashRow(page, id).hover()
    await dashRow(page, id).locator('[data-on-deck]').click()
    await expect(toast(page, 'This deadline has passed.')).toBeVisible()
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
    await openDetails(segRow(segment(page, 'days'), id))
    const dialog = page.getByRole('dialog')
    const line = dialog.locator('[data-quick-panel-deck]')
    await expect(line).toContainText('Not on deck')
    await line.locator('[data-on-deck]').click()
    await expect(line.locator('[data-quick-panel-deck-day]')).toHaveText('today')
    await expect(line.locator('[data-quick-panel-deck-day]')).toHaveClass(/text-blue-500/)
    expect(await deckOf(page, id)).toBeNull()
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect.poll(() => deckOf(page, id)).toBe(await openTaskDay(page))

    // A deck the rollover sent to the queue: "was on deck" in details, not on the row (A9).
    const queued = await create(page, { title: uniqueTitle('OD was') })
    ids.push(queued)
    sql(
      'UPDATE tasks SET queued_at = ?, queued_from_deck_day = ? WHERE id = ?',
      new Date().toISOString(),
      await openTaskDay(page, -1),
      queued,
    )
    await page.reload()
    const r = segRow(page.locator('[data-task-segments]'), queued).first()
    await expect(r).toBeVisible()
    await expect(r).not.toContainText('was on deck')
    await openDetails(r)
    await expect(page.getByRole('dialog').locator('[data-quick-panel-was-on-deck]')).toContainText(
      `was on deck ${DateTime.fromISO(await openTaskDay(page, -1)).toFormat('ccc LLL d')}`,
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
      // With a deadline and no target the deadlines page holds it (2026-10-22):
      // a 30-day lead puts it there today, the deadline chip on its row.
      deadline_at: daysFromNow(20),
      lead_days: 30,
    })
    ids.push(id)
    madeYesterday(id)
    for (const size of [
      { width: 1280, height: 800 },
      { width: 375, height: 812 },
    ]) {
      await page.setViewportSize(size)
      await page.goto('/reminders')
      const r = segRow(segment(page, 'deadlines'), id)
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
      // Today is its sun alone at phone width (2026-10-21), the word kept
      // for screen readers; from `sm` up the word shows.
      const today = r.locator('[data-target-today]')
      await expect(today).toHaveAccessibleName(/today/i)
      const word = today.getByText('Today', { exact: true })
      const wordWidth = (await word.boundingBox())?.width ?? 0
      if (size.width < 640) expect(wordWidth).toBeLessThanOrEqual(1)
      else expect(wordWidth).toBeGreaterThan(20)
      await page.screenshot({ path: `.tmp/od-segment-row-${size.width}.png` })
    }
  } finally {
    await trash(page, ids)
  }
})

// ===========================================================================
// D2 review (10-20): the Quick panel, the placeholder, the date picker, touch
// ===========================================================================

const setQueue = async (page: Page, enabled: boolean) => {
  const res = await page.request.post('/api/test/task-queue', { data: { enabled } })
  expect(res.ok()).toBeTruthy()
}

/** Open the dashboard's Quick panel on a row (desktop: a double-click). */
async function openPanel(page: Page, id: number): Promise<Locator> {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await dashRow(page, id).dblclick()
  const dialog = page.getByRole('dialog')
  await expect(dialog.locator('[data-quick-panel-deck]')).toBeVisible()
  return dialog
}

/** Stage a deadline `days` out (the picker's own time) in the open panel. */
async function stageDeadline(page: Page, dialog: Locator, days: number) {
  await dialog.locator('[data-quick-panel-deadline]').click()
  const t = DateTime.now().setZone(TZ).plus({ days })
  const key = await page.evaluate(
    ([y, m, d]) => new Date(y, m - 1, d).toLocaleDateString(),
    [t.year, t.month, t.day],
  )
  const cell = page.locator(`button[data-day="${key}"]`).first()
  if ((await cell.count()) === 0) await page.getByRole('button', { name: /next month/i }).click()
  await cell.click()
  await page.getByRole('button', { name: 'Set Date', exact: true }).click()
  await expect(dialog.locator('[data-quick-panel-deadline] .text-blue-500')).toBeVisible()
}

const lastUndo = (page: Page) =>
  page
    .locator('[data-sonner-toast]')
    .filter({ has: page.getByRole('button', { name: 'Undo' }) })
    .last()
    .getByRole('button', { name: 'Undo' })

test('panel: a staged deadline and deck save in ONE request; the menu greys from the staged deadline', async ({
  page,
}) => {
  const ids: number[] = []
  try {
    const id = await create(page, { title: uniqueTitle('OD panel deadline'), priority: 3 })
    ids.push(id)
    const dialog = await openPanel(page, id)
    // A deadline three days out: the days after it are greyed, with the
    // reason (the deadlines page's A1, 2026-10-22).
    await stageDeadline(page, dialog, 3)
    await dialog.locator('[data-quick-panel-deck] [data-on-deck]').click({ button: 'right' })
    const menu = page.getByRole('menu', { name: 'On deck options' })
    await expect(menu.locator('[data-option-caption]').first()).toHaveText(/^deadline \w{3}$/)
    const greyed = menu.locator('[role="menuitem"][aria-disabled="true"]')
    expect(await greyed.count()).toBeGreaterThan(0)
    await menu.getByRole('menuitem', { name: /^Tomorrow/ }).click()
    await expect(dialog.locator('[data-quick-panel-deck-day]')).toHaveText('tomorrow')

    const patches: string[] = []
    page.on('request', (r) => {
      if (r.method() === 'PATCH' && r.url().endsWith(`/api/tasks/${id}`)) patches.push(r.url())
    })
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect.poll(() => deckOf(page, id)).toBe(await openTaskDay(page, 1))
    expect((await stateOf(page, id)).deadline_at).not.toBeNull()
    expect(patches).toHaveLength(1)
    // One undo entry: Undo puts both back.
    await lastUndo(page).click()
    await expect.poll(() => deckOf(page, id)).toBeNull()
    expect((await stateOf(page, id)).deadline_at).toBeNull()
  } finally {
    await trash(page, ids)
  }
})

test('panel: a refused deck saves nothing — the error shows and the panel stays dirty', async ({
  page,
}) => {
  const ids: number[] = []
  try {
    const id = await create(page, { title: uniqueTitle('OD panel refused'), priority: 3 })
    ids.push(id)
    const dialog = await openPanel(page, id)
    // Yesterday: a deadline that has passed refuses every deck (A1, 2026-10-22).
    await stageDeadline(page, dialog, -1)
    await dialog.locator('[data-quick-panel-deck] [data-on-deck]').click()
    const day = dialog.locator('[data-quick-panel-deck-day]')
    await expect(day).toHaveText('today')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(toast(page, /has passed|after this task's deadline/)).toBeVisible()
    await expect(dialog).toBeVisible()
    await expect(day).toHaveClass(/text-blue-500/)
    await expect(dialog.locator('[data-quick-panel-deadline] .text-blue-500')).toBeVisible()
    const state = await stateOf(page, id)
    expect(state.on_deck_day).toBeNull()
    expect(state.deadline_at).toBeNull()
    await dialog.getByRole('button', { name: 'Reset' }).click()
  } finally {
    await trash(page, ids)
  }
})

test('panel: a deck staged, then Reminder staged — the line goes and no deck is sent', async ({
  page,
}) => {
  const ids: number[] = []
  try {
    const id = await create(page, { title: uniqueTitle('OD panel reminder'), priority: 3 })
    ids.push(id)
    const dialog = await openPanel(page, id)
    await dialog.locator('[data-quick-panel-deck] [data-on-deck]').click()
    await expect(dialog.locator('[data-quick-panel-deck-day]')).toHaveText('today')
    await dialog.getByRole('button', { name: 'More options' }).click()
    await page.getByRole('menuitemcheckbox', { name: 'Reminder' }).click()
    await page.keyboard.press('Escape')
    await expect(dialog.locator('[data-quick-panel-deck]')).toHaveCount(0)
    const sent = page.waitForRequest(
      (r) => r.method() === 'PATCH' && r.url().endsWith(`/api/tasks/${id}`),
    )
    await dialog.getByRole('button', { name: 'Save' }).click()
    const body = (await sent).postDataJSON() as Record<string, unknown>
    expect(body).not.toHaveProperty('on_deck_day')
    expect(body.is_reminder).toBe(true)
    await expect.poll(async () => (await stateOf(page, id)).is_reminder).toBe(true)
    expect(await deckOf(page, id)).toBeNull()
  } finally {
    await trash(page, ids)
  }
})

test('panel: On deck after a staged target goes back to the deck', async ({ page }) => {
  const ids: number[] = []
  try {
    // Not on deck: stage a target, then tap On deck — the target goes, the deck stays.
    const id = await create(page, { title: uniqueTitle('OD panel target'), priority: 3 })
    ids.push(id)
    const dialog = await openPanel(page, id)
    const dateLine = dialog.locator('[data-quick-panel-date]')
    // Stage a target with the panel's own increment button.
    await dialog.getByRole('button', { name: '+1 day', exact: true }).click()
    await expect(dateLine.locator('.text-blue-500').first()).toBeVisible()
    await dialog.locator('[data-quick-panel-deck] [data-on-deck]').click()
    await expect(dialog.locator('[data-quick-panel-deck-day]')).toHaveText('today')
    await expect(dateLine.locator('.text-blue-500')).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect.poll(() => deckOf(page, id)).toBe(await openTaskDay(page))
    expect((await stateOf(page, id)).target_at).toBeNull()

    // On deck already: a staged target shadows it ("Not on deck", blue); a
    // tap back to the stored day unstages the target and leaves nothing dirty.
    const dialog2 = await openPanel(page, id)
    const line = dialog2.locator('[data-quick-panel-deck-day]')
    const dateLine2 = dialog2.locator('[data-quick-panel-date]')
    await dialog2.getByRole('button', { name: '+1 day', exact: true }).click()
    await expect(line).toHaveText('Not on deck')
    await expect(line).toHaveClass(/text-blue-500/)
    await dialog2.locator('[data-quick-panel-deck] [data-on-deck]').click()
    await expect(line).toHaveText('today')
    await expect(line).not.toHaveClass(/text-blue-500/)
    await expect(dateLine2.locator('.text-blue-500')).toHaveCount(0)
    await page.keyboard.press('Escape')
  } finally {
    await trash(page, ids)
  }
})

test('the date picker: opens on an allowed day, resets on reopen, refuses a day it can’t take', async ({
  page,
}) => {
  const ids: number[] = []
  try {
    const id = await create(page, { title: uniqueTitle('OD picker'), priority: 3 })
    const nagging = await create(page, {
      title: uniqueTitle('OD picker deadline'),
      // An hour ago: reminding whatever the time of day (2026-10-21's lead table).
      deadline_at: daysFromNow(-1 / 24),
    })
    ids.push(id, nagging)
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/')
    const openPicker = async (taskId: number) => {
      await dashRow(page, taskId).hover()
      await dashRow(page, taskId).locator('[data-on-deck]').click({ button: 'right' })
      await page
        .getByRole('menu', { name: 'On deck options' })
        .getByRole('menuitem', { name: 'Pick a date…' })
        .click()
      const picker = page.getByRole('dialog', { name: 'On deck for…' })
      await expect(picker).toBeVisible()
      return picker
    }
    const today = DateTime.fromISO(await openTaskDay(page), { zone: TZ })
    const dayOf = (n: number) => String(today.plus({ days: n }).day)
    let picker = await openPicker(id)
    // Tomorrow, selected, and choosable.
    await expect(picker.locator('[data-selected-single="true"]')).toHaveText(dayOf(1))
    await expect(picker.locator('[data-deck-date-submit]')).toBeEnabled()
    // Pick another day, close without choosing: the next open starts afresh.
    const three = today.plus({ days: 3 })
    const key = await page.evaluate(
      ([y, m, d]) => new Date(y, m - 1, d).toLocaleDateString(),
      [three.year, three.month, three.day],
    )
    const cell = picker.locator(`button[data-day="${key}"]`).first()
    if ((await cell.count()) > 0) {
      await cell.click()
      await expect(picker.locator('[data-selected-single="true"]')).toHaveText(dayOf(3))
    }
    await page.keyboard.press('Escape')
    await expect(picker).toHaveCount(0)
    picker = await openPicker(id)
    await expect(picker.locator('[data-selected-single="true"]')).toHaveText(dayOf(1))
    await picker.locator('[data-deck-date-submit]').click()
    await expect.poll(() => deckOf(page, id)).toBe(await openTaskDay(page, 1))

    // A deadline already reminding: every day greyed, and nothing to put on deck.
    await dashRow(page, nagging).hover()
    await dashRow(page, nagging).locator('[data-on-deck]').click({ button: 'right' })
    const menu = page.getByRole('menu', { name: 'On deck options' })
    const days = menu.locator('[role="menuitem"]:has([data-option-caption])')
    expect(await days.count()).toBeGreaterThanOrEqual(6)
    await menu.getByRole('menuitem', { name: 'Pick a date…' }).click()
    const refused = page.getByRole('dialog', { name: 'On deck for…' })
    await expect(refused.locator('[data-deck-date-submit]')).toBeDisabled()
    await page.keyboard.press('Escape')
  } finally {
    await trash(page, ids)
  }
})

test('switch off: no On deck placeholder while the preferences load, unless it was on last time', async ({
  page,
}) => {
  const ids: number[] = []
  const held: (() => void)[] = []
  try {
    const id = await create(page, { title: uniqueTitle('OD placeholder'), horizon: 'days' })
    ids.push(id)
    madeYesterday(id)
    await page.goto('/reminders')
    await page.evaluate(() => window.localStorage.setItem('opentask.taskQueueOn', '1'))
    await setQueue(page, false)
    // Hold the preferences until the row has been looked at.
    await page.route('**/api/user/preferences', async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      await new Promise<void>((resolve) => held.push(resolve))
      // A request the page dropped meanwhile (a reload) is already handled.
      await route.continue().catch(() => {})
    })
    const r = () => segRow(segment(page, 'days'), id)

    // Last seen ON: On deck's place is kept while they load.
    await page.reload()
    await expect(r()).toBeVisible()
    await expect(r().locator('[data-deck-placeholder]')).toHaveCount(1)
    held.splice(0).forEach((go) => go())
    await expect(r().locator('[data-deck-placeholder]')).toHaveCount(0)
    await expect(r().locator('[data-on-deck]')).toHaveCount(0)
    // Loaded with the switch off: remembered as off.
    await expect
      .poll(() => page.evaluate(() => window.localStorage.getItem('opentask.taskQueueOn')))
      .toBe('0')

    // Last seen OFF: no placeholder from the first paint.
    await page.reload()
    await expect(r()).toBeVisible()
    await expect(r().locator('[data-deck-placeholder]')).toHaveCount(0)
    held.splice(0).forEach((go) => go())
  } finally {
    held.splice(0).forEach((go) => go())
    await page.unroute('**/api/user/preferences')
    await setQueue(page, true)
    await trash(page, ids)
  }
})

test.describe('touch', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 375, height: 812 } })

  test("Now's On deck section shows On deck and Today on touch; other rows don't", async ({
    page,
  }) => {
    const ids: number[] = []
    try {
      const decked = await create(page, { title: uniqueTitle('OD touch deck'), priority: 3 })
      const plain = await create(page, { title: uniqueTitle('OD touch plain'), priority: 3 })
      ids.push(decked, plain)
      await deck(page, [decked])
      await page.goto('/')
      const section = page.locator('[data-deck-list]')
      const row = section.locator(`#task-row-${decked}`)
      await expect(row).toBeVisible()
      const deckButton = row.locator('[data-on-deck]')
      await expect(deckButton).toBeVisible()
      await expect(deckButton).toHaveAttribute('aria-pressed', 'true')
      await expect(row.locator('[data-target-today]')).toBeVisible()
      await expect(dashRow(page, plain).locator('[data-on-deck]')).toBeHidden()
      await page.screenshot({ path: '.tmp/od-now-section-touch-375.png' })
      // The active chip in the dark theme too.
      await page.emulateMedia({ colorScheme: 'dark' })
      await page.reload()
      await expect(row.locator('[data-on-deck]')).toBeVisible()
      await page.screenshot({ path: '.tmp/od-now-section-touch-375-dark.png' })
      await page.emulateMedia({ colorScheme: 'light' })
      await page.reload()
      await expect(row.locator('[data-on-deck]')).toBeVisible()

      // A tap takes it off deck…
      await deckButton.tap()
      await expect(toast(page, 'Taken off deck')).toBeVisible()
      await expect.poll(() => deckOf(page, decked)).toBeNull()

      // …and Today on a section row targets it (the deck goes) — faded, it
      // asks first (2026-10-22, plan §5: a target replaces the deck).
      await deck(page, [decked])
      await page.reload()
      const today = page.locator(`[data-deck-list] #task-row-${decked} [data-target-today]`)
      await expect(today).toHaveAttribute('data-replaces', '')
      await today.tap()
      await expect(page.locator('[data-replace-confirm]')).toContainText('Replaces On deck today')
      await page.locator('[data-replace-confirm] [data-replace-ok]').tap()
      await expect(toast(page, /Targeted/)).toBeVisible()
      await expect.poll(() => deckOf(page, decked)).toBeNull()
      expect((await stateOf(page, decked)).target_at).not.toBeNull()
    } finally {
      await trash(page, ids)
    }
  })
})

test('REPEATING: a waiting queue row — tap decks the missed occurrence (quietly); a future deck, then Today', async ({
  page,
}) => {
  const ids: number[] = []
  try {
    const title = uniqueTitle('OD weekly')
    const id = await missedWeekly(page, title)
    ids.push(id)
    const res = await page.request.post('/api/test/rollover', {
      data: { user_id: QUEUE_USER_ID, force: true },
    })
    expect(res.ok(), await res.text()).toBeTruthy()
    const waiting = await stateOf(page, id)
    expect(waiting.queued_at).not.toBeNull()

    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/reminders')
    const r = segRow(segment(page, 'queue_today'), id)
    const button = r.locator('[data-on-deck]')
    await expect(button).toBeVisible()
    await expect(r.locator('[data-deck-slot-empty]')).toHaveCount(0)
    await button.click()
    await expect(r).toHaveCount(0)
    await expect(toast(page, `On deck for today: “${title}”`)).toBeVisible()
    await expect.poll(() => deckOf(page, id)).toBe(await openTaskDay(page))
    const decked = await stateOf(page, id)
    expect(decked).toMatchObject({ target_at: null, queued_at: null })
    expect(decked.occurrence_at).toBe(waiting.occurrence_at)
    expect(await overdueIds(page)).not.toContain(id)

    // Re-deck for tomorrow (hold), backdated so today is its heads-up day:
    // an Upcoming row, "On deck <day>"; Today on it is a pick — the deck goes.
    await deck(page, [id], await openTaskDay(page, 1))
    sql(
      'UPDATE tasks SET target_set_at = ?, last_considered_at = ?, segment_targeted_at = NULL WHERE id = ?',
      daysFromNow(-10),
      daysFromNow(-10),
      id,
    )
    await page.reload()
    const u = segRow(segment(page, 'upcoming'), id)
    // On deck tomorrow: Upcoming's Tomorrow section (2026-10-25), "On deck
    // tomorrow"; a repeating row's chip goes on with its schedule ("· every
    // Fri at …").
    await expect(
      segment(page, 'upcoming')
        .locator('[data-upcoming-section="tomorrow"]')
        .locator(`[data-segment-task="${id}"]`),
    ).toBeVisible()
    await expect(u.locator('[data-target-chip]')).toHaveText(/^On deck tomorrow · every /)
    await expect(u.locator('[data-deck-tomorrow]')).toHaveAttribute('data-deck-tomorrow-active', '')
    await page.screenshot({ path: '.tmp/od-repeating-upcoming-1280.png' })
    // Faded on a decked row, it asks first (2026-10-22, plan §5).
    await u.locator('[data-target-today]').click()
    await page.locator('[data-replace-confirm] [data-replace-ok]').click()
    await expect(toast(page, /Targeted/)).toBeVisible()
    await expect.poll(() => deckOf(page, id)).toBeNull()
    expect((await stateOf(page, id)).target_at).not.toBeNull()
  } finally {
    await trash(page, ids)
  }
})

test('REPEATING: a dashboard row over target — tap leaves the nagging list for On deck; tap again, the debt is back', async ({
  page,
}) => {
  const ids: number[] = []
  try {
    const title = uniqueTitle('OD weekly dash')
    const id = await missedWeekly(page, title)
    ids.push(id)
    const occurrence = (await stateOf(page, id)).occurrence_at
    expect(await overdueIds(page)).toContain(id)

    for (const size of [
      { width: 1280, height: 800 },
      { width: 375, height: 812 },
    ]) {
      await page.setViewportSize(size)
      await page.goto('/')
      await expect(dashRow(page, id)).toBeVisible()
      await page.screenshot({ path: `.tmp/od-repeating-dash-${size.width}.png` })
    }
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/')
    await dashRow(page, id).hover()
    const button = dashRow(page, id).locator('[data-on-deck]')
    await expect(button).toBeVisible()
    await button.click()
    await expect(toast(page, `On deck for today: “${title}”`)).toBeVisible()
    await expect.poll(() => deckOf(page, id)).toBe(await openTaskDay(page))
    expect(await overdueIds(page)).not.toContain(id)
    const section = page.locator('[data-deck-section]')
    await expect(section.locator(`#task-row-${id}`)).toBeVisible()
    await page.screenshot({ path: '.tmp/od-repeating-section-1280.png' })

    // The filled button takes it off deck: the target is back on the occurrence.
    await section.locator(`#task-row-${id}`).hover()
    await section.locator(`#task-row-${id}`).locator('[data-on-deck]').click()
    await expect(toast(page, 'Taken off deck')).toBeVisible()
    await expect.poll(() => deckOf(page, id)).toBeNull()
    expect((await stateOf(page, id)).target_at).toBe(occurrence)
    await expect.poll(() => overdueIds(page)).toContain(id)
    await expect(page.locator('[data-deck-section]')).toHaveCount(0)
  } finally {
    await trash(page, ids)
  }
})
