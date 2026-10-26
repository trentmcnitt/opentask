/**
 * The Defer FAB with a selection (Trent, 2026-10-26): it stays in selection
 * mode, shows the selected count, and a tap defers the SELECTION — to the
 * same default Defer all uses (the next period) — instead of every overdue
 * task. A defer only ever moves a target later: a selected task already due
 * later, or with no target, is left alone and counted in the toast, and a
 * press with nothing to move sends no request at all.
 *
 * Each test makes its own tasks under unique titles and trashes them again;
 * only those tasks are ever selected, so the shared user's seeded overdue
 * tasks are never moved (the unselected overdue probe below checks it).
 * Runs in the Unified view so every row is on the page whatever grouping the
 * earlier specs left behind (see selection-fab.spec.ts).
 *
 * THE CLOCKS ARE PINNED (2026-10-26). A plain press defers to "the next
 * period", which the browser works out at the press; this spec used to work
 * its expected time out again from its own clock after the press, so a period
 * starting in between (seconds at most, but at any of the day's period starts)
 * made the two disagree. Now every expected time comes from one instant,
 * `PIN`: the server's clock is pinned to it (POST /api/test/clock, running on
 * from there) and the browser's Date is FIXED at it (`page.clock.setFixedTime`,
 * timers still running), so the press resolves "next period" from exactly the
 * instant the spec does, however near a period start the pin is. The pin is
 * the most recent 10:30 in the user's zone at or before real now (never ahead:
 * the cron jobs compute on the shifted clock), mid-Morning, so the server's
 * running clock is never near a period start either. The task rollover is
 * stamped first, and the real clock goes back after each test, in afterAll and
 * in the global teardown.
 */

import {
  test,
  expect,
  cmdClickRow,
  uniqueTitle,
  waitForPrefsLoaded,
  withPreferences,
} from './fixtures'
import type { APIRequestContext, Page } from '@playwright/test'
import { DateTime } from 'luxon'
import { addDays, openTaskDayOf } from '@/lib/opentask-day'

const TEST_TZ = process.env.E2E_TZ || 'America/Chicago'

/** The most recent 10:30 in the user's zone, at or before real now. */
function midMorning(): DateTime {
  const now = DateTime.now().setZone(TEST_TZ)
  const at = now.set({ hour: 10, minute: 30, second: 0, millisecond: 0 })
  return at > now ? at.minus({ days: 1 }) : at
}

const PIN = midMorning()

/** Pin the server's clock (null: the real one). */
async function setClock(request: APIRequestContext, now: string | null) {
  const res = await request.post('/api/test/clock', { data: { now } })
  expect(res.ok(), await res.text()).toBeTruthy()
}

const row = (page: Page, id: number) => page.locator(`#task-row-${id}`)
const bar = (page: Page) => page.locator('[data-selection-sheet]')
const fab = (page: Page) => page.locator('[data-snooze-all-fab]')

async function createTask(
  page: Page,
  title: string,
  fields: { priority?: number; due_at?: string | null } = {},
): Promise<number> {
  const res = await page.request.post('/api/tasks', {
    data: { title, priority: 1, ...fields },
  })
  expect(res.ok(), await res.text()).toBeTruthy()
  return (await res.json()).data.id as number
}

async function dueAt(page: Page, id: number): Promise<string | null> {
  const res = await page.request.get(`/api/tasks/${id}`)
  return (await res.json()).data.due_at as string | null
}

/** The soonest slot start after `now`, as a plain press resolves "next period". */
async function nextPeriodMillis(page: Page, now: DateTime): Promise<number> {
  const slots = (await (await page.request.get('/api/time-slots')).json()).data.time_slots as {
    start_time: string
  }[]
  return Math.min(
    ...slots.map((s) => {
      const [h, m] = s.start_time.split(':').map(Number)
      const today = now.set({ hour: h, minute: m, second: 0, millisecond: 0 })
      return (today > now ? today : today.plus({ days: 1 })).toMillis()
    }),
  )
}

const byNumber = (a: number, b: number) => a - b
const millis = (iso: string | null) => (iso ? DateTime.fromISO(iso).toMillis() : null)

interface Probes {
  /** Selected, overdue, Medium-or-lower: moves. */
  overdue: number
  /** Selected, overdue, High: moves too — a selection holds no priority back. */
  high: number
  /** Selected, due tomorrow (after the next period): skipped, "already later". */
  tomorrow: number
  /** Selected, no target: skipped, "has no target". */
  undated: number
  /** NOT selected, overdue: stays overdue. */
  unselected: number
}

/** Make the five probes, open the dashboard on them, run `body`, trash them. */
async function withProbes(page: Page, body: (p: Probes, tomorrowDue: string) => Promise<void>) {
  // Both clocks on the pin before anything is made (see the file docblock).
  const stamp = await page.request.post('/api/test/rollover', { data: {} })
  expect(stamp.ok(), await stamp.text()).toBeTruthy()
  await setClock(page.request, PIN.toUTC().toISO())
  await page.clock.setFixedTime(PIN.toJSDate())
  const ago = (h: number) => PIN.minus({ hours: h }).toUTC().toISO()!
  // "Tomorrow" is the OpenTask day after the pin's, at noon — or an hour after
  // the next period if that is later still, so it is always later than the
  // time a plain press defers to.
  const prefs = await page.request.get('/api/user/preferences')
  const { rollover_time } = (await prefs.json()).data as { rollover_time: string }
  const tomorrow = addDays(openTaskDayOf(PIN.toJSDate(), TEST_TZ, rollover_time), 1)
  const tomorrowNoon = DateTime.fromISO(`${tomorrow}T12:00`, { zone: TEST_TZ })
  const tomorrowDue = DateTime.fromMillis(
    Math.max(tomorrowNoon.toMillis(), (await nextPeriodMillis(page, PIN)) + 60 * 60 * 1000),
  )
    .toUTC()
    .toISO()!
  const ids: number[] = []
  const make = async (title: string, fields: { priority?: number; due_at?: string | null }) => {
    const id = await createTask(page, uniqueTitle(title), fields)
    ids.push(id)
    return id
  }
  try {
    const probes: Probes = {
      overdue: await make('Defer sel overdue', { due_at: ago(2) }),
      high: await make('Defer sel high', { priority: 3, due_at: ago(3) }),
      tomorrow: await make('Defer sel tomorrow', { due_at: tomorrowDue }),
      undated: await make('Defer sel undated', { due_at: null }),
      unselected: await make('Defer sel unselected', { due_at: ago(2) }),
    }
    await withPreferences(
      page,
      { default_grouping: 'unified', bulk_snooze_default: 'next_period' },
      async () => {
        await waitForPrefsLoaded(page, () => page.goto('/'), row(page, probes.overdue))
        await body(probes, tomorrowDue)
      },
    )
  } finally {
    if (ids.length > 0) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
    await setClock(page.request, null)
  }
}

test.afterAll(async ({ request }) => {
  await setClock(request, null)
})

test.describe('The Defer FAB with a selection', () => {
  test.use({ viewport: { width: 1280, height: 900 } })

  test('stays with the selected count; a tap defers only the selected tasks due before the defer time', async ({
    authenticatedPage: page,
  }) => {
    await withProbes(page, async (p, tomorrowDue) => {
      const unselectedBefore = await dueAt(page, p.unselected)
      for (const id of [p.overdue, p.high, p.tomorrow, p.undated]) await cmdClickRow(row(page, id))
      await expect(bar(page)).toContainText('4 selected')

      // The FAB stays, counting the selection, and says so.
      await expect(fab(page)).toBeVisible()
      await expect(fab(page)).toHaveAccessibleName('Defer 4 selected (hold for options)')
      await expect(fab(page).locator('[data-snooze-selected-count]')).toHaveText('4')
      // The selection bar has no Defer of its own.
      await expect(bar(page).getByRole('button', { name: /defer/i })).toHaveCount(0)

      const sent = page.waitForRequest(
        (r) => r.url().endsWith('/api/tasks/bulk/snooze') && r.method() === 'POST',
      )
      const answered = page.waitForResponse(
        (r) => r.url().endsWith('/api/tasks/bulk/snooze') && r.request().method() === 'POST',
      )
      await fab(page).click()
      const body = (await sent).postDataJSON() as {
        ids: number[]
        include_task_ids: number[]
        source: string
        until: string
      }
      expect((await answered).ok()).toBeTruthy()

      // Only the two whose target is before the defer time are sent — one
      // request, priority held back from neither.
      expect([...body.ids].sort(byNumber)).toEqual([p.overdue, p.high].sort(byNumber))
      expect([...body.include_task_ids].sort(byNumber)).toEqual([p.overdue, p.high].sort(byNumber))
      expect(body.source).toBe('sweep')

      const toast = page.locator('[data-sonner-toast]').filter({ hasText: /^Deferred 2 tasks/ })
      await expect(toast).toContainText('Deferred 2 tasks · 1 already later · 1 has no target')

      // The same default Defer all uses: the next period.
      const next = await nextPeriodMillis(page, PIN)
      expect(millis(body.until)).toBe(next)
      expect(millis(await dueAt(page, p.overdue))).toBe(next)
      expect(millis(await dueAt(page, p.high))).toBe(next)
      // The later one and the undated one are untouched, and so is the
      // overdue task that was not selected.
      expect(millis(await dueAt(page, p.tomorrow))).toBe(millis(tomorrowDue))
      expect(await dueAt(page, p.undated)).toBeNull()
      expect(await dueAt(page, p.unselected)).toBe(unselectedBefore)
      expect(millis(unselectedBefore)!).toBeLessThan(PIN.toMillis())

      // The selection clears once the defer went through; the FAB is back to Defer all.
      await expect(bar(page)).toHaveCount(0)
      await expect(fab(page).locator('[data-snooze-selected-count]')).toHaveCount(0)

      // One undo entry takes both back.
      await toast.getByRole('button', { name: 'Undo' }).click()
      await expect
        .poll(async () => millis(await dueAt(page, p.overdue))!)
        .toBeLessThan(PIN.toMillis())
      await expect.poll(async () => millis(await dueAt(page, p.high))!).toBeLessThan(PIN.toMillis())
    })
  })

  test('with nothing due before the defer time, no request is sent and the toast says why', async ({
    authenticatedPage: page,
  }) => {
    await withProbes(page, async (p, tomorrowDue) => {
      const snoozes: string[] = []
      page.on('request', (r) => {
        if (r.method() === 'POST' && r.url().includes('/api/tasks/bulk/')) snoozes.push(r.url())
      })
      await cmdClickRow(row(page, p.tomorrow))
      await expect(fab(page).locator('[data-snooze-selected-count]')).toHaveText('1')

      await fab(page).click()
      await expect(
        page
          .locator('[data-sonner-toast]')
          .filter({ hasText: 'Nothing to defer: 1 already later' }),
      ).toBeVisible()
      // Nothing happened, so the selection stays to act on.
      await expect(row(page, p.tomorrow)).toHaveAttribute('aria-selected', 'true')
      expect(snoozes).toEqual([])
      expect(millis(await dueAt(page, p.tomorrow))).toBe(millis(tomorrowDue))
    })
  })
})

test.describe('The Defer FAB with a selection on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test('stays above the selection bar, counting the selection', async ({
    authenticatedPage: page,
  }) => {
    await withProbes(page, async (p) => {
      await cmdClickRow(row(page, p.overdue))
      await cmdClickRow(row(page, p.high))
      await expect(bar(page)).toContainText('2 selected')
      await expect(fab(page)).toBeVisible()
      await expect(fab(page).locator('[data-snooze-selected-count]')).toHaveText('2')
      // The column lifts clear of the bar instead of sitting on its right end
      // — and of Clear, the X on the bar's top-right corner, which stands
      // above the bar's box, under the column (2026-10-26).
      await expect
        .poll(async () => {
          const f = (await fab(page).boundingBox())!
          const b = (await bar(page).boundingBox())!
          const c = (await bar(page)
            .getByRole('button', { name: 'Clear selection' })
            .boundingBox())!
          return f.y + f.height <= Math.min(b.y, c.y)
        })
        .toBe(true)
    })
  })
})
