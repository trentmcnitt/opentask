/**
 * THE DEADLINES PAGE on the web (2026-10-22, docs/TASK-MODEL.md § The
 * deadlines page; plan §9): "Task queue · Deadlines", FIRST among the task
 * segments, with the task-queue switch on (`POST /api/test/task-queue`).
 *
 * A deadline task with no target goes on the page from its lead day
 * (`lead_from`). Clock-independent days: a 30-day lead override clamps the
 * lead day to TODAY (the page holds it now), a deadline five days out is
 * never in the safety net, and one 20 hours out always is (its OpenTask day
 * is today or tomorrow, whatever the hour — D−1 ≤ today).
 *
 * Its own user (`queue@opentask.local`, as tq-queue-panels): with the switch
 * on, the minute cron's rollover would strip the shared user's past-target
 * one-offs. Unique titles; every task trashed in `finally`; the switch off
 * again after the file.
 */
import path from 'path'
import Database from 'better-sqlite3'
import { DateTime } from 'luxon'
import { test, expect, openTaskDay, uniqueTitle, chipContrast } from './fixtures'
import type { Locator, Page } from '@playwright/test'

const TZ = process.env.E2E_TZ || 'America/Chicago'
test.use({ timezoneId: TZ })
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const fromNow = (ms: number) => new Date(Date.now() + ms).toISOString()

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

/** Backdate `target_set_at` (the API stamps now) straight in the E2E database. */
function backdateTargetSet(id: number, days: number) {
  const db = new Database(path.join(process.cwd(), 'data', 'test-e2e.db'))
  try {
    db.prepare('UPDATE tasks SET target_set_at = ? WHERE id = ?').run(fromNow(-days * DAY), id)
  } finally {
    db.close()
  }
}

/** On the page now, outside the safety net. */
const onPage = (page: Page, title: string, extra: Record<string, unknown> = {}) =>
  create(page, {
    title: uniqueTitle(title),
    deadline_at: fromNow(5 * DAY),
    lead_days: 30,
    ...extra,
  })
/** In the safety net (D−1 or D). */
const inNet = (page: Page, title: string) =>
  create(page, { title: uniqueTitle(title), deadline_at: fromNow(20 * HOUR) })

const section = (page: Page) => page.locator('[data-task-segments] [data-task-segment="deadlines"]')
const row = (scope: Page | Locator, id: number) => scope.locator(`[data-segment-task="${id}"]`)
const toast = (page: Page) => page.locator('[data-sonner-toast]').first()
/** A hold menu's choice: a menu item on a wide screen, a bottom sheet's button on a phone. */
const choice = (page: Page, name: RegExp) =>
  page
    .locator('[role="menuitem"], [data-slot="sheet-content"] button')
    .filter({ hasText: name })
    .first()

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  await signIn(page)
  await setQueue(page, true)
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

    test('the page comes first, titled, on /reminders and in the dashboard carousel', async ({
      page,
    }) => {
      const ids: number[] = []
      try {
        ids.push(await onPage(page, 'DL first'))
        // A Days row too, so the page has a neighbour to come before.
        ids.push(
          await create(page, { title: uniqueTitle('DL days'), horizon: 'days', priority: 4 }),
        )
        await page.goto('/reminders')
        const first = page.locator('[data-task-segments] [data-task-segment]').first()
        await expect(first).toHaveAttribute('data-task-segment', 'deadlines')
        await expect(first).toContainText(/Task queue · Deadlines/i)
        await expect(row(first, ids[0])).toBeVisible()
        // No Defer all on the page (its Defer is per row).
        await expect(first.getByRole('button', { name: /Defer all/ })).toHaveCount(0)

        await page.goto('/')
        const card = page.locator('[data-tasks-panel]')
        await expect(card).toHaveAttribute('data-tasks-page', 'tasks:deadlines')
        await expect(row(card, ids[0])).toBeVisible()
      } finally {
        await trash(page, ids)
      }
    })

    test('seen leaves the row; Defer picks a day; Today targets it', async ({ page }) => {
      const ids: number[] = []
      try {
        const seen = await onPage(page, 'DL seen')
        const defer = await onPage(page, 'DL defer')
        const today = await onPage(page, 'DL today')
        ids.push(seen, defer, today)
        await page.goto('/reminders')
        const s = section(page)
        await expect(row(s, seen)).toBeVisible()

        // The circle: seen for the day — the row leaves the list.
        await row(s, seen)
          .getByRole('button', { name: /as considered/ })
          .click()
        await expect(row(s, seen)).toHaveCount(0)
        await expect.poll(async () => (await stateOf(page, seen)).last_considered_at).toBeTruthy()

        // Defer: a tap opens the day menu; Tomorrow moves this instance's lead day.
        const before = String((await stateOf(page, defer)).lead_from)
        await row(s, defer).locator('[data-defer-lead]').click()
        await choice(page, /^Tomorrow/).click()
        await expect(row(s, defer)).toHaveCount(0)
        await expect(toast(page)).toContainText('Deferred')
        await expect
          .poll(async () => String((await stateOf(page, defer)).lead_from) > before)
          .toBe(true)
        // Today: a target today takes it off the page.
        await row(s, today).locator('[data-target-today]').click()
        await expect(row(s, today)).toHaveCount(0)
        await expect.poll(async () => (await stateOf(page, today)).target_at).toBeTruthy()

        // "Show N considered" lists them, the deferred one says to which day.
        await s.locator('[data-segment-considered-toggle]').click()
        await expect(s.locator(`[data-considered-task-id="${defer}"]`)).toContainText(
          /deferred to \w{3}/,
        )
      } finally {
        await trash(page, ids)
      }
    })

    test('the safety net: seen keeps the row (a ring), and it has no Defer', async ({ page }) => {
      const ids: number[] = []
      try {
        const net = await inNet(page, 'DL net')
        ids.push(net)
        await page.goto('/reminders')
        const r = row(section(page), net)
        await expect(r).toHaveAttribute('data-safety-net', '')
        await expect(r.locator('[data-defer-lead]')).toHaveCount(0)
        await expect(r.locator('[data-defer-lead-empty]')).toHaveCount(1)
        // The chip no longer marks the safety net (amber until 2026-10-28): a
        // deadline 20 hours out is today's or tomorrow's.
        await expect(r.locator('[data-deadline-chip]')).toHaveAttribute(
          'data-deadline-chip',
          /^(today|ahead)$/,
        )
        await r.getByRole('button', { name: /as considered/ }).click()
        // Still listed, still waiting, now with the seen ring.
        await expect(r.locator('[data-seen-ring]')).toBeVisible()
        await expect(r).toHaveAttribute('data-segment-state', 'waiting')
        await page.reload()
        await expect(row(section(page), net).locator('[data-seen-ring]')).toBeVisible()
      } finally {
        await trash(page, ids)
      }
    })
  })
}

for (const viewport of VIEWPORTS) {
  test.describe(`at ${viewport.width}: decks and links`, () => {
    test.use({ viewport })

    test('a deck keeps the row on the page; Today on a decked row is faded and asks first', async ({
      page,
    }) => {
      const ids: number[] = []
      try {
        const later = await onPage(page, 'DL deck later')
        const net = await inNet(page, 'DL deck net')
        ids.push(later, net)
        await page.goto('/reminders')
        const s = section(page)
        // A later day (hold On deck for its menu): the row STAYS on the page,
        // waiting, with its deck day — a deck is not a consider here (Trent,
        // 10-22), and survives a reload.
        await row(s, later).locator('[data-on-deck]').click({ button: 'right' })
        const day = DateTime.fromISO(await openTaskDay(page, 2), { zone: TZ })
        await choice(page, new RegExp(`^${day.toFormat('cccc')}`)).click()
        await expect
          .poll(async () => (await stateOf(page, later)).on_deck_day)
          .toBe(day.toISODate())
        expect((await stateOf(page, later)).last_considered_at).toBeNull()
        await page.reload()
        const l = row(section(page), later)
        await expect(l).toHaveAttribute('data-segment-state', 'waiting')
        await expect(l.locator('[data-deck-day-chip]')).toHaveText(`On deck ${day.toFormat('ccc')}`)
        await expect(l.locator('[data-target-today]')).toHaveAttribute('data-replaces', '')

        // In the safety net a deck for today keeps the row waiting, its chip.
        const r = row(section(page), net)
        await r.locator('[data-on-deck]').click()
        await expect(r.locator('[data-deck-day-chip]')).toHaveText('On deck today')
        await expect(r).toHaveAttribute('data-segment-state', 'waiting')
        // Today on the decked row: faded, and a tap asks.
        const today = r.locator('[data-target-today]')
        await expect(today).toHaveAttribute('data-replaces', '')
        await today.click()
        const confirm = page.locator('[data-replace-confirm]')
        await expect(confirm).toContainText('Replaces On deck today')
        await confirm.locator('[data-replace-cancel]').click()
        await expect(confirm).toHaveCount(0)
        expect((await stateOf(page, net)).target_at).toBeNull()
        await today.click()
        await page.locator('[data-replace-confirm] [data-replace-ok]').click()
        await expect.poll(async () => (await stateOf(page, net)).target_at).toBeTruthy()
        expect((await stateOf(page, net)).on_deck_day).toBeNull()
      } finally {
        await trash(page, ids)
      }
    })

    test('the deadline chip: after the project on the page, leading the dashboard row', async ({
      page,
    }) => {
      const ids: number[] = []
      try {
        const ahead = await onPage(page, 'DL chip ahead')
        const past = await create(page, {
          title: uniqueTitle('DL chip past'),
          deadline_at: fromNow(-2 * HOUR),
        })
        ids.push(ahead, past)
        await page.goto('/reminders')
        const s = section(page)
        const chip = (id: number) => row(s, id).locator('[data-deadline-chip]')
        await expect(chip(ahead)).toHaveAttribute('data-deadline-chip', 'ahead')
        await expect(chip(ahead)).toContainText('Deadline')
        await expect(chip(past)).toHaveAttribute('data-deadline-chip', 'passed')
        await expect(chip(past)).toContainText('Past deadline')
        // Readable (2026-10-28): its red text on its own red tint is at least
        // 4.5:1, light and dark (it was 3.99:1 in both).
        for (const scheme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme: scheme })
          expect(await chipContrast(chip(past)), scheme).toBeGreaterThanOrEqual(4.5)
        }
        await page.emulateMedia({ colorScheme: null })
        // Right after the project (Trent's 10-20 rule: every row's project
        // starts at the same x).
        const meta = row(s, ahead).locator('p + div > *')
        await expect(meta.nth(0)).toHaveAttribute('data-segment-project')
        await expect(meta.nth(1)).toHaveAttribute('data-deadline-chip', 'ahead')

        // The dashboard row: the past-deadline task is relevant in Now (its
        // safety net), and its chip leads the second line.
        await page.goto('/')
        const dash = page.locator(`#task-row-${past}`)
        await expect(dash.locator('[data-deadline-chip]')).toHaveAttribute(
          'data-deadline-chip',
          'passed',
        )
      } finally {
        await trash(page, ids)
      }
    })

    test('/?tasks=deadlines opens the Tasks card on the page and cleans the URL', async ({
      page,
    }) => {
      const ids: number[] = []
      try {
        ids.push(await onPage(page, 'DL link'))
        await page.goto('/?tasks=deadlines')
        const card = page.locator('[data-tasks-panel]')
        await expect(card).toHaveAttribute('data-tasks-page', 'tasks:deadlines')
        await expect(card).toBeInViewport()
        await expect.poll(() => new URL(page.url()).search).toBe('')
      } finally {
        await trash(page, ids)
      }
    })
  })
}

test.describe('the faded On deck on a picked target', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('the dashboard row asks "Replaces target …" before a deck', async ({ page }) => {
    const ids: number[] = []
    try {
      const at = DateTime.now().setZone(TZ).plus({ days: 3 }).set({ hour: 18, minute: 0 })
      const id = await create(page, {
        title: uniqueTitle('DL faded'),
        target_at: at.toUTC().toISO(),
      })
      ids.push(id)
      const prefs = await page.request.patch('/api/user/preferences', {
        data: { default_grouping: 'new' },
      })
      expect(prefs.ok()).toBeTruthy()
      await page.goto('/')
      const r = page.locator(`#task-row-${id}`)
      await r.hover()
      const deck = r.locator('[data-on-deck]')
      await expect(deck).toHaveAttribute('data-replaces', '')
      await deck.click()
      const confirm = page.locator('[data-replace-confirm]')
      await expect(confirm).toContainText(`Replaces target ${at.toFormat('ccc')} 6 PM`)
      await confirm.locator('[data-replace-ok]').click()
      await expect
        .poll(async () => (await stateOf(page, id)).on_deck_day)
        .toBe(await openTaskDay(page))
      expect((await stateOf(page, id)).target_at).toBeNull()
    } finally {
      await page.request.patch('/api/user/preferences', { data: { default_grouping: 'project' } })
      await trash(page, ids)
    }
  })
})

test.describe('before the lead day, and Remove target', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('before its lead day a deadline task is quiet: not in Upcoming, not on the page (rule 3)', async ({
    page,
  }) => {
    const ids: number[] = []
    try {
      // D = today + 4 (OpenTask days, whatever the hour), a 1-day lead → the
      // page from today + 3; set ten days ago. Until 2026-10-25 today was its
      // early heads-up in Upcoming; rule 3 of the Upcoming split: the
      // deadlines page alone holds it, from its lead day.
      const id = await create(page, {
        title: uniqueTitle('DL handoff'),
        deadline_at: fromNow(4 * DAY),
        lead_days: 1,
      })
      ids.push(id)
      backdateTargetSet(id, 10)
      await page.goto('/reminders')
      await expect(page.locator('[data-task-segment]').first()).toBeVisible()
      await expect(row(page.locator('[data-task-segment="upcoming"]'), id)).toHaveCount(0)
      await expect(row(section(page), id)).toHaveCount(0)
    } finally {
      await trash(page, ids)
    }
  })

  test("Remove target on a deadline row's target menu: no target, onto the page", async ({
    page,
  }) => {
    const ids: number[] = []
    try {
      // Targeted tomorrow (set ten days ago: today is its heads-up), deadline
      // five days out with a 30-day lead: removed, the page holds it at once.
      const id = await create(page, {
        title: uniqueTitle('DL remove'),
        target_at: DateTime.now().setZone(TZ).plus({ days: 1 }).set({ hour: 10 }).toUTC().toISO(),
        deadline_at: fromNow(5 * DAY),
        lead_days: 30,
      })
      ids.push(id)
      backdateTargetSet(id, 10)
      await page.goto('/reminders')
      const up = row(page.locator('[data-task-segment="upcoming"]'), id)
      await up.getByRole('button', { name: /Options$/ }).click()
      await expect(page.locator('[data-back-to-auto]')).toHaveCount(0)
      await page.locator('[data-remove-target]').click()
      await expect(up).toHaveCount(0)
      await expect.poll(async () => (await stateOf(page, id)).target_at).toBeNull()
      expect((await stateOf(page, id)).target_auto).toBe(false)
      await expect(row(section(page), id)).toBeVisible()
    } finally {
      await trash(page, ids)
    }
  })
})
