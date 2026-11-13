/**
 * The dashboard Reminders card's hand-off (2026-11-13; RULES
 * PAGER-FINISH-BEAT, PAGER-CLOCK-TAKEOVER, PAGER-HELD in
 * src/lib/panel-pager.ts and src/hooks/usePanelPager.ts): a finished page
 * shows for its beat and then moves on, a period opening takes a finished
 * page and never one with rows waiting, and a held card moves when the hold
 * ends. The Task queue card runs the same state (`settlePager`), pinned in
 * tests/behavioral/dv-pager-handoff.test.ts.
 *
 * Both clocks are pinned (tq-late-night.spec.ts has the why): the server's
 * through POST /api/test/clock, at the most recent such instant at or before
 * real now, and the browser's through `page.clock`, PAUSED once the card is
 * drawn, so a beat ends and a period opens exactly when a test says
 * (`runFor`, `fastForward`). Only the browser's clock is moved on, by minutes.
 */
import { DateTime } from 'luxon'
import { test, expect, uniqueTitle } from './fixtures'
import type { APIRequestContext, Page } from '@playwright/test'

const TZ = process.env.E2E_TZ || 'America/Chicago'
test.use({ timezoneId: TZ })
test.describe.configure({ mode: 'serial' })

interface Slot {
  id: number
  start_time: string
}

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/** The most recent time the local clock read `minutes` past midnight, at or before real now. */
function mostRecent(minutes: number): DateTime {
  const now = DateTime.now().setZone(TZ)
  const at = now.startOf('day').plus({ minutes })
  return at > now ? at.minus({ days: 1 }) : at
}

async function setClock(request: APIRequestContext, now: string | null) {
  const res = await request.post('/api/test/clock', { data: { now } })
  expect(res.ok(), await res.text()).toBeTruthy()
}

/** The day's first two periods, in start order. */
async function firstTwoSlots(page: Page): Promise<[Slot, Slot]> {
  const res = await page.request.get('/api/time-slots')
  const slots = ((await res.json()).data.time_slots as Slot[])
    .slice()
    .sort((a, b) => minutesOf(a.start_time) - minutesOf(b.start_time))
  expect(slots.length).toBeGreaterThanOrEqual(2)
  // Room before the second one opens for a pin inside the first.
  expect(minutesOf(slots[1].start_time) - minutesOf(slots[0].start_time)).toBeGreaterThan(5)
  return [slots[0], slots[1]]
}

/** Pin both clocks at `pin` (the browser's paused), stamping the rollover first. */
async function pinClocks(page: Page, pin: DateTime) {
  const stamp = await page.request.post('/api/test/rollover', { data: {} })
  expect(stamp.ok(), await stamp.text()).toBeTruthy()
  await setClock(page.request, pin.toUTC().toISO())
  await page.clock.install({ time: pin.toJSDate() })
}

/**
 * Open the dashboard and, once the card is drawn, pause the browser's clock
 * (the page's own loading runs on timers, so it loads on a running clock).
 */
async function openPaused(page: Page, pin: DateTime) {
  await page.goto('/')
  await expect(card(page)).toBeVisible()
  await page.clock.pauseAt(pin.plus({ seconds: 30 }).toJSDate())
}

/** A reminder a minute into `slot` on the pinned day. */
async function reminderIn(page: Page, slot: Slot, pin: DateTime, title: string): Promise<number> {
  const due = pin.startOf('day').plus({ minutes: minutesOf(slot.start_time) + 1 })
  const res = await page.request.post('/api/tasks', {
    data: { is_reminder: true, title, due_at: due.toUTC().toISO() },
  })
  expect(res.ok(), await res.text()).toBeTruthy()
  return (await res.json()).data.id as number
}

async function trash(page: Page, ids: number[]) {
  for (const id of ids) await page.request.delete(`/api/tasks/${id}`)
}

const card = (page: Page) => page.locator('[data-reminders-panel]')
const onSlot = (page: Page, slot: Slot) =>
  expect(card(page)).toHaveAttribute('data-reminders-slot', String(slot.id))
const consider = (page: Page, title: string) =>
  card(page)
    .getByRole('button', { name: `Mark "${title}" as considered` })
    .click()

test.describe('Dashboard pager hand-off', () => {
  test.afterEach(async ({ authenticatedPage: page }) => {
    await setClock(page.request, null)
  })

  test('PAGER-FINISH-BEAT: the finished page shows for its beat, then the earliest waiting period; Undo brings the card back', async ({
    authenticatedPage: page,
  }) => {
    const [first, second] = await firstTwoSlots(page)
    const pin = mostRecent(minutesOf(second.start_time) + 2)
    await pinClocks(page, pin)
    const early = uniqueTitle('Synthetic kettle')
    const late = uniqueTitle('Synthetic lantern')
    const ids = [
      await reminderIn(page, first, pin, early),
      await reminderIn(page, second, pin, late),
    ]
    try {
      await openPaused(page, pin)
      await onSlot(page, second)
      await consider(page, late)
      // The beat: the finished page is in view, its count done, until 1 s is up.
      await expect(card(page).getByText(late)).toBeHidden()
      await expect(card(page).getByText('1 of 1')).toBeVisible()
      await page.clock.runFor(900)
      await onSlot(page, second)
      await page.clock.runFor(200)
      await onSlot(page, first)
      await expect(card(page).getByText(early)).toBeVisible()

      // Undo: the row is back, and the card is back on its page.
      await page.getByRole('button', { name: 'Undo', exact: true }).first().click()
      await onSlot(page, second)
      await expect(card(page).getByText(late)).toBeVisible()
    } finally {
      await trash(page, ids)
    }
  })

  test('PAGER-FINISH-BEAT: a page turned by hand during the beat cancels the move', async ({
    authenticatedPage: page,
  }) => {
    const [first, second] = await firstTwoSlots(page)
    const pin = mostRecent(minutesOf(second.start_time) + 2)
    await pinClocks(page, pin)
    const early = uniqueTitle('Synthetic kettle')
    const late = uniqueTitle('Synthetic lantern')
    const ids = [
      await reminderIn(page, first, pin, early),
      await reminderIn(page, second, pin, late),
    ]
    try {
      await openPaused(page, pin)
      await onSlot(page, second)
      await consider(page, late)
      await expect(card(page).getByText('1 of 1')).toBeVisible()
      await card(page).getByRole('button', { name: 'Next time slot' }).click()
      const turnedTo = await card(page).getAttribute('data-reminders-slot')
      expect(turnedTo).not.toBe(String(second.id))
      await page.clock.runFor(3000)
      await expect(card(page)).toHaveAttribute('data-reminders-slot', String(turnedTo))
    } finally {
      await trash(page, ids)
    }
  })

  test('PAGER-CLOCK-TAKEOVER: a period opening takes a finished page the card was parked on; one with rows waiting stays until it is finished', async ({
    authenticatedPage: page,
  }) => {
    const [first, second] = await firstTwoSlots(page)
    const pin = mostRecent(minutesOf(second.start_time) - 2)
    await pinClocks(page, pin)
    const early = uniqueTitle('Synthetic kettle')
    const late = uniqueTitle('Synthetic lantern')
    const ids = [
      await reminderIn(page, first, pin, early),
      await reminderIn(page, second, pin, late),
    ]
    try {
      await openPaused(page, pin)
      await onSlot(page, first)
      // Rows waiting on the page in view: the second period opening leaves it.
      await page.clock.fastForward('03:00')
      await expect(card(page).locator(`[data-slot-segment="${second.id}"]`)).toBeVisible()
      await onSlot(page, first)
      await expect(card(page).getByText(early)).toBeVisible()
      // Finishing it then moves on to the opened period.
      await consider(page, early)
      await page.clock.runFor(1100)
      await onSlot(page, second)
    } finally {
      await trash(page, ids)
    }
  })

  test('PAGER-CLOCK-TAKEOVER: parked by hand on a finished page, the card goes to the period that opens, by the timer and on coming back', async ({
    authenticatedPage: page,
  }) => {
    const [first, second] = await firstTwoSlots(page)
    const pin = mostRecent(minutesOf(second.start_time) - 2)
    await pinClocks(page, pin)
    const late = uniqueTitle('Synthetic lantern')
    const ids = [await reminderIn(page, second, pin, late)]
    try {
      // By the timer: paged ahead and back, so the card holds the first period.
      await openPaused(page, pin)
      await onSlot(page, first)
      await card(page).getByRole('button', { name: 'Next time slot' }).click()
      await onSlot(page, second)
      await card(page).getByRole('button', { name: 'Previous time slot' }).click()
      await onSlot(page, first)
      await page.clock.fastForward('03:00')
      await onSlot(page, second)
      await expect(card(page).getByText(late)).toBeVisible()

      // On coming back: the clock jumps with no timer run (a sleeping Mac),
      // and the window's focus is what tells the card.
      await page.clock.setSystemTime(pin.toJSDate())
      await page.clock.resume()
      await openPaused(page, pin)
      await onSlot(page, first)
      await card(page).getByRole('button', { name: 'Next time slot' }).click()
      await card(page).getByRole('button', { name: 'Previous time slot' }).click()
      await onSlot(page, first)
      await page.clock.setSystemTime(pin.plus({ minutes: 3 }).toJSDate())
      await onSlot(page, first)
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await onSlot(page, second)
    } finally {
      await trash(page, ids)
    }
  })

  test('PAGER-HELD: with the considered rows open the card does not move; it does when they close', async ({
    authenticatedPage: page,
  }) => {
    const [first, second] = await firstTwoSlots(page)
    const pin = mostRecent(minutesOf(second.start_time) - 2)
    await pinClocks(page, pin)
    const early = uniqueTitle('Synthetic kettle')
    const late = uniqueTitle('Synthetic lantern')
    const ids = [
      await reminderIn(page, first, pin, early),
      await reminderIn(page, second, pin, late),
    ]
    try {
      await openPaused(page, pin)
      await onSlot(page, first)
      await consider(page, early)
      // Nothing opened waits: after its beat the card stays on the finished page.
      await page.clock.runFor(1100)
      await onSlot(page, first)
      await card(page).locator('[data-considered-toggle]').click()
      await expect(card(page).getByText(early)).toBeVisible()
      await page.clock.fastForward('03:00')
      await expect(card(page).locator(`[data-slot-segment="${second.id}"]`)).toBeVisible()
      await onSlot(page, first)
      await card(page).locator('[data-considered-toggle]').click()
      await onSlot(page, second)
    } finally {
      await trash(page, ids)
    }
  })
})
