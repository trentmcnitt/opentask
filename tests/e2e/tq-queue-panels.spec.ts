/**
 * The task queue's panels on the web (task-queue PR 3; docs/TASK-MODEL.md
 * § The task queue): "Queued" (stripped by this OpenTask day's rollover)
 * and "Previously queued" (stripped before), first
 * among the task segments, with the switch on (`POST /api/test/task-queue`).
 *
 * Its own user (`queue@opentask.local`, seeded in globalSetup with nothing
 * but an Inbox): the rollover strips every below-High one-off left on a
 * previous day's target, which on the shared user would take targets off
 * tasks other specs rely on. Every rollover here runs for this user only,
 * with `force` (the route sets the user's last rollover to the day before, so
 * the run happens whatever the minute cron already stamped).
 *
 * A rollover only touches a task whose target was set before its moment, so
 * each task the rollover should strip has its `target_set_at` backdated in
 * the E2E database (the API stamps now). Clock-independent: every target is
 * days in the past, and the "earlier" strip runs as of two days ago.
 *
 * Isolation: unique titles, every task trashed in `finally`; the switch is
 * turned off again after the file.
 */
import path from 'path'
import Database from 'better-sqlite3'
import { DateTime } from 'luxon'
import { test, expect, uniqueTitle, withPreferences } from './fixtures'
import type { Locator, Page } from '@playwright/test'

const QUEUE_USER_ID = 2
const TEST_TZ = process.env.E2E_TZ || 'America/Chicago'
const DAY = 24 * 60 * 60 * 1000
const daysFromNow = (n: number) => new Date(Date.now() + n * DAY).toISOString()

/** The RRULE weekday of an instant in the user's zone: "MO" … "SU". */
function weekdayCode(iso: string): string {
  const day = DateTime.fromISO(iso).setZone(TEST_TZ).weekday
  return ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'][day - 1]
}

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

function backdateTargetSet(ids: number[], days: number) {
  for (const id of ids)
    sql('UPDATE tasks SET target_set_at = ? WHERE id = ?', daysFromNow(-days), id)
}

async function rollover(page: Page, now?: string) {
  const res = await page.request.post('/api/test/rollover', {
    data: { user_id: QUEUE_USER_ID, force: true, ...(now ? { now } : {}) },
  })
  expect(res.ok(), await res.text()).toBeTruthy()
}

/**
 * Strip one-offs into the queue: `earlier` as of two days ago, `today` as of
 * now. Each is a one-off over target by days, its target set before the
 * rollover that strips it.
 */
async function strip(
  page: Page,
  { earlier = [], today = [] }: { earlier?: number[]; today?: number[] },
) {
  if (earlier.length) {
    backdateTargetSet(earlier, 5)
    await rollover(page, daysFromNow(-2))
  }
  if (today.length) {
    backdateTargetSet(today, 3)
    await rollover(page)
  }
}

const panel = (page: Page, kind: 'queue_today' | 'queue_previous') =>
  page.locator('[data-task-segments]').locator(`[data-task-segment="${kind}"]`)
const row = (scope: Page | Locator, id: number) => scope.locator(`[data-segment-task="${id}"]`)

/**
 * A task-segment row's details (2026-10-20, the pencil gone): right-click the
 * row's title for its peek bubble, then the bubble's Open.
 */
async function openDetails(row: Locator) {
  const page = row.page()
  await row.locator('p').first().click({ button: 'right' })
  await page.locator('[data-task-peek]').getByRole('button', { name: 'Open' }).click()
}
const toastUndo = (page: Page) =>
  page.locator('[data-sonner-toast]').getByRole('button', { name: 'Undo' })

// One user and one server-wide switch: run in order.
test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  await signIn(page)
  await setQueue(page, true)
})
test.afterAll(async ({ request }) => {
  await request.post('/api/test/task-queue', { data: { enabled: false } })
})

test('both panels after a test rollover, first, with the Try Tomorrow mark', async ({ page }) => {
  const ids: number[] = []
  try {
    const old = await create(page, { title: uniqueTitle('TQ old'), due_at: daysFromNow(-4) })
    const weekly = await create(page, {
      title: uniqueTitle('TQ weekly'),
      rrule: `FREQ=WEEKLY;BYDAY=${weekdayCode(daysFromNow(3))}`,
      due_at: daysFromNow(3),
    })
    ids.push(old, weekly)
    // The weekly task's last occurrence was four days ago: at the rollover
    // two days ago it has no occurrence that day, so it waits in the queue.
    // Made six days ago, so the days it sat over target count as attempts.
    sql(
      'UPDATE tasks SET due_at = ?, occurrence_at = ?, created_at = ? WHERE id = ?',
      daysFromNow(-4),
      daysFromNow(-4),
      daysFromNow(-6),
      weekly,
    )
    await strip(page, { earlier: [old, weekly] })

    const fresh = await create(page, {
      title: uniqueTitle('TQ fresh'),
      due_at: daysFromNow(-2),
      priority: 2,
    })
    const tryTomorrow = await create(page, {
      title: uniqueTitle('TQ try'),
      due_at: daysFromNow(-1),
    })
    ids.push(fresh, tryTomorrow)
    const tt = await page.request.post('/api/tasks/bulk/snooze', {
      data: { ids: [tryTomorrow], source: 'try_tomorrow' },
    })
    expect(tt.ok()).toBeTruthy()
    await strip(page, { today: [fresh, tryTomorrow] })
    // Made 40 days ago: an undated task past the weeks threshold has an age
    // badge (">1 mo") everywhere but the queue.
    sql(
      `UPDATE tasks SET created_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-40 days') WHERE id = ?`,
      old,
    )

    await page.goto('/reminders')
    const today = panel(page, 'queue_today')
    const earlier = panel(page, 'queue_previous')
    await expect(today).toBeVisible()
    await expect(earlier).toBeVisible()
    // "Task queue · <word>", nothing after it (Trent, 2026-10-20).
    await expect(today).toHaveAttribute('aria-label', "Task queue · Today's pulls")
    await expect(earlier).toHaveAttribute('aria-label', 'Task queue · Previous pulls')
    await expect(today.getByText("Task queue · Today's pulls", { exact: true })).toBeVisible()
    await expect(earlier.getByText('Task queue · Previous pulls', { exact: true })).toBeVisible()
    await expect(today.getByText('Stripped today')).toHaveCount(0)
    await expect(earlier.getByText('Previously targeted')).toHaveCount(0)
    // First among the task segments after the deadlines page, which always
    // leads — shown every day, empty or not (2026-10-24).
    const kinds = await page
      .locator('[data-task-segments] > [data-task-segment]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-task-segment')))
    expect(kinds.slice(0, 3)).toEqual(['deadlines', 'queue_today', 'queue_previous'])

    // Priority first: the Medium strip above the Try Tomorrow row, which
    // carries the left-edge mark and is not lifted to the top.
    const todayIds = await today
      .locator('[data-segment-task]')
      .evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-segment-task'))))
    expect(todayIds).toEqual([fresh, tryTomorrow])
    await expect(row(today, tryTomorrow).locator('[data-try-tomorrow]')).toBeVisible()
    await expect(row(today, fresh).locator('[data-try-tomorrow]')).toHaveCount(0)
    await expect(row(earlier, old)).toBeVisible()
    await expect(row(earlier, weekly)).toBeVisible()
    // The waiting weekly task names its schedule.
    await expect(row(earlier, weekly)).toContainText(/weekly|every/i)
    // No badges on any queue row (designer ruling): no attempts, though the
    // waiting weekly task has a target and attempts behind it, and no age.
    expect((await stateOf(page, weekly)).attempts as number).toBeGreaterThan(0)
    expect((await stateOf(page, old)).age_label).not.toBeNull()
    for (const p of [today, earlier]) {
      await expect(p.locator('[data-attempts]')).toHaveCount(0)
      await expect(p.locator('[data-age-label]')).toHaveCount(0)
    }

    // The dashboard's right panel opens on the queue too.
    await page.goto('/')
    await expect(page.locator('[data-tasks-panel]')).toHaveAttribute(
      'data-tasks-page',
      'tasks:queue_today',
    )
  } finally {
    await trash(page, ids)
  }
})

test('a waiting repeating row and its details show the occurrence, not the moved target', async ({
  page,
}) => {
  // Trent, 2026-10-20: "Oct 23 · every Fri at 4 PM" and "Target Fri Oct 23 ·
  // in 3 days / Occurrence Fri Oct 16 · target moved" — "What does that even
  // mean?" The row stands for the occurrence it missed; it shows that date.
  const ids: number[] = []
  try {
    const weekly = await create(page, {
      title: uniqueTitle('TQ waiting'),
      rrule: `FREQ=WEEKLY;BYDAY=${weekdayCode(daysFromNow(3))}`,
      due_at: daysFromNow(3),
    })
    ids.push(weekly)
    // Its last occurrence was four days ago; today has none, so the rollover
    // makes it wait: target → the next occurrence, occurrence_at kept.
    sql(
      'UPDATE tasks SET due_at = ?, occurrence_at = ? WHERE id = ?',
      daysFromNow(-4),
      daysFromNow(-4),
      weekly,
    )
    await strip(page, { today: [weekly] })
    const state = await stateOf(page, weekly)
    expect(state.queued_at).not.toBeNull()
    const occurrence = DateTime.fromISO(state.occurrence_at as string).setZone(TEST_TZ)
    const target = DateTime.fromISO(state.due_at as string).setZone(TEST_TZ)
    expect(target > occurrence).toBe(true)

    await page.goto('/reminders')
    const r = row(panel(page, 'queue_today'), weekly)
    const chip = r.locator('[data-target-chip]')
    await expect(chip).toContainText(occurrence.toFormat('LLL d'))
    await expect(chip).not.toContainText(target.toFormat('LLL d'))
    await expect(chip).toContainText(/every/i)

    await openDetails(r)
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    // The occurrence it stands for is named under the title (editor PR 4c:
    // "This is the Fri Oct 16 one"); the Target row has no live target.
    await expect(dialog.locator('[data-occurrence-differs]')).toHaveText(
      `This is the ${occurrence.toFormat('ccc LLL d')} one`,
    )
    await expect(dialog.locator('[data-quick-panel-date]')).toHaveText('No target')
    await expect(dialog).not.toContainText('target moved')
    // The controls start from NOW (the task has no live target): "+1 day"
    // stages about this time tomorrow — not the day after the missed
    // occurrence (a past date), not the moved target plus a day.
    await dialog.getByRole('button', { name: '+1 day', exact: true }).click()
    const line = dialog.locator('[data-quick-panel-date]')
    await expect(dialog.locator('[data-occurrence-differs]')).toHaveCount(0)
    await expect(line).not.toContainText('No target')
    await expect(line).not.toContainText('ago')
    await expect(line).not.toContainText(occurrence.plus({ days: 1 }).toFormat('LLL d'))
    await expect(line).not.toContainText(target.plus({ days: 1 }).toFormat('LLL d'))
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)

    // The dashboard row says the same (Newest: every open task, flat).
    await withPreferences(page, { default_grouping: 'new' }, async () => {
      await page.goto('/')
      const dashRow = page.locator(`#task-row-${weekly}`)
      await expect(dashRow).toContainText(occurrence.toFormat('LLL d'))
      await expect(dashRow).not.toContainText(target.toFormat('LLL d'))
    })
  } finally {
    await trash(page, ids)
  }
})

test('row tap and circle consider: a one-off leaves the queue, ticked in its horizon', async ({
  page,
}) => {
  const ids: number[] = []
  try {
    const tapped = await create(page, {
      title: uniqueTitle('TQ tap'),
      horizon: 'days',
      due_at: daysFromNow(-2),
    })
    const circled = await create(page, {
      title: uniqueTitle('TQ circle'),
      due_at: daysFromNow(-2),
    })
    ids.push(tapped, circled)
    await strip(page, { today: [tapped, circled] })

    await page.goto('/reminders')
    const today = panel(page, 'queue_today')
    // A tap on the row's title considers it.
    await row(today, tapped)
      .getByText(/TQ tap/)
      .click()
    await expect(row(today, tapped)).toHaveCount(0)
    await expect.poll(async () => (await stateOf(page, tapped)).queued_at).toBeNull()
    const after = await stateOf(page, tapped)
    expect(after.last_considered_at).not.toBeNull()
    expect(after.queued_from_due_at).not.toBeNull()
    // Back in its horizon segment, ticked there today (shared considered state).
    const days = page.locator('[data-task-segments] [data-task-segment="days"]')
    await expect(days).toBeVisible()
    await days.locator('[data-segment-considered-toggle]').click()
    await expect(days.locator(`[data-considered-task-id="${tapped}"]`)).toBeVisible()

    // The circle.
    await row(page, circled)
      .getByRole('button', { name: /as considered/ })
      .click()
    await expect(row(page, circled)).toHaveCount(0)
    await expect.poll(async () => (await stateOf(page, circled)).queued_at).toBeNull()
  } finally {
    await trash(page, ids)
  }
})

test('Today retargets out of the queue; the checkbox is done', async ({ page }) => {
  const ids: number[] = []
  try {
    const targeted = await create(page, {
      title: uniqueTitle('TQ today'),
      due_at: daysFromNow(-2),
    })
    const done = await create(page, { title: uniqueTitle('TQ done'), due_at: daysFromNow(-2) })
    ids.push(targeted, done)
    await strip(page, { today: [targeted, done] })

    await page.goto('/reminders')
    const today = panel(page, 'queue_today')
    await row(today, targeted)
      .getByRole('button', { name: /^Target .* today/ })
      .click()
    await expect(row(today, targeted)).toHaveCount(0)
    await expect.poll(async () => (await stateOf(page, targeted)).target_at).not.toBeNull()
    expect((await stateOf(page, targeted)).queued_at).toBeNull()

    await row(today, done)
      .getByRole('button', { name: /^Done:/ })
      .click()
    await expect(row(page, done)).toHaveCount(0)
    await expect.poll(async () => (await stateOf(page, done)).done).toBe(true)
  } finally {
    await trash(page, ids)
  }
})

test('the peek bubble on a queue row and on a horizon row opens the Quick panel', async ({
  page,
}) => {
  const ids: number[] = []
  try {
    const queued = await create(page, {
      title: uniqueTitle('TQ details'),
      due_at: daysFromNow(-2),
    })
    const plain = await create(page, { title: uniqueTitle('TQ horizon'), horizon: 'days' })
    ids.push(queued, plain)
    await strip(page, { today: [queued] })
    // A days task made before today waits in today's Days segment.
    sql(
      `UPDATE tasks SET created_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 day') WHERE id = ?`,
      plain,
    )

    await page.goto('/reminders')
    for (const id of [queued, plain]) {
      const r = row(page, id)
      await expect(r).toBeVisible()
      // No pencil (2026-10-20) and no horizon dot menu: the dot is on the
      // meta line (a stripped one-off has no target).
      await expect(r.locator('button[data-horizon-chip]')).toHaveCount(0)
      await expect(r.locator('[data-segment-details]')).toHaveCount(0)
      const dialog = page.getByRole('dialog')
      const opensDetails = async () => {
        await expect(dialog).toBeVisible()
        await expect(dialog.getByText(/TQ (details|horizon)/)).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(dialog).toHaveCount(0)
      }
      // The peek bubble's Open.
      await openDetails(r)
      await opensDetails()
      // A tap on the meta-line dot opens details too, never the row's consider.
      await r.locator('[data-horizon-meta]').click()
      await opensDetails()
      // The keyboard: Cmd/Ctrl+Enter on the row, then Enter on the bubble's
      // focused Open — never the row's consider.
      await r.focus()
      await page.keyboard.press('ControlOrMeta+Enter')
      await expect(page.locator(`[data-task-peek="${id}"]`)).toBeVisible()
      await page.keyboard.press('Enter')
      await opensDetails()
      await expect(r).toHaveAttribute('data-segment-state', 'waiting')
      expect((await stateOf(page, id)).last_considered_at).toBeNull()
    }
  } finally {
    await trash(page, ids)
  }
})

test('Considered all on a queue panel, then Undo', async ({ page }) => {
  const ids: number[] = []
  try {
    const a = await create(page, { title: uniqueTitle('TQ all A'), due_at: daysFromNow(-4) })
    const b = await create(page, { title: uniqueTitle('TQ all B'), due_at: daysFromNow(-4) })
    ids.push(a, b)
    await strip(page, { earlier: [a, b] })

    await page.goto('/reminders')
    const earlier = panel(page, 'queue_previous')
    await expect(row(earlier, a)).toBeVisible()
    // No Defer all on a queue panel.
    await expect(earlier.getByRole('button', { name: /^Defer all/ })).toHaveCount(0)
    await earlier
      .getByRole('button', {
        name: /^Mark all \d+ in Task queue · Previous pulls as considered$/,
      })
      .click()
    await expect(row(page, a)).toHaveCount(0)
    await expect(row(page, b)).toHaveCount(0)
    await expect(
      page.locator('[data-sonner-toast]').filter({ hasText: /^Considered \d+ tasks/ }),
    ).toBeVisible()
    await expect.poll(async () => (await stateOf(page, a)).queued_at).toBeNull()

    await toastUndo(page).first().click()
    await expect(row(earlier, a)).toBeVisible()
    await expect(row(earlier, b)).toBeVisible()
    expect((await stateOf(page, a)).queued_at).not.toBeNull()
  } finally {
    await trash(page, ids)
  }
})

test('Considered all on a reminder period, then Undo', async ({ page }) => {
  const ids: number[] = []
  try {
    // Two reminders a few minutes back: a slot that has started (or
    // Anytime) — reminders.spec.ts' `inStartedSlot`, in the user's zone.
    const now = DateTime.now().setZone(TEST_TZ)
    const passed = now.minus({ minutes: 5 })
    const due = (passed.hasSame(now, 'day') ? passed : now.startOf('day').plus({ minutes: 1 }))
      .toUTC()
      .toISO()
    for (const s of ['one', 'two']) {
      const res = await page.request.post('/api/tasks', {
        data: { title: uniqueTitle(`TQ thought ${s}`), is_reminder: true, due_at: due },
      })
      expect(res.ok()).toBeTruthy()
      ids.push((await res.json()).data.id)
    }
    await page.goto('/reminders')
    const sweep = page.getByRole('button', { name: /^Mark all 2 in .+ as considered$/ })
    await sweep.click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Consider all 2' }).click()
    await expect(page.locator('li[data-reminder-id]')).toHaveCount(0)
    await toastUndo(page).first().click()
    await expect(page.locator('li[data-reminder-id]')).toHaveCount(2)
  } finally {
    await trash(page, ids)
  }
})

test('the sweep toast says what moves to the Tasks queue', async ({ page }) => {
  const ids: number[] = []
  const was = (await (await page.request.get('/api/user/preferences')).json()).data
  try {
    // A Snooze-all that lands tomorrow is a defer past the next rollover.
    const prefs = await page.request.patch('/api/user/preferences', {
      data: { bulk_snooze_default: 'default_option', default_snooze_option: 'tomorrow' },
    })
    expect(prefs.ok()).toBeTruthy()
    for (const s of ['A', 'B']) {
      ids.push(await create(page, { title: uniqueTitle(`TQ sweep ${s}`), due_at: daysFromNow(-1) }))
    }
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/')
    const done = page.waitForResponse(
      (r) => r.url().endsWith('/api/tasks/bulk/snooze') && r.request().method() === 'POST',
    )
    await page
      .locator('header')
      .getByRole('button', { name: /hold for options/ })
      .click()
    expect((await done).ok()).toBeTruthy()
    await expect(
      page
        .locator('[data-sonner-toast]')
        .filter({ hasText: /^2 will move to the Tasks queue at \d{1,2}:\d{2}/ }),
    ).toBeVisible()
    for (const id of ids) expect((await stateOf(page, id)).queue_mark).toBe(true)
  } finally {
    await page.request.patch('/api/user/preferences', {
      data: {
        bulk_snooze_default: was.bulk_snooze_default,
        default_snooze_option: was.default_snooze_option,
      },
    })
    await trash(page, ids)
  }
})

test('row polish: On deck lines up the column, the dot follows the project, every control has the hand', async ({
  page,
}) => {
  // Trent, 2026-10-20. A repeating row had no On deck, so its pencil sat
  // elsewhere (now it has On deck too, 2026-10-20); the one-off's horizon dot
  // came before the project, so the project names zig-zagged; Today and On
  // deck showed the arrow cursor.
  const ids: number[] = []
  try {
    const oneOff = await create(page, { title: uniqueTitle('TQ one-off'), due_at: daysFromNow(-4) })
    const weekly = await create(page, {
      title: uniqueTitle('TQ repeating'),
      rrule: `FREQ=WEEKLY;BYDAY=${weekdayCode(daysFromNow(3))}`,
      due_at: daysFromNow(3),
    })
    ids.push(oneOff, weekly)
    sql(
      'UPDATE tasks SET due_at = ?, occurrence_at = ? WHERE id = ?',
      daysFromNow(-4),
      daysFromNow(-4),
      weekly,
    )
    await strip(page, { today: [oneOff, weekly] })

    const x = async (l: Locator) => (await l.boundingBox())!.x
    const check = async (scope: Locator) => {
      const a = row(scope, oneOff)
      const w = row(scope, weekly)
      await expect(a).toBeVisible()
      await expect(w).toBeVisible()
      // Both have On deck (a repeating task decks its occurrence, 2026-10-20).
      await expect(a.locator('[data-on-deck]')).toHaveCount(1)
      await expect(w.locator('[data-on-deck]')).toHaveCount(1)
      await expect(w.locator('[data-deck-slot-empty]')).toHaveCount(0)
      for (const sel of ['[data-deck-tomorrow]', '[data-target-today]', '[data-segment-project]']) {
        // On deck tomorrow and Today line up down the column, and so do the
        // project names (the dot no longer comes before them).
        expect(await x(w.locator(sel)), sel).toBeCloseTo(await x(a.locator(sel)), 0)
      }
      const dotAfterProject = await a.locator('[data-horizon-meta]').evaluate((dot) => {
        const project = dot.parentElement!.querySelector('[data-segment-project]')!
        return !!(project.compareDocumentPosition(dot) & Node.DOCUMENT_POSITION_FOLLOWING)
      })
      expect(dotAfterProject).toBe(true)
      // Today's icon is the sun with a solid core (Trent, 2026-10-20).
      await expect(a.locator('[data-target-today] [data-sun-solid]')).toHaveCount(1)
      // Every control on the row shows the hand.
      for (const sel of [
        '[data-on-deck]',
        '[data-target-today]',
        '[data-deck-tomorrow]',
        '[data-horizon-meta]',
        '[aria-label^="Mark"]',
        '[aria-label^="Done"]',
      ]) {
        await expect(a.locator(sel).first(), sel).toHaveCSS('cursor', 'pointer')
      }
    }

    await page.goto('/reminders')
    const today = panel(page, 'queue_today')
    await check(today)
    await expect(today.locator('[data-segment-consider-all]')).toHaveCSS('cursor', 'pointer')

    // The dashboard's right panel: the same rows, and its pager header.
    await page.setViewportSize({ width: 1600, height: 900 })
    await page.goto('/')
    const card = page.locator('[data-tasks-panel]')
    await expect(card).toHaveAttribute('data-task-segment', 'queue_today')
    await check(card)
    await expect(card.locator('[data-slot-header-toggle]')).toHaveCSS('cursor', 'pointer')
    const next = card.getByRole('button', { name: 'Next task segment' })
    if (await next.isEnabled()) await expect(next).toHaveCSS('cursor', 'pointer')
  } finally {
    await trash(page, ids)
  }
})
