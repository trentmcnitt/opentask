/**
 * EVERY SEGMENT, EVERY DAY (Trent, 2026-10-24: "always show every queue
 * segment, every day, in fixed positions"; docs/TASK-MODEL.md § Task
 * segments). With the task-queue switch on, the web (`?fill=1`) shows all
 * eight segments in `SEGMENT_ORDER` — the deadlines page first — on the
 * dashboard's Tasks card and on /reminders, whether or not they have rows. An
 * empty one is done from the start of the day: green in the strip and the
 * day bar, "0 of 0 ✓", "Nothing today ✓" on its page or section. The card
 * opens on the first segment with work, and its chevrons step through all
 * eight.
 *
 * Its own user (`queue@opentask.local`, as tq-queue-panels): with the switch
 * on, the minute cron's rollover would strip the shared user's past-target
 * one-offs. Here it holds ONE task, a Daily one-off (and, for /reminders' day
 * bar, one reminder). Unique titles; everything trashed in `finally`; the
 * switch off again after the file.
 */
import { test, expect, uniqueTitle } from './fixtures'
import type { Page } from '@playwright/test'

const TZ = process.env.E2E_TZ || 'America/Chicago'
test.use({ timezoneId: TZ })

/** SEGMENT_ORDER (src/lib/task-segments.ts), as the screens key them. */
const ORDER = [
  'deadlines',
  'queue_today',
  'queue_previous',
  'days',
  'upcoming',
  'weeks',
  'months',
  'eventually',
]
const KEYS = ORDER.map((k) => `tasks:${k}`)

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

async function trash(page: Page, ids: number[]) {
  if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
}

/** The user's own open tasks that sit in a segment today — this file wants exactly one. */
async function segmentRowIds(page: Page): Promise<number[]> {
  const res = await page.request.get('/api/reminders?queue=1&deck=1&handled=1&deadlines=1')
  const segs = (await res.json()).data.task_segments as { tasks: { id: number }[] }[]
  return segs.flatMap((s) => s.tasks.map((t) => t.id))
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

const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
]

for (const viewport of VIEWPORTS) {
  test.describe(`at ${viewport.width}`, () => {
    test.use({ viewport })

    test('the dashboard card: all eight in order, empties done, the pager steps through all', async ({
      page,
    }) => {
      const ids: number[] = []
      try {
        ids.push(await create(page, { title: uniqueTitle('SA daily'), horizon: 'days' }))
        // Only one segment has rows (nothing left behind by another spec).
        expect(await segmentRowIds(page)).toEqual(ids)

        await page.goto('/')
        const card = page.locator('[data-tasks-panel]')
        // Opens on the first segment with work, not on the empty deadlines page.
        await expect(card).toHaveAttribute('data-tasks-page', 'tasks:days')
        await expect(card.locator(`[data-segment-task="${ids[0]}"]`)).toBeVisible()

        // The strip: every segment, in the fixed order; the empties done (green).
        const bars = card.locator('[data-slot-segment]')
        await expect(bars).toHaveCount(ORDER.length)
        for (let i = 0; i < KEYS.length; i++) {
          await expect(bars.nth(i)).toHaveAttribute('data-slot-segment', KEYS[i])
          await expect(bars.nth(i)).toHaveAttribute(
            'data-slot-state',
            KEYS[i] === 'tasks:days' ? 'behind' : 'done',
          )
        }

        // Back to the first page: the deadlines page, empty, "Nothing today ✓".
        const prev = card.getByRole('button', { name: 'Previous task segment' })
        const next = card.getByRole('button', { name: 'Next task segment' })
        for (const key of [KEYS[2], KEYS[1], KEYS[0]]) {
          await prev.click()
          await expect(card).toHaveAttribute('data-tasks-page', key)
        }
        await expect(prev).toBeDisabled()
        await expect(card.locator('[data-segment-empty]')).toHaveText('Nothing today')
        await expect(card.getByLabel('0 of 0 considered')).toBeVisible()

        // Forward through every page, in order, to the last.
        for (const key of KEYS.slice(1)) {
          await next.click()
          await expect(card).toHaveAttribute('data-tasks-page', key)
          await expect(card.locator('[data-segment-empty]')).toHaveCount(
            key === 'tasks:days' ? 0 : 1,
          )
        }
        await expect(next).toBeDisabled()
      } finally {
        await trash(page, ids)
      }
    })

    test('/reminders: every section and day-bar segment in order, deadlines first, empties done', async ({
      page,
    }) => {
      const ids: number[] = []
      try {
        ids.push(await create(page, { title: uniqueTitle('SA daily'), horizon: 'days' }))
        // A reminder in every period today, so the headline's day bar has
        // every period's bar before the eight task segments' — the most a
        // phone's bar has to fit.
        const slots = (await (await page.request.get('/api/time-slots')).json()).data
          .time_slots as { start_time: string }[]
        expect(slots.length).toBeGreaterThan(0)
        for (const slot of slots) {
          const [h, m] = slot.start_time.split(':').map(Number)
          ids.push(
            await create(page, {
              title: uniqueTitle('SA reminder'),
              is_reminder: true,
              rrule: `FREQ=DAILY;BYHOUR=${h};BYMINUTE=${m}`,
            }),
          )
        }
        await page.goto('/reminders')

        const sections = page.locator('[data-task-segments] [data-task-segment]')
        await expect(sections).toHaveCount(ORDER.length)
        for (let i = 0; i < ORDER.length; i++) {
          const section = sections.nth(i)
          await expect(section).toHaveAttribute('data-task-segment', ORDER[i])
          if (ORDER[i] === 'days') {
            await expect(section.locator(`[data-segment-task="${ids[0]}"]`)).toBeVisible()
            await expect(section.locator('[data-segment-empty]')).toHaveCount(0)
          } else {
            await expect(section.locator('[data-segment-empty]')).toHaveText('Nothing today')
          }
        }

        const bar = page.locator('[data-reminders-headline] [data-day-segment^="tasks:"]')
        await expect(bar).toHaveCount(ORDER.length)
        for (let i = 0; i < KEYS.length; i++) {
          await expect(bar.nth(i)).toHaveAttribute('data-day-segment', KEYS[i])
          if (KEYS[i] === 'tasks:days') {
            await expect(bar.nth(i)).not.toHaveAttribute('data-day-segment-done')
          } else {
            await expect(bar.nth(i)).toHaveAttribute('data-day-segment-done', '')
          }
        }

        // An empty segment's bar still goes to its section.
        await bar.nth(ORDER.indexOf('eventually')).click()
        await expect(sections.nth(ORDER.indexOf('eventually'))).toBeInViewport()

        // Eight segments after the periods still fit a phone: no sideways scroll.
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        )
        expect(overflow).toBeLessThanOrEqual(0)
      } finally {
        await trash(page, ids)
      }
    })
  })
}
