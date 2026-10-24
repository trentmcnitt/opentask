/**
 * RELATIVE TARGETS IN THE EDITOR (2026-10-24, plan-relative-targets §9):
 *
 * - the target picker's "Before the deadline" block on a one-off with a
 *   deadline ahead: a period chip ("The day before" · "<period> · 7:15 PM")
 *   and the full control ([N days before ▾] at [<period> ▾], Set) stage a
 *   target that moves with the deadline — one PATCH, the period sent alone;
 * - the Target row: "… · the day before, <period> · moves with the deadline";
 *   a staged deadline shows the target it gives; a pad tap makes it fixed;
 * - Settings → Reminder periods: a retime moves the linked target and the
 *   toast counts it ("1 target follows"); a removal keeps its time ("1
 *   target keeps 7:45 PM");
 * - every-time mode on a deadline-anchored repeat uses the same control.
 *
 * At 1280 light and 375 dark. The E2E user is shared with every other spec:
 * the tests add a period of their own ("Relative eve") and remove it after,
 * and every task is created under a unique title and trashed in `finally`.
 * Dates are worked out at run time, so it passes on any day.
 */
import { DateTime } from 'luxon'
import { test, expect, uniqueTitle, waitForPrefsLoaded, withPreferences } from './fixtures'
import type { Locator, Page, Request } from '@playwright/test'

const TZ = process.env.E2E_TZ || 'America/Chicago'
test.use({ timezoneId: TZ })
test.describe.configure({ mode: 'serial' })

const PERIOD = 'Relative eve'
const unified = { default_grouping: 'unified' }

interface Slot {
  id: number
  label: string
  start_time: string
}

type TaskState = Record<string, unknown> & {
  target_at: string | null
  deadline_at: string | null
  target_days_before: number | null
  target_time: string | null
  target_slot_id: number | null
}

async function create(page: Page, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data })
  expect(res.ok(), await res.text()).toBeTruthy()
  return (await res.json()).data.id as number
}

async function stateOf(page: Page, id: number): Promise<TaskState> {
  return (await (await page.request.get(`/api/tasks/${id}`)).json()).data as TaskState
}

async function trash(page: Page, ids: number[]) {
  if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
}

/** The test's own period at `start` (a leftover from an aborted run is replaced). */
async function addPeriod(page: Page, start: string): Promise<Slot> {
  await removePeriod(page)
  const res = await page.request.post('/api/time-slots', {
    data: { label: PERIOD, start_time: start },
  })
  expect(res.ok(), await res.text()).toBeTruthy()
  return (await res.json()).data as Slot
}

async function removePeriod(page: Page) {
  const slots = (await (await page.request.get('/api/time-slots')).json()).data.time_slots as Slot[]
  for (const s of slots.filter((x) => x.label === PERIOD)) {
    await page.request.delete(`/api/time-slots/${s.id}`)
  }
}

/** A deadline `days` out at 8:30 AM local. */
function deadlineIn(days: number): DateTime {
  return DateTime.now()
    .setZone(TZ)
    .plus({ days })
    .set({ hour: 8, minute: 30, second: 0, millisecond: 0 })
}

/** Every PATCH of the task, recorded from now on. */
function patches(page: Page, id: number): Request[] {
  const seen: Request[] = []
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && new URL(r.url()).pathname === `/api/tasks/${id}`) seen.push(r)
  })
  return seen
}

/** Every running animation (a picker opening) has finished, for a screenshot. */
async function settle(page: Page) {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))
}

async function noSideScroll(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true)
}

/** Pick a day in the open picker's calendar (the next month's page when needed). */
async function pickDay(page: Page, day: DateTime) {
  const key = await page.evaluate(
    ([y, m, d]) => new Date(y, m - 1, d).toLocaleDateString(),
    [day.year, day.month, day.day],
  )
  const cell = page.locator(`button[data-day="${key}"]`).first()
  if ((await cell.count()) === 0) await page.getByRole('button', { name: /next month/i }).click()
  await cell.click()
}

async function pick(page: Page, select: Locator, option: string | RegExp) {
  await select.click()
  await page.getByRole('option', { name: option }).click()
}

/**
 * "-1 day" on the pad makes a relative target FIXED (ruling 1), counted from
 * the date the row shows; Save stores it with the offsets and the link gone.
 * (A day on from the day before would stop at the deadline.)
 */
async function padTapMakesFixed(page: Page, dialog: Locator, id: number, expected: DateTime) {
  await dialog.getByRole('button', { name: '-1 day', exact: true }).click()
  await expect(dialog.locator('[data-target-relative]')).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(async () => (await stateOf(page, id)).target_slot_id).toBeNull()
  const after = await stateOf(page, id)
  expect(after.target_days_before).toBeNull()
  expect(Date.parse(after.target_at!)).toBe(expected.toMillis())
}

test.describe('Relative targets — the shared period list', () => {
  test.use({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' })

  test("the editor reads the page's periods: opening it twice on the dashboard makes no time-slots request", async ({
    authenticatedPage: page,
  }) => {
    const id = await create(page, {
      title: uniqueTitle('Book the car service'),
      deadline_at: deadlineIn(6).toUTC().toISO(),
    })
    try {
      await withPreferences(page, unified, async () => {
        const row = page.locator(`#task-row-${id}`)
        await waitForPrefsLoaded(page, () => page.goto('/'), row)
        // The dashboard ships its periods with the page (the shared list,
        // `useTimeSlots`): the editor reads them, it never fetches its own.
        const fetched: string[] = []
        page.on('request', (r) => {
          if (new URL(r.url()).pathname === '/api/time-slots') fetched.push(r.method())
        })
        for (let open = 0; open < 2; open++) {
          await row.evaluate((el) => el.scrollIntoView({ block: 'center' }))
          await row.dblclick()
          const dialog = page.getByRole('dialog')
          await dialog.getByRole('button', { name: 'Target: change' }).click()
          // The chips are there at once: no wait on the network.
          await expect(
            page
              .locator('[data-before-deadline]')
              .getByRole('button', { name: 'The day before, Evening · 8:30 PM', exact: true }),
          ).toBeVisible()
          await page.keyboard.press('Escape')
          await expect(page.locator('[data-before-deadline]')).toHaveCount(0)
          await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
          await expect(dialog).toHaveCount(0)
        }
        expect(fetched).toEqual([])
      })
    } finally {
      await trash(page, [id])
    }
  })
})

test.describe('Relative targets — desktop, light', () => {
  test.use({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' })

  /** The task's Quick panel from the dashboard (a double-click on its row). */
  async function openPanel(page: Page, id: number): Promise<Locator> {
    const row = page.locator(`#task-row-${id}`)
    await waitForPrefsLoaded(page, () => page.goto('/'), row)
    await row.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await row.dblclick()
    const dialog = page.getByRole('dialog')
    await expect(dialog.locator('[data-this-one]')).toBeVisible()
    return dialog
  }

  test('a chip sets it; the deadline moves and the target follows; a pad tap makes it fixed', async ({
    authenticatedPage: page,
  }) => {
    const period = await addPeriod(page, '19:15')
    const deadline = deadlineIn(6)
    const id = await create(page, {
      title: uniqueTitle('Return the library books'),
      deadline_at: deadline.toUTC().toISO(),
    })
    try {
      await withPreferences(page, unified, async () => {
        let dialog = await openPanel(page, id)
        await dialog.getByRole('button', { name: 'Target: change' }).click()
        const block = page.locator('[data-before-deadline]')
        await expect(block).toBeVisible()
        await expect(block).toContainText('Before the deadline')
        // The editor's old "Morning of the deadline" pick is gone (ruling 4).
        await expect(page.locator('[data-quick-pick]')).toHaveCount(0)
        const chip = block.getByRole('button', {
          name: `The day before, ${PERIOD} · 7:15 PM`,
          exact: true,
        })
        // Its deadline-day twin is after the 8:30 AM deadline: greyed.
        await expect(
          block.getByRole('button', {
            name: `The deadline day, ${PERIOD} · 7:15 PM, after the deadline`,
          }),
        ).toBeDisabled()
        await settle(page)
        await page.screenshot({ path: '.tmp/rt-picker-1280-light.png' })

        const sent = patches(page, id)
        await chip.click()
        await expect(block).toHaveCount(0)
        const eve = deadline.minus({ days: 1 }).set({ hour: 19, minute: 15 })
        const row = dialog.locator('[data-quick-panel-date]')
        await expect(row).toContainText(eve.toFormat('LLL d, h:mm a'))
        await expect(row.locator('[data-target-relative]')).toHaveText(
          `· the day before, ${PERIOD} · moves with the deadline`,
        )
        await expect(row.locator('[data-target-relative]')).toHaveClass(/text-blue-500/)
        await dialog.getByRole('button', { name: 'Save', exact: true }).click()
        await expect(dialog).toHaveCount(0)
        await expect.poll(() => sent.length).toBe(1)
        expect(sent[0].postDataJSON()).toEqual({ target_days_before: 1, target_slot_id: period.id })
        const after = await stateOf(page, id)
        expect(after).toMatchObject({
          target_days_before: 1,
          target_time: '19:15',
          target_slot_id: period.id,
        })
        expect(Date.parse(after.target_at!)).toBe(eve.toMillis())

        // Saved: the row says so, not blue.
        dialog = await openPanel(page, id)
        const saved = dialog.locator('[data-quick-panel-date] [data-target-relative]')
        await expect(saved).toHaveText(`· the day before, ${PERIOD} · moves with the deadline`)
        await expect(saved).not.toHaveClass(/text-blue-500/)
        await settle(page)
        await page.screenshot({ path: '.tmp/rt-row-1280-light.png' })

        // The deadline two days later: the staged row shows the target it gives.
        const later = deadline.plus({ days: 2 })
        await dialog.locator('[data-quick-panel-deadline]').click()
        await pickDay(page, later)
        await page.getByRole('button', { name: 'Set Date', exact: true }).click()
        const follows = later.minus({ days: 1 }).set({ hour: 19, minute: 15 })
        await expect(dialog.locator('[data-quick-panel-date]')).toContainText(
          follows.toFormat('LLL d, h:mm a'),
        )
        await expect(dialog.locator('[data-target-relative]')).toHaveClass(/text-blue-500/)
        await dialog.getByRole('button', { name: 'Save', exact: true }).click()
        await expect(dialog).toHaveCount(0)
        await expect
          .poll(async () => Date.parse((await stateOf(page, id)).target_at!))
          .toBe(follows.toMillis())
        expect((await stateOf(page, id)).target_slot_id).toBe(period.id)

        // A pad tap makes it fixed (ruling 1): from the date the row shows.
        await padTapMakesFixed(page, await openPanel(page, id), id, follows.minus({ days: 1 }))
      })
    } finally {
      await trash(page, [id])
      await removePeriod(page)
    }
  })

  test('the control sets "2 days before at <period>"; a Settings retime moves it, and removing the period keeps its time', async ({
    authenticatedPage: page,
  }) => {
    const period = await addPeriod(page, '19:15')
    const deadline = deadlineIn(6)
    const id = await create(page, {
      title: uniqueTitle('Renew the parking permit'),
      deadline_at: deadline.toUTC().toISO(),
    })
    try {
      await withPreferences(page, unified, async () => {
        const dialog = await openPanel(page, id)
        await dialog.getByRole('button', { name: 'Target: change' }).click()
        const block = page.locator('[data-before-deadline]')
        await pick(
          page,
          block.getByRole('combobox', { name: 'Days before the deadline' }),
          /^2 days before/,
        )
        await pick(
          page,
          block.getByRole('combobox', { name: 'Target follows' }),
          `${PERIOD} · 7:15 PM`,
        )
        const two = deadline.minus({ days: 2 }).set({ hour: 19, minute: 15 })
        const set = block.locator('[data-relative-set]')
        await expect(set).toHaveText(`Set ${two.toFormat('ccc LLL d, h:mm a')}`)
        await set.click()
        await expect(dialog.locator('[data-target-relative]')).toHaveText(
          `· 2 days before, ${PERIOD} · moves with the deadline`,
        )
        await dialog.getByRole('button', { name: 'Save', exact: true }).click()
        await expect(dialog).toHaveCount(0)
        await expect.poll(async () => (await stateOf(page, id)).target_slot_id).toBe(period.id)
        expect(Date.parse((await stateOf(page, id)).target_at!)).toBe(two.toMillis())
      })

      // Settings → Reminder periods: the retime moves it and the toast counts it.
      await page.goto('/settings')
      const start = page.getByTestId('reminder-periods').getByLabel(`Start time of ${PERIOD}`)
      await start.fill('19:45')
      await start.press('Enter')
      await expect(
        page.getByText(`${PERIOD} now starts at 7:45 PM · 1 target follows`),
      ).toBeVisible()
      await expect.poll(async () => (await stateOf(page, id)).target_time).toBe('19:45')
      expect(Date.parse((await stateOf(page, id)).target_at!)).toBe(
        deadline.minus({ days: 2 }).set({ hour: 19, minute: 45 }).toMillis(),
      )

      // Removing it keeps the time (custom now), and the toast says so.
      await page
        .getByTestId('reminder-periods')
        .getByRole('button', { name: `Remove ${PERIOD}` })
        .click()
      await expect(
        page.getByText(new RegExp(`Removed "${PERIOD}".* · 1 target keeps 7:45 PM`)),
      ).toBeVisible()
      await expect.poll(async () => (await stateOf(page, id)).target_slot_id).toBeNull()
      expect((await stateOf(page, id)).target_time).toBe('19:45')
    } finally {
      await trash(page, [id])
      await removePeriod(page)
    }
  })
})

test.describe('Relative targets — phone, dark', () => {
  test.use({
    viewport: { width: 375, height: 812 },
    colorScheme: 'dark',
    hasTouch: true,
    isMobile: true,
  })

  /** Tap the row's own padding (not the title link, not the Done circle) to open the sheet. */
  async function openSheet(page: Page, id: number): Promise<Locator> {
    const row = page.locator(`#task-row-${id}`)
    await waitForPrefsLoaded(page, () => page.goto('/'), row)
    await row.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    const box = await row.boundingBox()
    if (!box) throw new Error('row not on screen')
    await row.tap({ position: { x: 56, y: box.height - 6 } })
    const sheet = page.locator('[data-slot="sheet-content"]')
    await expect(sheet.getByRole('button', { name: 'Save' })).toBeVisible()
    return sheet
  }

  test('the picker block fits a phone; the every-time panel uses the same control', async ({
    authenticatedPage: page,
  }) => {
    const period = await addPeriod(page, '19:15')
    const deadline = deadlineIn(6)
    const oneOff = await create(page, {
      title: uniqueTitle('Submit the expense report'),
      deadline_at: deadline.toUTC().toISO(),
    })
    // A weekly deadline-anchored repeat on the deadline's weekday, its target
    // the day before at the period.
    const day = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'][deadline.weekday - 1]
    const repeat = await create(page, {
      title: uniqueTitle('Put the bins out'),
      rrule: `FREQ=WEEKLY;BYDAY=${day};BYHOUR=8;BYMINUTE=30`,
      repeat_anchor: 'deadline',
      deadline_at: deadline.toUTC().toISO(),
      target_days_before: 1,
      target_slot_id: period.id,
    })
    try {
      await withPreferences(page, unified, async () => {
        let sheet = await openSheet(page, oneOff)
        await sheet.getByRole('button', { name: 'Target: change' }).tap()
        const block = page.locator('[data-before-deadline]')
        await expect(block).toBeVisible()
        const box = (await block.boundingBox())!
        expect(box.x).toBeGreaterThanOrEqual(0)
        expect(box.x + box.width).toBeLessThanOrEqual(375)
        await noSideScroll(page)
        await settle(page)
        await page.screenshot({ path: '.tmp/rt-picker-375-dark.png' })
        await block
          .getByRole('button', { name: `The day before, ${PERIOD} · 7:15 PM`, exact: true })
          .tap()
        await expect(sheet.locator('[data-target-relative]')).toHaveText(
          `· the day before, ${PERIOD} · moves with the deadline`,
        )
        await settle(page)
        await page.screenshot({ path: '.tmp/rt-row-375-dark.png' })
        await sheet.getByRole('button', { name: 'Save', exact: true }).tap()
        await expect.poll(async () => (await stateOf(page, oneOff)).target_slot_id).toBe(period.id)

        // Every time: the same control, on the repeat.
        sheet = await openSheet(page, repeat)
        await expect(sheet.locator('[data-quick-panel-deadline-repeat]')).toHaveText(
          `· target the day before at ${PERIOD} (7:15 PM)`,
        )
        await sheet.locator('[data-quick-panel-repeat-link]').tap()
        const region = sheet.getByRole('region', { name: 'Editing every time' })
        const control = region.locator(
          '[data-every-time-relative-target] [data-relative-target-control]',
        )
        await expect(control).toBeVisible()
        await expect(
          control.getByRole('combobox', { name: 'Days before the deadline' }),
        ).toHaveText('the day before')
        const follows = control.getByRole('combobox', { name: 'Target follows' })
        await expect(follows).toHaveText(`${PERIOD} · 7:15 PM`)
        await expect(control.getByRole('combobox', { name: 'Target time' })).toHaveCount(0)
        await noSideScroll(page)
        await settle(page)
        await page.screenshot({ path: '.tmp/rt-every-time-375-dark.png' })

        // "Custom time…" keeps the time and drops the link: one PATCH, the time alone.
        const sent = patches(page, repeat)
        await follows.tap()
        await page.getByRole('option', { name: 'Custom time…' }).tap()
        await expect(control.getByRole('combobox', { name: 'Target time' })).toHaveText('7:15 PM')
        await region.getByRole('button', { name: 'Save', exact: true }).tap()
        await expect.poll(() => sent.length).toBe(1)
        expect(sent[0].postDataJSON()).toEqual({ target_days_before: 1, target_time: '19:15' })
        await expect.poll(async () => (await stateOf(page, repeat)).target_slot_id).toBeNull()
      })
    } finally {
      await trash(page, [oneOff, repeat])
      await removePeriod(page)
    }
  })
  test('create mode: a deadline staged, then a chip — Create Task sends the offsets and the period, no target_at', async ({
    authenticatedPage: page,
  }) => {
    const period = await addPeriod(page, '19:15')
    const title = uniqueTitle('Pay the water bill')
    let ids: number[] = []
    try {
      await page.goto('/')
      await page.waitForSelector('[id^="task-row-"], .text-4xl, [data-now-summary]')
      await page.getByRole('button', { name: 'Add', exact: true }).click()
      await page.getByRole('textbox', { name: 'Quick add task' }).fill(title)
      await page.getByRole('button', { name: 'Open full add form' }).click()
      const form = page.getByRole('dialog', { name: 'New Task' })
      // The deadline (the picker opens on the user's morning time).
      await form.locator('[data-quick-panel-deadline]').tap()
      await pickDay(page, deadlineIn(6))
      await page.getByRole('button', { name: 'Set Date', exact: true }).tap()
      // Then the target, relative to it.
      await form.getByRole('button', { name: 'Target: change' }).tap()
      await page
        .locator('[data-before-deadline]')
        .getByRole('button', { name: `The day before, ${PERIOD} · 7:15 PM`, exact: true })
        .tap()
      await expect(form.locator('[data-target-relative]')).toHaveText(
        `· the day before, ${PERIOD} · moves with the deadline`,
      )
      const posted = page.waitForRequest(
        (r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/tasks',
      )
      await form.getByRole('button', { name: 'Create Task' }).tap()
      const body = (await posted).postDataJSON()
      expect(body).toMatchObject({ target_days_before: 1, target_slot_id: period.id })
      expect(body.due_at).toBeUndefined()
      expect(body.target_time).toBeUndefined()
      expect(typeof body.deadline_at).toBe('string')
      await expect(form).toHaveCount(0)
      const found = await page.request.get(`/api/tasks?search=${encodeURIComponent(title)}`)
      const tasks = (await found.json()).data.tasks as TaskState[]
      ids = tasks.map((t) => t.id as number)
      expect(tasks).toHaveLength(1)
      const deadline = DateTime.fromISO(tasks[0].deadline_at!).setZone(TZ)
      expect(Date.parse(tasks[0].target_at!)).toBe(
        deadline.minus({ days: 1 }).set({ hour: 19, minute: 15 }).toMillis(),
      )
      expect(tasks[0].target_slot_id).toBe(period.id)
    } finally {
      await trash(page, ids)
      await removePeriod(page)
    }
  })
})
