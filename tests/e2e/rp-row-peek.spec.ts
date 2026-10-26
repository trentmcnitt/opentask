/**
 * Task-segment and queue rows (2026-10-20): the pencil is gone; HOLDING the
 * row opens its PEEK BUBBLE — the dashboard panel's reminder bubble
 * (`RowPeekPopover`): title, the row's meta, the note, Open (the Quick panel)
 * and a trash can (soft delete, Undo). Right-click and Cmd/Ctrl+Enter open it
 * too. A hold never also considers; a scroll-drag never opens it; holding On
 * deck or Today opens THEIR menus. And the one-tap "On deck tomorrow" button
 * in the pencil's place, on a one-off and a repeating row.
 *
 * The queue's own user (`queue@opentask.local`, as od-on-deck.spec.ts), with
 * the server's task-queue switch on (decks need it) and off after the file.
 * Isolation: unique titles, every task trashed in `finally`. Holds are held
 * until what they open shows (`holdUntil`, the CDP touch start), never for a
 * fixed time; the one "nothing happened" check runs the page's clock forward.
 */
import path from 'path'
import Database from 'better-sqlite3'
import { DateTime } from 'luxon'
import { test, expect, openTaskDay, holdUntil, uniqueTitle } from './fixtures'
import type { CDPSession, Locator, Page } from '@playwright/test'

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

/** A `days` one-off made yesterday: it waits in today's Days segment at any hour. */
async function daysTask(page: Page, title: string, extra: Record<string, unknown> = {}) {
  const id = await create(page, { title, horizon: 'days', ...extra })
  sql(
    `UPDATE tasks SET created_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 day') WHERE id = ?`,
    id,
  )
  return id
}

/** The rrule weekday code of an instant in the user's zone. */
function weekdayCode(iso: string): string {
  const day = DateTime.fromISO(iso).setZone(TZ).weekday
  return ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'][day - 1]
}

const segRow = (scope: Page | Locator, id: number) => scope.locator(`[data-segment-task="${id}"]`)
const segment = (page: Page, kind: string) =>
  page.locator('[data-task-segments]').locator(`[data-task-segment="${kind}"]`)
const bubble = (page: Page, id: number) => page.locator(`[data-task-peek="${id}"]`)
const toast = (page: Page, text: string | RegExp) =>
  page.locator('[data-sonner-toast]').filter({ hasText: text })

/** Counts the consider requests the page sends — a hold must send none. */
function countConsiders(page: Page): () => number {
  let n = 0
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/api/task-segments/consider')) n++
  })
  return () => n
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

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('a mouse hold opens the bubble — title, meta, note, Open, trash — and never considers; Open reaches the Quick panel', async ({
    page,
  }) => {
    const ids: number[] = []
    try {
      const title = uniqueTitle('RP held')
      const notes = 'Ask about the second invoice first.'
      const id = await daysTask(page, title, { notes, priority: 3 })
      ids.push(id)
      const considers = countConsiders(page)
      await page.goto('/reminders')
      const r = segRow(segment(page, 'days'), id)
      await expect(r).toBeVisible()
      // The pencil is gone.
      await expect(r.locator('[data-segment-details]')).toHaveCount(0)
      await expect(r).toHaveAttribute('aria-keyshortcuts', 'Meta+Enter Control+Enter')

      await holdUntil(r.getByText(title), () => expect(bubble(page, id)).toBeVisible())
      const b = bubble(page, id)
      await expect(b.getByText(title)).toBeVisible()
      // The row's own meta line, read-only: the project and the priority.
      await expect(b.locator('[data-segment-project]')).toBeVisible()
      await expect(b.locator('[data-segment-priority]')).toHaveText('High')
      await expect(b.locator('button[data-horizon-meta]')).toHaveCount(0)
      await expect(b.getByText(notes)).toBeVisible()
      await expect(b.getByRole('button', { name: `Move "${title}" to Trash` })).toBeVisible()
      // The release's click was swallowed: still waiting, no consider sent.
      await expect(r).toHaveAttribute('data-segment-state', 'waiting')
      expect(considers()).toBe(0)
      expect((await stateOf(page, id)).last_considered_at).toBeNull()

      await b.getByRole('button', { name: 'Open' }).click()
      await expect(b).toHaveCount(0)
      // The Quick panel the pencil used to open.
      const editor = page.getByRole('dialog', { name: 'Quick Actions' })
      await expect(editor).toBeVisible()
      await expect(editor).toContainText(title)
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(r).toHaveAttribute('data-segment-state', 'waiting')
      expect(considers()).toBe(0)
    } finally {
      await trash(page, ids)
    }
  })

  test('right-click and Cmd/Ctrl+Enter open it; a note-less task says so; trash soft-deletes, Undo brings it back', async ({
    page,
  }) => {
    const ids: number[] = []
    try {
      const title = uniqueTitle('RP keys')
      const id = await daysTask(page, title)
      ids.push(id)
      const considers = countConsiders(page)
      await page.goto('/reminders')
      const r = segRow(segment(page, 'days'), id)

      await r.getByText(title).click({ button: 'right' })
      const b = bubble(page, id)
      await expect(b).toBeVisible()
      await expect(b.getByText('No note yet — open it to say what this one is for.')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(b).toHaveCount(0)

      // The keyboard: focus moves into the bubble.
      await r.focus()
      await page.keyboard.press('ControlOrMeta+Enter')
      await expect(b).toBeVisible()
      await expect(b.getByRole('button', { name: 'Open' })).toBeFocused()
      expect(considers()).toBe(0)

      await b.getByRole('button', { name: `Move "${title}" to Trash` }).click()
      await expect(r).toHaveCount(0)
      const t = toast(page, `Moved “${title}” to Trash`)
      await expect(t).toBeVisible()
      await expect.poll(async () => (await stateOf(page, id)).deleted_at ?? null).not.toBeNull()
      await t.getByRole('button', { name: 'Undo' }).click()
      await expect(segRow(segment(page, 'days'), id)).toBeVisible()
      await expect.poll(async () => (await stateOf(page, id)).deleted_at ?? null).toBeNull()
    } finally {
      await trash(page, ids)
    }
  })

  test('holding On deck, On deck tomorrow or Today opens THEIR menu, not the bubble; order and the dashboard panel', async ({
    page,
  }) => {
    const ids: number[] = []
    try {
      const title = uniqueTitle('RP buttons')
      const id = await daysTask(page, title)
      ids.push(id)
      await page.goto('/reminders')
      const r = segRow(segment(page, 'days'), id)
      await expect(r.locator('[data-deck-tomorrow]')).toBeVisible()

      const order = await r
        .locator('[data-deck-tomorrow], [data-on-deck], [data-target-today], [aria-label^="Done"]')
        .evaluateAll((els) =>
          els.map((e) =>
            e.hasAttribute('data-deck-tomorrow')
              ? 'deck-tomorrow'
              : e.hasAttribute('data-on-deck')
                ? 'deck'
                : e.hasAttribute('data-target-today')
                  ? 'today'
                  : 'done',
          ),
        )
      // On deck first (2026-10-21).
      expect(order).toEqual(['deck', 'deck-tomorrow', 'today', 'done'])
      await expect(r.locator('[data-deck-tomorrow]')).toHaveAttribute(
        'title',
        'On deck tomorrow · hold for a day',
      )

      const deckMenu = page.getByRole('menu', { name: 'On deck options' })
      await holdUntil(r.locator('[data-on-deck]'), () => expect(deckMenu).toBeVisible())
      await expect(bubble(page, id)).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(deckMenu).toHaveCount(0)

      const targetMenu = page.getByRole('menu', { name: 'Target options' })
      await holdUntil(r.locator('[data-target-today]'), () => expect(targetMenu).toBeVisible())
      await expect(bubble(page, id)).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(targetMenu).toHaveCount(0)

      // On deck tomorrow's hold and right-click (2026-10-21): On deck's own
      // day menu, never the bubble, and nothing decked until a day is picked.
      await holdUntil(r.locator('[data-deck-tomorrow]'), () => expect(deckMenu).toBeVisible())
      await expect(bubble(page, id)).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(deckMenu).toHaveCount(0)
      await r.locator('[data-deck-tomorrow]').click({ button: 'right' })
      await expect(deckMenu).toBeVisible()
      await expect(deckMenu.getByRole('menuitem', { name: /^Tomorrow/ })).toHaveCount(1)
      await expect(deckMenu.getByRole('menuitem', { name: 'Pick a date…' })).toHaveCount(1)
      await expect(bubble(page, id)).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(deckMenu).toHaveCount(0)
      await expect(r).toHaveAttribute('data-segment-state', 'waiting')
      expect(await deckOf(page, id)).toBeNull()

      // The dashboard's right panel: the same rows, the same bubble.
      await page.setViewportSize({ width: 1600, height: 900 })
      await page.goto('/')
      const card = page.locator('[data-tasks-panel]')
      const next = card.getByRole('button', { name: 'Next task segment' })
      const dashRow = segRow(card, id)
      await expect(card).toBeVisible()
      // Page to the Days segment (the card opens on the first one waiting).
      for (let i = 0; i < 8 && !(await dashRow.isVisible()); i++) {
        if (!(await next.isEnabled())) break
        await next.click()
      }
      await expect(dashRow).toBeVisible()
      await expect(dashRow.locator('[data-segment-details]')).toHaveCount(0)
      await holdUntil(dashRow.getByText(title), () => expect(bubble(page, id)).toBeVisible())
      await expect(dashRow).toHaveAttribute('data-segment-state', 'waiting')
      await bubble(page, id).getByRole('button', { name: 'Open' }).click()
      await expect(page.getByRole('dialog', { name: 'Quick Actions' })).toContainText(title)
    } finally {
      await trash(page, ids)
    }
  })

  test('a hold or right-click on the done square is never the bubble', async ({ page }) => {
    const ids: number[] = []
    try {
      const title = uniqueTitle('RP done')
      const id = await daysTask(page, title)
      ids.push(id)
      await page.clock.install()
      await page.goto('/reminders')
      const r = segRow(segment(page, 'days'), id)
      const done = r.getByRole('button', { name: /^Done: / })
      await expect(done).toBeVisible()
      await done.click({ button: 'right' })
      await expect(bubble(page, id)).toHaveCount(0)
      // Held well past the 400ms with the button down: no bubble mid-hold.
      const box = (await done.boundingBox())!
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.clock.runFor(1500)
      await expect(bubble(page, id)).toHaveCount(0)
      await page.mouse.up()
      // The release is the button's own click: done.
      await expect(r).toHaveCount(0)
      await expect.poll(async () => (await stateOf(page, id)).done).toBe(true)
    } finally {
      await trash(page, ids)
    }
  })

  test('On deck tomorrow: one tap decks a one-off for tomorrow, the row leaves, Undo puts it back', async ({
    page,
  }) => {
    const ids: number[] = []
    try {
      const title = uniqueTitle('RP tomorrow')
      const id = await daysTask(page, title)
      ids.push(id)
      await page.goto('/reminders')
      const r = segRow(segment(page, 'days'), id)
      await r.locator('[data-deck-tomorrow]').click()
      await expect(r).toHaveCount(0)
      const t = toast(page, `On deck for tomorrow: “${title}”`)
      await expect(t).toBeVisible()
      await expect.poll(() => deckOf(page, id)).toBe(await openTaskDay(page, 1))
      await expect(bubble(page, id)).toHaveCount(0)
      await t.getByRole('button', { name: 'Undo' }).click()
      await expect.poll(() => deckOf(page, id)).toBeNull()
      await expect(segRow(segment(page, 'days'), id)).toBeVisible()
    } finally {
      await trash(page, ids)
    }
  })

  test('On deck tomorrow held: picking a day in its menu decks for that day, never considers', async ({
    page,
  }) => {
    const ids: number[] = []
    try {
      const title = uniqueTitle('RP tomorrow held')
      const id = await daysTask(page, title)
      ids.push(id)
      const considers = countConsiders(page)
      await page.goto('/reminders')
      const r = segRow(segment(page, 'days'), id)
      const deckMenu = page.getByRole('menu', { name: 'On deck options' })
      await holdUntil(r.locator('[data-deck-tomorrow]'), () => expect(deckMenu).toBeVisible())
      // The release decks nothing: the hold never also taps.
      await expect(deckMenu).toBeVisible()
      expect(await deckOf(page, id)).toBeNull()
      // The day after tomorrow, by its weekday name (maybe the check-in day).
      const name = DateTime.fromISO(await openTaskDay(page, 2), { zone: TZ }).toFormat('cccc')
      await deckMenu.getByRole('menuitem', { name: new RegExp(`^${name}`) }).click()
      await expect.poll(() => deckOf(page, id)).toBe(await openTaskDay(page, 2))
      await expect(r).toHaveCount(0)
      await expect(bubble(page, id)).toHaveCount(0)
      expect(considers()).toBe(0)
    } finally {
      await trash(page, ids)
    }
  })

  test('On deck tomorrow on a repeating row waiting in the queue: decks the occurrence for tomorrow', async ({
    page,
  }) => {
    const ids: number[] = []
    try {
      const title = uniqueTitle('RP weekly')
      const id = await create(page, {
        title,
        rrule: `FREQ=WEEKLY;BYDAY=${weekdayCode(daysFromNow(3))}`,
        due_at: daysFromNow(3),
      })
      ids.push(id)
      sql(
        'UPDATE tasks SET due_at = ?, occurrence_at = ?, target_set_at = ? WHERE id = ?',
        daysFromNow(-4),
        daysFromNow(-4),
        daysFromNow(-5),
        id,
      )
      const res = await page.request.post('/api/test/rollover', {
        data: { user_id: QUEUE_USER_ID, force: true },
      })
      expect(res.ok(), await res.text()).toBeTruthy()
      const waiting = await stateOf(page, id)
      expect(waiting.queued_at).not.toBeNull()

      await page.goto('/reminders')
      const r = segRow(segment(page, 'queue_today'), id)
      await expect(r.locator('[data-segment-details]')).toHaveCount(0)
      // Its bubble's meta is the row's: the missed occurrence's date, not the
      // moved target.
      const occurrence = DateTime.fromISO(waiting.occurrence_at as string).setZone(TZ)
      await r.locator('p').first().click({ button: 'right' })
      await expect(bubble(page, id).locator('[data-target-chip]')).toContainText(
        occurrence.toFormat('LLL d'),
      )
      await page.keyboard.press('Escape')
      await expect(bubble(page, id)).toHaveCount(0)
      await r.locator('[data-deck-tomorrow]').click()
      await expect(r).toHaveCount(0)
      await expect(toast(page, `On deck for tomorrow: “${title}”`)).toBeVisible()
      await expect.poll(() => deckOf(page, id)).toBe(await openTaskDay(page, 1))
      const decked = await stateOf(page, id)
      expect(decked.queued_at).toBeNull()
      expect(decked.occurrence_at).toBe(waiting.occurrence_at)
    } finally {
      await trash(page, ids)
    }
  })
})

async function touch(
  cdp: CDPSession,
  type: 'touchStart' | 'touchMove' | 'touchEnd',
  points: Array<{ x: number; y: number }>,
) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points })
}

/** A point on the row's title text, in CSS pixels (not on any button). */
async function onTitle(r: Locator, title: string): Promise<{ x: number; y: number }> {
  const text = r.getByText(title)
  await text.scrollIntoViewIfNeeded()
  const box = (await text.boundingBox())!
  return { x: box.x + Math.min(20, box.width / 2), y: box.y + box.height / 2 }
}

test.describe('touch', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    timezoneId: TZ,
  })

  test('a finger hold opens the bubble without considering', async ({ page }) => {
    const ids: number[] = []
    try {
      const title = uniqueTitle('RP touch')
      const id = await daysTask(page, title)
      ids.push(id)
      const considers = countConsiders(page)
      await page.goto('/reminders')
      const r = segRow(segment(page, 'days'), id)
      await expect(r).toBeVisible()
      await expect(r).toHaveCSS('user-select', 'none')

      const cdp = await page.context().newCDPSession(page)
      const at = await onTitle(r, title)
      await touch(cdp, 'touchStart', [at])
      await expect(bubble(page, id)).toBeVisible()
      await touch(cdp, 'touchEnd', [])
      await expect(r).toHaveAttribute('data-segment-state', 'waiting')
      expect(considers()).toBe(0)
      await page.keyboard.press('Escape')
      await expect(bubble(page, id)).toHaveCount(0)
    } finally {
      await trash(page, ids)
    }
  })

  test('a finger hold on On deck tomorrow opens the day sheet, not the bubble; a day decks it', async ({
    page,
  }) => {
    const ids: number[] = []
    try {
      const title = uniqueTitle('RP touch tomorrow')
      const id = await daysTask(page, title)
      ids.push(id)
      const considers = countConsiders(page)
      await page.goto('/reminders')
      const r = segRow(segment(page, 'days'), id)
      const button = r.locator('[data-deck-tomorrow]')
      await expect(button).toBeVisible()
      // The raw touch lands at screen coordinates, so bring the row on screen
      // first: every task segment shows now (2026-10-24), the empty deadlines
      // and queue sections above Daily push it below a phone's fold.
      await button.scrollIntoViewIfNeeded()

      const cdp = await page.context().newCDPSession(page)
      const box = (await button.boundingBox())!
      const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      await touch(cdp, 'touchStart', [at])
      // On a phone the hold menu is a sheet titled "On deck".
      const sheet = page.getByRole('dialog', { name: 'On deck' })
      await expect(sheet).toBeVisible()
      await touch(cdp, 'touchEnd', [])
      await expect(sheet).toBeVisible()
      await expect(bubble(page, id)).toHaveCount(0)
      expect(await deckOf(page, id)).toBeNull()
      const name = DateTime.fromISO(await openTaskDay(page, 2), { zone: TZ }).toFormat('cccc')
      await sheet.getByRole('button', { name: new RegExp(`^${name}`) }).click()
      await expect.poll(() => deckOf(page, id)).toBe(await openTaskDay(page, 2))
      expect(considers()).toBe(0)
    } finally {
      await trash(page, ids)
    }
  })

  test('a drag that starts on a row (a scroll) opens nothing, even held still afterwards', async ({
    page,
  }) => {
    const ids: number[] = []
    try {
      const title = uniqueTitle('RP drag')
      const id = await daysTask(page, title)
      ids.push(id)
      const considers = countConsiders(page)
      await page.clock.install()
      await page.goto('/reminders')
      const r = segRow(segment(page, 'days'), id)
      await expect(r).toBeVisible()
      const cdp = await page.context().newCDPSession(page)
      const at = await onTitle(r, title)
      await touch(cdp, 'touchStart', [at])
      await touch(cdp, 'touchMove', [{ x: at.x, y: at.y - 30 }])
      // Well past the hold's 400ms with the finger still down: nothing opens.
      await page.clock.runFor(1500)
      await expect(bubble(page, id)).toHaveCount(0)
      await touch(cdp, 'touchEnd', [])
      await page.clock.runFor(500)
      await expect(bubble(page, id)).toHaveCount(0)
      await expect(segRow(page, id)).toHaveAttribute('data-segment-state', 'waiting')
      expect(considers()).toBe(0)
    } finally {
      await trash(page, ids)
    }
  })
})
