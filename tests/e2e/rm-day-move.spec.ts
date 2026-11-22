/**
 * The one-day move, on the web (2026-11-21): a reminder — or a quota prompt —
 * waiting today, moved to a LATER period for today only
 * (`POST /api/reminders/move`, src/lib/reminder-move.ts).
 *
 * - The dashboard's Reminders card: a hold opens the row's bubble, whose
 *   "Later today:" chips move it; the toast's Undo puts it back. Once moved,
 *   the line names where it is now: "Later today (now Midday):".
 * - /reminders: the select bar's Later today menu moves the whole selection
 *   (a reminder and a quota prompt) to a period all of it can go to.
 *
 * "Later" depends on the time of day, so both clocks are pinned to 10:00 in
 * the user's zone — the most recent 10:00 at or before real now (never ahead
 * of it: the cron jobs compute on the shifted clock), as tq-late-night.spec.ts
 * does: the server's through the test-only POST /api/test/clock, the
 * browser's through `page.clock.install`. At 10:00 Morning (09:00) is open
 * and Midday, Afternoon and Evening are still to come. Every time here is
 * worked out from the pin, never from the real clock. The real clock goes
 * back in afterAll (and in the global teardown). Invented titles only.
 */

import { DateTime } from 'luxon'
import { test, expect, uniqueTitle, holdUntil, TEST_EMAIL, TEST_PASSWORD } from './fixtures'
import type { APIRequestContext, Locator, Page } from '@playwright/test'

const TZ = process.env.E2E_TZ || 'America/Chicago'
test.use({ timezoneId: TZ })

/** The most recent 10:00 in the user's zone, at or before real now. */
function midMorning(): DateTime {
  const now = DateTime.now().setZone(TZ)
  const at = now.set({ hour: 10, minute: 0, second: 0, millisecond: 0 })
  return at > now ? at.minus({ days: 1 }) : at
}
const PIN = midMorning()
/** HH:MM on the pinned day, as a UTC ISO instant. */
const pinnedAt = (hour: number, minute = 0) => PIN.set({ hour, minute }).toUTC().toISO() as string

async function setClock(request: APIRequestContext, now: string | null): Promise<void> {
  const res = await request.post('/api/test/clock', { data: { now } })
  expect(res.ok(), await res.text()).toBeTruthy()
}

async function stampRollover(request: APIRequestContext) {
  const res = await request.post('/api/test/rollover', { data: {} })
  expect(res.ok(), await res.text()).toBeTruthy()
}

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill(TEST_EMAIL)
  await page.getByLabel('Password').fill(TEST_PASSWORD)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL('/', { timeout: 10_000 })
}

interface Slot {
  id: number
  label: string
  start_time: string
}

async function slots(page: Page): Promise<Record<string, Slot>> {
  const res = await page.request.get('/api/time-slots')
  expect(res.ok()).toBeTruthy()
  const list = (await res.json()).data.time_slots as Slot[]
  return Object.fromEntries(list.map((s) => [s.label, s]))
}

async function create(page: Page, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data })
  expect(res.ok(), `create ${JSON.stringify(data)}`).toBeTruthy()
  return (await res.json()).data.id as number
}

/** A one-off reminder at 09:30 on the pinned day: Morning's. */
const morningReminder = (page: Page, title: string) =>
  create(page, { title, is_reminder: true, due_at: pinnedAt(9, 30) })

async function trash(page: Page, ids: number[]) {
  if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
}

interface Group {
  slot: { id: number; label: string } | null
  reminders: { id: number }[]
  prompts: { prompt_key: string; task_id: number; considered: boolean; done: boolean }[]
}

async function groups(page: Page): Promise<Group[]> {
  const res = await page.request.get('/api/reminders')
  expect(res.ok()).toBeTruthy()
  return (await res.json()).data.groups as Group[]
}

/** The period a reminder is waiting in today, by the server ("Anytime" for none). */
async function periodOf(page: Page, id: number): Promise<string | null> {
  const g = (await groups(page)).find((x) => x.reminders.some((r) => r.id === id))
  return g ? (g.slot?.label ?? 'Anytime') : null
}

/** The period a quota's waiting prompt is in today, by the server. */
async function promptPeriodOf(page: Page, quotaId: number): Promise<string | null> {
  const g = (await groups(page)).find((x) =>
    x.prompts.some((p) => p.task_id === quotaId && !p.considered && !p.done),
  )
  return g ? (g.slot?.label ?? 'Anytime') : null
}

const toast = (page: Page, text: string | RegExp) =>
  page.locator('[data-sonner-toast]').filter({ hasText: text })
const panel = (page: Page) => page.locator('[data-reminders-panel]')
const panelRow = (page: Page, id: number) => panel(page).locator(`li[data-reminder-id="${id}"]`)
const bubble = (page: Page, id: number) => page.locator(`[data-reminder-popover="${id}"]`)

/** Hold a panel row until its bubble is open. */
async function openBubble(page: Page, id: number): Promise<Locator> {
  const row = panelRow(page, id)
  await row.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await holdUntil(row, () => expect(bubble(page, id)).toBeVisible())
  return bubble(page, id)
}

/** Page the dashboard card to the period `label` (`slotId`). */
async function pageTo(page: Page, slotId: number) {
  const card = panel(page)
  for (let i = 0; i < 6; i++) {
    if ((await card.getAttribute('data-reminders-slot')) === String(slotId)) return
    await card.getByRole('button', { name: 'Next time slot' }).click()
  }
  await expect(card).toHaveAttribute('data-reminders-slot', String(slotId))
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ request }) => {
  await stampRollover(request)
})

test.beforeEach(async ({ page }) => {
  await setClock(page.request, PIN.toUTC().toISO())
  await page.clock.install({ time: PIN.toJSDate() })
  await signIn(page)
})

test.afterAll(async ({ request }) => {
  await setClock(request, null)
  await stampRollover(request)
})

for (const [name, viewport] of [
  ['phone', { width: 390, height: 844 }],
  ['desktop', { width: 1280, height: 800 }],
] as const) {
  test.describe(`${name}`, () => {
    test.use({ viewport })

    test('the bubble’s Later today chips move a Morning reminder; Undo puts it back', async ({
      page,
    }) => {
      const ids: number[] = []
      try {
        const s = await slots(page)
        const title = uniqueTitle('Return the library books')
        const id = await morningReminder(page, title)
        ids.push(id)
        await page.goto('/')
        await expect(panel(page)).toHaveAttribute('data-reminders-slot', String(s.Morning.id))

        const b = await openBubble(page, id)
        const later = b.locator('[data-reminder-later]')
        await expect(later.locator('[data-reminder-later-label]')).toHaveText('Later today:')
        await expect(later.locator('button')).toHaveText(['Midday', 'Afternoon', 'Evening'])

        await later.getByRole('button', { name: 'Move to Afternoon for today' }).click()
        await expect(bubble(page, id)).toHaveCount(0)
        await expect(panelRow(page, id)).toHaveCount(0)
        const t = toast(page, `Moved “${title}” to Afternoon for today`)
        await expect(t).toBeVisible()
        await expect.poll(() => periodOf(page, id)).toBe('Afternoon')

        await t.getByRole('button', { name: 'Undo' }).click()
        await expect(panelRow(page, id)).toBeVisible()
        await expect.poll(() => periodOf(page, id)).toBe('Morning')
        // Still home once the refreshes have landed.
        await page.reload()
        await expect(panelRow(page, id)).toBeVisible()
      } finally {
        await trash(page, ids)
      }
    })

    test('a refused move puts the row back and says why', async ({ page }) => {
      const ids: number[] = []
      try {
        const title = uniqueTitle('Book the dentist')
        const id = await morningReminder(page, title)
        ids.push(id)
        // The server's refusal when a period starts while the bubble is open.
        await page.route('**/api/reminders/move', (route) =>
          route.fulfill({
            status: 400,
            json: {
              error: 'Afternoon has already started; pick a later period',
              code: 'VALIDATION_ERROR',
            },
          }),
        )
        await page.goto('/')
        const b = await openBubble(page, id)
        await b.getByRole('button', { name: 'Move to Afternoon for today' }).click()
        await expect(
          toast(page, 'Afternoon has already started; pick a later period'),
        ).toBeVisible()
        await expect(panelRow(page, id)).toBeVisible()
        expect(await periodOf(page, id)).toBe('Morning')
      } finally {
        await page.unrouteAll()
        await trash(page, ids)
      }
    })

    test('a moved reminder’s bubble says where it is now and offers only what comes after', async ({
      page,
    }) => {
      const ids: number[] = []
      try {
        const s = await slots(page)
        const title = uniqueTitle('Call about the boiler')
        const id = await morningReminder(page, title)
        ids.push(id)
        const res = await page.request.post('/api/reminders/move', {
          data: { ids: [id], slot_id: s.Midday.id },
        })
        expect(res.ok(), await res.text()).toBeTruthy()

        await page.goto('/')
        await expect(panel(page)).toHaveAttribute('data-reminders-slot', String(s.Morning.id))
        await expect(panelRow(page, id)).toHaveCount(0)
        await pageTo(page, s.Midday.id)

        const b = await openBubble(page, id)
        const later = b.locator('[data-reminder-later]')
        await expect(later.locator('[data-reminder-later-label]')).toHaveText(
          'Later today (now Midday):',
        )
        await expect(later.locator('button')).toHaveText(['Afternoon', 'Evening'])
        // The meta still names its home period.
        await expect(b).toContainText('Morning')

        // Moved again, to the last period: no line in its bubble there.
        await later.getByRole('button', { name: 'Move to Evening for today' }).click()
        await expect.poll(() => periodOf(page, id)).toBe('Evening')
        await pageTo(page, s.Evening.id)
        const last = await openBubble(page, id)
        await expect(last.locator('[data-reminder-later]')).toHaveCount(0)
      } finally {
        await trash(page, ids)
      }
    })

    test('/reminders: the select bar’s Later today menu moves a reminder and a quota prompt', async ({
      page,
    }) => {
      const ids: number[] = []
      try {
        const s = await slots(page)
        const title = uniqueTitle('Water the balcony herbs')
        const id = await morningReminder(page, title)
        ids.push(id)
        const quotaTitle = uniqueTitle('Practice scales')
        const quotaId = await create(page, {
          title: quotaTitle,
          rrule: 'FREQ=WEEKLY',
          progress_target: 3,
          is_tracked: true,
          quota_prompt_config: { slot_id: s.Morning.id },
        })
        ids.push(quotaId)
        await expect.poll(() => promptPeriodOf(page, quotaId)).toBe('Morning')

        await page.goto('/reminders')
        const morning = page.locator(`[data-slot-key="${s.Morning.id}"]`)
        const row = morning.locator(`li[data-reminder-id="${id}"]`)
        const promptRow = morning.locator('[data-prompt-key]', { hasText: quotaTitle })
        await expect(row).toBeVisible()
        await expect(promptRow).toBeVisible()

        // Hold to select, then a tap adds the prompt.
        await row.evaluate((el) => el.scrollIntoView({ block: 'center' }))
        await holdUntil(row, () => expect(row).toHaveAttribute('aria-selected', 'true'))
        await promptRow.click()
        const bar = page.locator('[data-selection-sheet]')
        await expect(bar).toContainText('2 selected')

        await bar.locator('[data-bar-later]').click()
        const menu = name === 'phone' ? page.getByRole('dialog') : page.getByRole('menu')
        await expect(menu).toBeVisible()
        const choices = name === 'phone' ? menu.getByRole('button') : menu.getByRole('menuitem')
        await expect(choices).toHaveText([/^Midday/, /^Afternoon/, /^Evening/])
        await choices.filter({ hasText: 'Evening' }).click()

        await expect(bar).toHaveCount(0)
        await expect(row).toHaveCount(0)
        await expect(promptRow).toHaveCount(0)
        const t = toast(page, 'Moved 2 to Evening for today')
        await expect(t).toBeVisible()
        await expect.poll(() => periodOf(page, id)).toBe('Evening')
        await expect.poll(() => promptPeriodOf(page, quotaId)).toBe('Evening')

        // One Undo puts both back in Morning: the reminder and the prompt.
        await t.getByRole('button', { name: 'Undo' }).click()
        await expect(row).toBeVisible()
        await expect(promptRow).toBeVisible()
        await expect.poll(() => periodOf(page, id)).toBe('Morning')
        await expect.poll(() => promptPeriodOf(page, quotaId)).toBe('Morning')
      } finally {
        await trash(page, ids)
      }
    })
  })
}

test('/reminders: no period after all of the selection — Later today is off, and says why', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const ids: number[] = []
  try {
    const s = await slots(page)
    const a = await morningReminder(page, uniqueTitle('Fold the laundry'))
    const b = await create(page, {
      title: uniqueTitle('Lock the shed'),
      is_reminder: true,
      due_at: pinnedAt(20, 45),
    })
    ids.push(a, b)
    await page.goto('/reminders')
    const rowA = page.locator(`[data-slot-key="${s.Morning.id}"] li[data-reminder-id="${a}"]`)
    await rowA.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await holdUntil(rowA, () => expect(rowA).toHaveAttribute('aria-selected', 'true'))
    const bar = page.locator('[data-selection-sheet]')
    await expect(bar.locator('[data-bar-later]')).toBeEnabled()

    // Evening's row too: nothing comes after Evening.
    const evening = page.locator(`[data-slot-key="${s.Evening.id}"]`)
    const rowB = evening.locator(`li[data-reminder-id="${b}"]`)
    // A period still to come is folded: open it (reminders.spec.ts's `openAllSlots`).
    const fold = evening.locator(':scope > div:first-child > button[aria-expanded="false"]')
    if ((await fold.count()) > 0) await fold.click()
    await rowB.click()
    await expect(bar).toContainText('2 selected')
    await expect(bar.locator('[data-bar-later]')).toBeDisabled()
    await expect(bar.locator('[data-selection-hint]')).toHaveText(
      'Later today: no period comes after all of them',
    )
  } finally {
    await trash(page, ids)
  }
})
