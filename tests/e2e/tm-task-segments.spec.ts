/**
 * Task segments on the reminders screen, and the dashboard's over-target marks
 * (2026-10-10, docs/TASK-MODEL.md § Deadline, target, horizon).
 *
 * A task created today waits for its segment's next day (creating it counts as
 * seeing it), so each spec makes its tasks with a `days` horizon and moves
 * their `created_at` back a day (`backdateCreated`) — a days segment comes
 * round every day, so they are waiting today at any hour.
 *
 * Isolation: every task is created here under a unique title and trashed in
 * `finally`. Checks read the server back over the API rather than trusting a
 * row leaving the screen.
 */
import path from 'path'
import Database from 'better-sqlite3'
import { DateTime } from 'luxon'
import {
  test,
  expect,
  backdateCreated,
  hideStraySegmentTasks,
  showAllNow,
  uniqueTitle,
} from './fixtures'
import type { Page } from '@playwright/test'

const DAY = 24 * 60 * 60 * 1000

async function create(page: Page, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data })
  expect(res.ok(), `create ${JSON.stringify(data)}`).toBeTruthy()
  return (await res.json()).data.id as number
}

async function stateOf(page: Page, id: number): Promise<Record<string, unknown>> {
  const res = await page.request.get(`/api/tasks/${id}`)
  return (await res.json()).data as Record<string, unknown>
}

async function trash(page: Page, ids: number[]) {
  if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
}

const segmentRow = (page: Page, id: number) =>
  page.locator('[data-task-segments]').locator(`[data-segment-task="${id}"]`)

// Only the segments a test makes: tasks other specs left behind would
// otherwise fill a Weeks segment on a Saturday (the default check-in day) and
// not on other days — see `hideStraySegmentTasks`.
test.beforeEach(() => hideStraySegmentTasks())

test.describe('Task segments', () => {
  test('sit under the slots on /reminders; circle considers, Today targets, Defer all defers', async ({
    authenticatedPage: page,
  }) => {
    const titles = ['A', 'B', 'C'].map((s) => uniqueTitle(`TM seg ${s}`))
    const ids: number[] = []
    for (const title of titles) ids.push(await create(page, { title, horizon: 'days' }))
    backdateCreated(ids, { inSegments: true })
    try {
      await page.goto('/reminders')
      const days = page.locator('[data-task-segment="days"]')
      await expect(days).toBeVisible()
      for (const id of ids) await expect(segmentRow(page, id)).toBeVisible()

      // Under the reminder slots (Trent, 10-11): below the last slot card.
      const slot = page.locator('[data-slot-key]').last()
      if (await slot.count()) {
        const segBox = await days.boundingBox()
        const slotBox = await slot.boundingBox()
        expect(segBox!.y).toBeGreaterThan(slotBox!.y)
      }

      // Circle → considered (never a completion).
      await segmentRow(page, ids[0])
        .getByRole('button', { name: /as considered/ })
        .click()
      // It leaves the list, like a considered reminder, so the next row moves
      // up under the pointer.
      await expect(segmentRow(page, ids[0])).toHaveCount(0)
      await expect.poll(async () => (await stateOf(page, ids[0])).last_considered_at).not.toBeNull()
      expect((await stateOf(page, ids[0])).done).toBe(false)

      // Today → a target today; the row leaves the segment.
      await segmentRow(page, ids[1])
        .getByRole('button', { name: /^Target .* today/ })
        .click()
      await expect(segmentRow(page, ids[1])).toHaveCount(0)
      await expect.poll(async () => (await stateOf(page, ids[1])).target_at).not.toBeNull()

      // Defer all → off today's list, not considered.
      await days.getByRole('button', { name: /^Defer all/ }).click()
      await expect(segmentRow(page, ids[2])).toHaveCount(0)
      await expect
        .poll(async () => (await stateOf(page, ids[2])).segment_deferred_at)
        .not.toBeNull()
      expect((await stateOf(page, ids[2])).last_considered_at).toBeNull()
      // Defer all never touches a row already considered.
      expect((await stateOf(page, ids[0])).segment_deferred_at).toBeNull()
    } finally {
      await trash(page, ids)
    }
  })

  test('counts "X of Y"; Show considered lists the considered rows and puts one back', async ({
    authenticatedPage: page,
  }) => {
    const ids: number[] = []
    for (const s of ['A', 'B']) {
      ids.push(await create(page, { title: uniqueTitle(`TM put back ${s}`), horizon: 'days' }))
    }
    backdateCreated(ids, { inSegments: true })
    try {
      await page.goto('/reminders')
      const days = page.locator('[data-task-segment="days"]')
      // The slot section's header (2026-10-11): "X of Y" and the hairline.
      const count = days.getByLabel(/^\d+ of \d+ considered, \d+ waiting$/)
      await expect(count).toBeVisible()
      const before = (await count.getAttribute('aria-label'))!.match(/^(\d+) of (\d+)/)!
      await expect(days.getByRole('progressbar')).toHaveAttribute('aria-valuenow', before[1])
      await segmentRow(page, ids[0])
        .getByRole('button', { name: /as considered/ })
        .click()
      await expect(segmentRow(page, ids[0])).toHaveCount(0)
      // The considered count climbs; the segment's size stays put.
      await expect(count).toHaveAttribute(
        'aria-label',
        new RegExp(`^${Number(before[1]) + 1} of ${before[2]} considered`),
      )
      await expect(days.getByRole('progressbar')).toHaveAttribute(
        'aria-valuenow',
        String(Number(before[1]) + 1),
      )

      // Folded by default; open it and put the row back.
      const considered = days.locator(`[data-considered-task-id="${ids[0]}"]`)
      await expect(considered).toHaveCount(0)
      await days.locator('[data-segment-considered-toggle]').click()
      await expect(considered).toBeVisible()
      await considered.getByRole('button', { name: /^Put back/ }).click()
      await expect(segmentRow(page, ids[0])).toBeVisible()
      await expect.poll(async () => (await stateOf(page, ids[0])).last_considered_at).toBeNull()

      // The header folds the section like a slot's, and opens it again.
      await days.getByRole('button', { name: /^Task queue · Daily\b/, expanded: true }).click()
      await expect(segmentRow(page, ids[1])).toHaveCount(0)
      await days.getByRole('button', { name: /^Task queue · Daily\b/, expanded: false }).click()
      await expect(segmentRow(page, ids[1])).toBeVisible()
    } finally {
      await trash(page, ids)
    }
  })

  test('the horizon chip changes the horizon', async ({ authenticatedPage: page }) => {
    const id = await create(page, { title: uniqueTitle('TM horizon'), horizon: 'days' })
    backdateCreated([id], { inSegments: true })
    try {
      await page.goto('/reminders')
      await segmentRow(page, id).locator('[data-horizon-chip]').click()
      await page.getByRole('menuitemradio', { name: 'Months' }).click()
      await expect.poll(async () => (await stateOf(page, id)).horizon).toBe('months')
      // It left the days segment, and the toast says where it went (2026-10-11),
      // by the panel's title (2026-10-20).
      await expect(
        page.locator('[data-sonner-toast]', { hasText: 'Moved to Monthly' }),
      ).toBeVisible()
    } finally {
      await trash(page, [id])
    }
  })
})

/**
 * The dashboard: the Reminders card pages through the slots alone, and the
 * task segments have their own Tasks card directly beneath it (2026-10-11,
 * Trent: "i liked the reminders on top of tasks like it was before") — its
 * own pager and strip, "X of Y" with put-back, "Defer all" behind the header
 * tap, opening on the first segment that waits and collapsing to one line
 * when every segment is finished. Each test makes a reminder in the natural
 * slot so the Reminders card is there too.
 */
const TEST_TZ = process.env.E2E_TZ || 'America/Chicago'

/** The slot the panel opens on (`naturalSlotIndex`), and one minute into it. */
async function inNaturalSlot(page: Page): Promise<{ id: number; due: string }> {
  const res = await page.request.get('/api/time-slots')
  const slots = ((await res.json()).data.time_slots as { id: number; start_time: string }[])
    .slice()
    .sort((a, b) => a.start_time.localeCompare(b.start_time))
  const now = DateTime.now().setZone(TEST_TZ)
  const start = (s: { start_time: string }) => {
    const [h, m] = s.start_time.split(':').map(Number)
    return h * 60 + m
  }
  // The latest slot already started, else the first.
  const started = slots.filter((s) => start(s) <= now.hour * 60 + now.minute)
  const natural = started.length ? started[started.length - 1] : slots[0]
  const at = start(natural) + 1
  const due = now
    .set({ hour: Math.floor(at / 60), minute: at % 60, second: 0, millisecond: 0 })
    .toUTC()
    .toISO()!
  return { id: natural.id, due }
}

/**
 * A weeks task created a month ago: its segment (Saturdays) has come round
 * since, so it waits today whatever the weekday.
 */
function createdLongAgo(ids: number[]) {
  const db = new Database(path.join(process.cwd(), 'data', 'test-e2e.db'))
  try {
    const stmt = db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?')
    for (const id of ids) stmt.run(new Date(Date.now() - 30 * DAY).toISOString(), id)
  } finally {
    db.close()
  }
}

const remindersCard = (page: Page) => page.locator('[data-reminders-panel]')
const tasksCard = (page: Page) => page.locator('[data-tasks-panel]')
const cardRow = (page: Page, id: number) => tasksCard(page).locator(`[data-segment-task="${id}"]`)
const consider = (page: Page, id: number) =>
  cardRow(page, id)
    .getByRole('button', { name: /as considered/ })
    .click()

test.describe('Task segments on the dashboard', () => {
  test.use({ viewport: { width: 1600, height: 900 } })

  test('a Tasks card under the Reminders card: its own pager, X of Y, Defer all, then one line', async ({
    authenticatedPage: page,
  }) => {
    const slot = await inNaturalSlot(page)
    const remId = await create(page, {
      title: uniqueTitle('TM card rem'),
      is_reminder: true,
      due_at: slot.due,
    })
    const days = [
      await create(page, { title: uniqueTitle('TM card A'), horizon: 'days' }),
      await create(page, { title: uniqueTitle('TM card B'), horizon: 'days' }),
    ]
    const weeks = await create(page, { title: uniqueTitle('TM card C'), horizon: 'weeks' })
    backdateCreated(days, { inSegments: true })
    createdLongAgo([weeks])
    try {
      await page.goto('/')
      // The Reminders card is the slots alone, as before 2026-10-11.
      await expect(remindersCard(page)).toHaveAttribute('data-reminders-slot', String(slot.id))
      await expect(remindersCard(page).locator('[data-slot-segment^="tasks:"]')).toHaveCount(0)
      await expect(remindersCard(page).locator('[data-segment-task]')).toHaveCount(0)

      // The Tasks card sits directly beneath it, on the first segment waiting.
      const tasks = tasksCard(page)
      await expect(tasks).toHaveAttribute('data-tasks-page', 'tasks:days')
      const remBox = (await remindersCard(page).boundingBox())!
      expect((await tasks.boundingBox())!.y).toBeGreaterThan(remBox.y + remBox.height - 1)
      // Its own strip: one bar per segment — every segment, every day, in
      // its fixed place (2026-10-24; the switch off: no queue pages) — no
      // divider. The empty ones are done.
      const strip = tasks.getByRole('group', { name: "Today's task segments" })
      const bars = strip.getByRole('button')
      const order = ['days', 'upcoming', 'weeks', 'months', 'eventually']
      await expect(bars).toHaveCount(order.length)
      for (let i = 0; i < order.length; i++) {
        await expect(bars.nth(i)).toHaveAttribute('data-slot-segment', `tasks:${order[i]}`)
      }
      for (const empty of ['upcoming', 'months', 'eventually']) {
        await expect(strip.locator(`[data-slot-segment="tasks:${empty}"]`)).toHaveAttribute(
          'data-slot-state',
          'done',
        )
      }
      await expect(strip.locator('[data-segment-divider]')).toHaveCount(0)
      // The header is "Task queue · Daily", nothing after it (2026-10-20).
      const header = tasks.locator('[data-slot-header-toggle]')
      await expect(header).toHaveText('Task queue · Daily')

      // Consider one: "X of Y" climbs and opens it, with its put-back.
      await consider(page, days[0])
      await expect(cardRow(page, days[0])).toHaveCount(0)
      const count = tasks.locator('[data-considered-toggle]')
      await expect(count).toHaveText(/^1 of 2/)
      await count.click()
      const considered = tasks.locator(`[data-considered-task-id="${days[0]}"]`)
      await considered.getByRole('button', { name: /^Put back/ }).click()
      await expect(cardRow(page, days[0])).toBeVisible()
      await expect.poll(async () => (await stateOf(page, days[0])).last_considered_at).toBeNull()

      // The chevrons page through every segment, an empty one included
      // ("Nothing today ✓", 0 of 0 — on Upcoming, in each of its two sections).
      await tasks.getByRole('button', { name: 'Next task segment' }).click()
      await expect(tasks).toHaveAttribute('data-tasks-page', 'tasks:upcoming')
      await expect(tasks.locator('[data-upcoming-section] [data-segment-empty]')).toHaveCount(2)
      await tasks.getByRole('button', { name: 'Next task segment' }).click()
      await expect(tasks).toHaveAttribute('data-tasks-page', 'tasks:weeks')
      await tasks.getByRole('button', { name: 'Previous task segment' }).click()
      await tasks.getByRole('button', { name: 'Previous task segment' }).click()
      await expect(tasks).toHaveAttribute('data-tasks-page', 'tasks:days')

      // Defer all, behind the header tap, finishes Days: on to Weeks, the
      // next with work (past the empty Upcoming).
      await tasks.locator('[data-slot-header-toggle]').click()
      await tasks.getByRole('button', { name: /^Defer all/ }).click()
      await expect(tasks).toHaveAttribute('data-tasks-page', 'tasks:weeks')
      for (const id of days) {
        await expect.poll(async () => (await stateOf(page, id)).segment_deferred_at).not.toBeNull()
      }

      // The last segment finished: one line, never a "Nothing left here" page.
      await consider(page, weeks)
      await expect(tasks).toHaveAttribute('data-tasks-done')
      await expect(tasks.locator('[data-considered-toggle]')).toHaveText(/^3 of 3/)
      await expect(tasks.getByText('Nothing left here')).toHaveCount(0)
      // The Reminders card never moved.
      await expect(remindersCard(page)).toHaveAttribute('data-reminders-slot', String(slot.id))
    } finally {
      await trash(page, [remId, ...days, weeks])
    }
  })

  test('the Tasks card opens on a segment that waits, never on a finished one', async ({
    authenticatedPage: page,
  }) => {
    const days = await create(page, { title: uniqueTitle('TM open days'), horizon: 'days' })
    const weeks = await create(page, { title: uniqueTitle('TM open weeks'), horizon: 'weeks' })
    backdateCreated([days], { inSegments: true })
    createdLongAgo([weeks])
    try {
      // Days is finished (considered today); Weeks still waits.
      await page.request.post('/api/task-segments/consider', { data: { ids: [days] } })
      await page.goto('/')
      await expect(tasksCard(page)).toHaveAttribute('data-tasks-page', 'tasks:weeks')
      await expect(cardRow(page, weeks)).toBeVisible()
    } finally {
      await trash(page, [days, weeks])
    }
  })

  test('/?tasks=<kind> opens the Tasks card on that page and leaves the URL clean', async ({
    authenticatedPage: page,
  }) => {
    // The deadlines nag's tap (`/?tasks=deadlines`, src/lib/tasks-panel-link.ts);
    // any kind works, so Weeks stands in while Days would be the natural page.
    const days = await create(page, { title: uniqueTitle('TM link days'), horizon: 'days' })
    const weeks = await create(page, { title: uniqueTitle('TM link weeks'), horizon: 'weeks' })
    backdateCreated([days], { inSegments: true })
    createdLongAgo([weeks])
    try {
      await page.goto('/?tasks=weeks')
      await expect(tasksCard(page)).toHaveAttribute('data-tasks-page', 'tasks:weeks')
      await expect(cardRow(page, weeks)).toBeVisible()
      await expect.poll(() => new URL(page.url()).search).toBe('')
      // A kind not shown today is consumed and ignored: the natural page.
      await page.goto('/?tasks=deadlines')
      await expect(tasksCard(page)).toHaveAttribute('data-tasks-page', 'tasks:days')
      await expect.poll(() => new URL(page.url()).search).toBe('')
    } finally {
      await trash(page, [days, weeks])
    }
  })

  test('the /reminders day bar shows task segments after the slots, uncounted', async ({
    authenticatedPage: page,
  }) => {
    const slot = await inNaturalSlot(page)
    const remId = await create(page, {
      title: uniqueTitle('TM daybar rem'),
      is_reminder: true,
      due_at: slot.due,
    })
    const taskId = await create(page, { title: uniqueTitle('TM daybar task'), horizon: 'days' })
    backdateCreated([taskId], { inSegments: true })
    try {
      await page.setViewportSize({ width: 375, height: 812 })
      await page.goto('/reminders')
      const headline = page.locator('[data-reminders-headline]')
      const bar = headline.getByRole('group', { name: 'Go to a period' })
      // Every task segment, every day, in its fixed place (2026-10-24; the
      // switch off), after the slots; the empty ones done.
      const segs = bar.locator('[data-day-segment^="tasks:"]')
      const order = ['days', 'upcoming', 'weeks', 'months', 'eventually']
      await expect(segs).toHaveCount(order.length)
      for (let i = 0; i < order.length; i++) {
        await expect(segs.nth(i)).toHaveAttribute('data-day-segment', `tasks:${order[i]}`)
      }
      await expect(bar.locator('[data-day-segment="tasks:days"]')).not.toHaveAttribute(
        'data-day-segment-done',
      )
      await expect(bar.locator('[data-day-segment="tasks:eventually"]')).toHaveAttribute(
        'data-day-segment-done',
        '',
      )
      await expect(bar.locator('[data-segment-divider]')).toHaveCount(1)
      // The task row is not in the day's count: one reminder, nothing else.
      await expect(headline.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '1')
      // A tap goes to the segment's section.
      await bar.locator('[data-day-segment="tasks:days"]').click()
      await expect(page.locator('[data-task-segment="days"]')).toBeInViewport()
    } finally {
      await trash(page, [remId, taskId])
    }
  })
})

test.describe('Dashboard over-target marks', () => {
  // Attempts are local days: the row reads them in the user's zone.
  test.use({ timezoneId: TEST_TZ })
  test('the attempts tab counts local days over target; at 3× the row offers Remove target?', async ({
    authenticatedPage: page,
  }) => {
    // Noon three local days ago: over target on 4 local days (spec §7).
    const threeDaysAgo = DateTime.now()
      .setZone(TEST_TZ)
      .minus({ days: 3 })
      .set({ hour: 12, minute: 0, second: 0, millisecond: 0 })
      .toUTC()
      .toISO()!
    const aged = await create(page, { title: uniqueTitle('TM aged'), target_at: threeDaysAgo })
    const late = await create(page, {
      title: uniqueTitle('TM aged late'),
      target_at: threeDaysAgo,
      deadline_at: new Date(Date.now() - DAY).toISOString(),
    })
    const undated = await create(page, { title: uniqueTitle('TM undated') })
    // On the list (and targeted) for a week, the undated one for 40 days: the
    // API can't create either in the past, and attempts never count from
    // before the task existed or its target was set.
    const db = new Database(path.join(process.cwd(), 'data', 'test-e2e.db'))
    try {
      const backdate = db.prepare('UPDATE tasks SET created_at = ?, target_set_at = ? WHERE id = ?')
      const weekAgo = new Date(Date.now() - 7 * DAY).toISOString()
      for (const id of [aged, late]) backdate.run(weekAgo, weekAgo, id)
      const old = new Date(Date.now() - 40 * DAY).toISOString()
      backdate.run(old, old, undated)
    } finally {
      db.close()
    }
    try {
      await page.goto('/')
      // The undated row is behind its project's fold in Now, and the aged
      // one joins it once its target is removed: lift the folds.
      await showAllNow(page)
      const row = page.locator(`#task-row-${aged}`)
      await expect(row).toBeVisible()
      await expect(row.locator('[data-attempts]')).toHaveText('4×')
      // Past its deadline the tab stays (a count, not a second alarm), and the
      // red deadline chip leads the line (2026-10-22); no offer with the task
      // queue off — removing the target would bring back the passed deadline.
      const lateRow = page.locator(`#task-row-${late}`)
      await expect(lateRow.locator('[data-deadline-chip]')).toHaveAttribute(
        'data-deadline-chip',
        'passed',
      )
      await expect(lateRow.locator('[data-deadline-chip]')).toContainText('Past deadline')
      await expect(lateRow.locator('[data-attempts]')).toHaveText('4×')
      await expect(lateRow.locator('[data-attempts-offer]')).toHaveCount(0)
      // An undated task past a month: the age label, no tab.
      const undatedRow = page.locator(`#task-row-${undated}`)
      await expect(undatedRow.locator('[data-age-label]')).toHaveText('>1 mo')
      await expect(undatedRow.locator('[data-attempts]')).toHaveCount(0)
      // At 3×+ the row offers to drop the target — one tap, never automatic.
      const offer = row.locator('[data-attempts-offer="remove"]')
      await expect(offer).toHaveText('Remove target?')
      await offer.click()
      await expect
        .poll(
          async () => (await (await page.request.get(`/api/tasks/${aged}`)).json()).data.target_at,
        )
        .toBeNull()
      await expect(row.locator('[data-attempts]')).toHaveCount(0)
    } finally {
      await trash(page, [aged, late, undated])
    }
  })
})
