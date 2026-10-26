/**
 * A deadline and its target, with the deadlines page (2026-10-22,
 * docs/TASK-MODEL.md § The deadlines page — it replaced the automatic target
 * of spec §8):
 *
 * - the row's defer menu offers "Morning of the deadline" (ruling Q8) and, on a picked
 *   target with a deadline, "Remove target" (there is no "Back to auto");
 * - every move stops AT the deadline, and the toast says so;
 * - the editor: a deadline task with no target reads "No target" and a Lead
 *   row — "On the deadlines page from … (N days before)" — whose stepper
 *   saves `lead_days`; Remove target on a picked one brings the Lead row in;
 *   its target picker offers "Before the deadline" (relative targets,
 *   2026-10-24), not the defer menu's "Morning of the deadline".
 *
 * With the task-queue switch on (the page rides it), as the queue's own user
 * (`queue@opentask.local`, see tq-queue-panels): with the switch on the
 * rollover would strip the shared user's past-target one-offs. Every task is
 * created here under a unique title and deleted in `finally`; the dashboard
 * grouping is put back by `withPreferences`; the switch goes off after.
 */
import { DateTime } from 'luxon'
import { test, expect, holdUntil, uniqueTitle, withPreferences } from './fixtures'
import type { Locator, Page } from '@playwright/test'

const TZ = process.env.E2E_TZ || 'America/Chicago'
// The pickers work in the browser's local days; run the browser in the user's zone.
test.use({ timezoneId: TZ })
const MIN = 60_000

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill('queue@opentask.local')
  await page.getByLabel('Password').fill('testpass123')
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL('/', { timeout: 10_000 })
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

async function create(page: Page, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data })
  expect(res.ok(), `create ${JSON.stringify(data)}`).toBeTruthy()
  return (await res.json()).data.id as number
}

async function stateOf(page: Page, id: number): Promise<Record<string, unknown>> {
  return (await (await page.request.get(`/api/tasks/${id}`)).json()).data as Record<string, unknown>
}

async function remove(page: Page, ids: number[]) {
  if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
}

/** Every running animation (the picker opening) has finished, for a screenshot. */
async function settle(page: Page) {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))
}

const localDay = (iso: unknown) => DateTime.fromISO(String(iso)).setZone(TZ).toISODate()

/** The row's snooze button, hovered into view. */
async function snoozeButton(page: Page, id: number, title: string): Promise<Locator> {
  const row = page.locator(`#task-row-${id}`)
  await expect(row).toBeVisible({ timeout: 10_000 })
  await row.hover()
  const btn = row.getByRole('button', { name: new RegExp(`defer "${title}"`, 'i') })
  await expect(btn).toBeVisible()
  return btn
}

test.describe('Deadline: the snooze menu', () => {
  test('"Morning of the deadline" moves the target to the deadline\'s morning; a picked target offers Remove target', async ({
    page,
  }) => {
    const title = uniqueTitle('TM8 deadline day')
    const deadline = DateTime.now().setZone(TZ).plus({ days: 3 }).set({ hour: 17, minute: 0 })
    const id = await create(page, {
      title,
      target_at: DateTime.now().setZone(TZ).plus({ days: 1 }).set({ hour: 10 }).toUTC().toISO(),
      deadline_at: deadline.toUTC().toISO(),
    })
    try {
      await withPreferences(page, { default_grouping: 'unified' }, async () => {
        await page.goto('/')
        // Not over target, so a tap opens the menu.
        await (await snoozeButton(page, id, title)).click()
        const menu = page.getByRole('menu', { name: 'Defer options' })
        await expect(menu).toBeVisible()
        await expect(menu.getByRole('menuitem', { name: 'Remove target' })).toBeVisible()
        await expect(menu.getByRole('menuitem', { name: 'Back to auto' })).toHaveCount(0)
        await menu
          .getByRole('menuitem', {
            name: /^Morning of the deadline · .* \((Default task|Deadline) time\)$/,
          })
          .click()
        await expect
          .poll(async () => localDay((await stateOf(page, id)).target_at))
          .toBe(deadline.toISODate())
        const after = await stateOf(page, id)
        expect(Date.parse(String(after.target_at))).toBeLessThanOrEqual(
          Date.parse(String(after.deadline_at)),
        )
        expect(after.target_auto).toBe(false)
      })
    } finally {
      await remove(page, [id])
    }
  })

  test('a snooze past the deadline stops AT it, and the toast says so', async ({ page }) => {
    const title = uniqueTitle('TM8 capped')
    // "1 hour" lands on the nearest whole hour, so at least 30 minutes out:
    // a deadline 10 minutes out is always crossed, whatever the minute.
    const deadline = new Date(Date.now() + 10 * MIN).toISOString()
    const id = await create(page, {
      title,
      target_at: new Date(Date.now() - 60 * MIN).toISOString(),
      deadline_at: deadline,
    })
    try {
      await withPreferences(page, { default_grouping: 'unified' }, async () => {
        await page.goto('/')
        // Over target: a tap would snooze at once, so hold for the menu.
        const btn = await snoozeButton(page, id, title)
        const menu = page.getByRole('menu', { name: 'Defer options' })
        await holdUntil(btn, () => expect(menu).toBeVisible())
        await menu.getByRole('menuitem', { name: '1 hour', exact: true }).click()
        await expect(page.locator('[data-sonner-toast]').first()).toContainText(
          'Deferred to deadline',
        )
        await expect
          .poll(async () => Date.parse(String((await stateOf(page, id)).target_at)))
          .toBe(Date.parse(deadline))
      })
    } finally {
      await remove(page, [id])
    }
  })

  test('once the deadline has passed a snooze moves past it, and the row still says so in red', async ({
    page,
  }) => {
    // Trent's ruling, 2026-10-12: a passed deadline caps nothing.
    const title = uniqueTitle('TM8 passed')
    const deadline = new Date(Date.now() - 30 * MIN).toISOString()
    const id = await create(page, {
      title,
      target_at: new Date(Date.now() - 60 * MIN).toISOString(),
      deadline_at: deadline,
    })
    try {
      await withPreferences(page, { default_grouping: 'unified' }, async () => {
        await page.goto('/')
        const btn = await snoozeButton(page, id, title)
        const menu = page.getByRole('menu', { name: 'Defer options' })
        await holdUntil(btn, () => expect(menu).toBeVisible())
        await menu.getByRole('menuitem', { name: '1 hour', exact: true }).click()
        const toast = page.locator('[data-sonner-toast]').first()
        await expect(toast).toContainText('Deferred')
        await expect(toast).not.toContainText('deadline')
        await expect
          .poll(async () => Date.parse(String((await stateOf(page, id)).target_at)))
          // Past the deadline and still ahead: "1 hour" rounds to the nearest
          // hour, so "now + 1h" itself is not the floor.
          .toBeGreaterThan(Date.now())
        // The deadline chip leads the row's second line, red (2026-10-22).
        const chip = page.locator(`#task-row-${id} [data-deadline-chip]`)
        await expect(chip).toHaveAttribute('data-deadline-chip', 'passed')
        await expect(chip).toContainText('Past deadline')
      })
    } finally {
      await remove(page, [id])
    }
  })
})

test.describe('Deadline: the editor', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  /** Tap the row's own padding (not the title link, not the Done circle) to open the sheet. */
  async function openEditor(page: Page, id: number): Promise<Locator> {
    await page.goto('/')
    const row = page.locator(`#task-row-${id}`)
    await row.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    const box = await row.boundingBox()
    if (!box) throw new Error('row not on screen')
    await row.tap({ position: { x: 56, y: box.height - 6 } })
    const sheet = page.locator('[data-slot="sheet-content"]')
    await expect(sheet.getByRole('button', { name: 'Save' })).toBeVisible()
    return sheet
  }

  test('no target reads "No target" and a Lead row; its stepper saves lead_days; Remove target brings the row in', async ({
    page,
  }) => {
    // Ten days out: the 3-day lead (a wait of 8–15 days).
    const deadline = DateTime.now().setZone(TZ).plus({ days: 10 }).set({ hour: 17, minute: 0 })
    const bare = await create(page, {
      title: uniqueTitle('TM8 lead'),
      deadline_at: deadline.toUTC().toISO(),
    })
    const picked = await create(page, {
      title: uniqueTitle('TM8 picked'),
      target_at: DateTime.now().setZone(TZ).plus({ days: 2 }).set({ hour: 10 }).toUTC().toISO(),
      deadline_at: deadline.toUTC().toISO(),
    })
    try {
      const stored = await stateOf(page, bare)
      expect(stored.target_at).toBeNull()
      expect(stored.target_auto).toBe(false)
      await withPreferences(page, { default_grouping: 'new' }, async () => {
        let sheet = await openEditor(page, bare)
        await expect(sheet.locator('[data-quick-panel-no-target]')).toHaveText('No target')
        await expect(sheet.locator('[data-quick-panel-auto-target]')).toHaveCount(0)
        const lead = sheet.locator('[data-quick-panel-lead]')
        await expect(sheet.locator('[data-task-model-fields]')).toContainText('Lead time')
        await expect(lead.getByRole('group', { name: 'Lead time' })).toBeVisible()
        const from = DateTime.fromISO(String(stored.lead_from), { zone: TZ }).toFormat('ccc LLL d')
        await expect(lead.locator('[data-lead-words]')).toHaveText(
          `On the deadlines page from ${from} (3 days before)`,
        )
        // The stepper: one more day, previewed, then saved as the override.
        await lead.getByRole('button', { name: 'One day more' }).tap()
        await expect(lead.locator('[data-lead-days]')).toHaveText('4 days')
        await expect(lead.locator('[data-lead-words]')).toContainText('(4 days before)')
        await sheet.getByRole('button', { name: 'Save' }).tap()
        await expect.poll(async () => (await stateOf(page, bare)).lead_days).toBe(4)
        await page.keyboard.press('Escape')

        // A picked target: its Lead row is Upcoming's (2026-10-25) — two days
        // out, set today: the day before only — never the deadlines page's.
        // … → Remove target → the deadlines page's Lead row → Save.
        sheet = await openEditor(page, picked)
        await expect(sheet.locator('[data-quick-panel-lead="deadline"]')).toHaveCount(0)
        await expect(
          sheet.locator('[data-quick-panel-lead="upcoming"] [data-lead-words]'),
        ).toHaveText(/^Tomorrow on \w{3} \w{3} \d+ \(the day before\)$/)
        await sheet.getByRole('button', { name: 'More options' }).tap()
        const reset = page.locator('[data-target-reset="remove"]')
        await expect(reset).toHaveText('Remove target')
        await reset.tap()
        await expect(sheet.locator('[data-quick-panel-no-target]')).toBeVisible()
        await expect(sheet.locator('[data-quick-panel-lead="deadline"]')).toBeVisible()
        await sheet.getByRole('button', { name: 'Save' }).tap()
        await expect.poll(async () => (await stateOf(page, picked)).target_at).toBeNull()
        expect((await stateOf(page, picked)).target_auto).toBe(false)
      })
    } finally {
      await remove(page, [bare, picked])
    }
  })

  test('the target picker offers "Before the deadline" (not "Morning of the deadline"), and fits at 375', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    const prefs = (await (await page.request.get('/api/user/preferences')).json()).data
    const morning = String(prefs.morning_time)
    // Three days out at 5:30 AM. The editor's picker replaced its "Morning of
    // the deadline" pick with the relative-target block (ruling 4, 2026-10-24);
    // its control opens on the day before at Default task time (ruling 10).
    const deadline = DateTime.now().setZone(TZ).plus({ days: 3 }).set({ hour: 5, minute: 30 })
    const id = await create(page, {
      title: uniqueTitle('TM8 morning of'),
      deadline_at: deadline.toUTC().toISO(),
    })
    try {
      await withPreferences(page, { default_grouping: 'new' }, async () => {
        const sheet = await openEditor(page, id)
        await sheet.locator('[data-quick-panel-no-target]').tap()
        await expect(page.locator('[data-quick-pick]')).toHaveCount(0)
        const block = page.locator('[data-before-deadline]')
        await expect(block).toBeVisible()
        const [h, m] = morning.split(':').map(Number)
        const expected = deadline
          .minus({ days: 1 })
          .set({ hour: h, minute: m, second: 0, millisecond: 0 })
        const set = block.locator('[data-relative-set]')
        await expect(set).toHaveText(`Set ${expected.toFormat('ccc LLL d, h:mm a')}`)
        // It wraps inside the picker rather than widening it past the screen.
        const box = (await block.boundingBox())!
        expect(box.x).toBeGreaterThanOrEqual(0)
        expect(box.x + box.width).toBeLessThanOrEqual(375)
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
        ).toBe(true)
        await settle(page)
        await page.screenshot({ path: '.tmp/screens/before-deadline-375.png' })
        await set.tap()
        await expect(sheet.locator('[data-target-relative]')).toContainText('the day before')
        await sheet.getByRole('button', { name: 'Save' }).tap()
        await expect
          .poll(async () => Date.parse(String((await stateOf(page, id)).target_at)))
          .toBe(expected.toMillis())
        expect((await stateOf(page, id)).target_days_before).toBe(1)
      })
    } finally {
      await remove(page, [id])
    }
  })
})
