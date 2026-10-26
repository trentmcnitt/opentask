/**
 * THE TASK EDITOR'S "EVERY TIME" MODE (2026-10-22, editor plan §14.3; PR 4c):
 * the Quick panel's this-one rows, the "↻ Repeats — … · edit every time ›"
 * link, and the every-time mode — each Save one PATCH and one undo
 * entry, checked against the server.
 *
 * Seeds its own Home Depot-like tasks (never anyone's real ones); every task
 * is trashed in `finally`. Times are the user's (America/Chicago); dates are
 * worked out at run time, so it passes on any day.
 */
import { DateTime } from 'luxon'
import {
  test,
  expect,
  cmdClickRow,
  uniqueTitle,
  waitForPrefsLoaded,
  withPreferences,
} from './fixtures'
import type { Locator, Page, Request } from '@playwright/test'
import { createModeTask, draftFromTask } from '@/lib/every-time'
import { CALENDAR_DAY_START } from '@/lib/opentask-day'

const TZ = process.env.E2E_TZ || 'America/Chicago'

const WEEKDAY_NAMES: Record<string, string> = {
  MO: 'Monday',
  TU: 'Tuesday',
  WE: 'Wednesday',
  TH: 'Thursday',
  FR: 'Friday',
  SA: 'Saturday',
  SU: 'Sunday',
}

/**
 * A weekday that is NOT already in a fresh rule's placeholder (weekly on
 * "today's" weekday), read through the product's own rule
 * (`draftFromTask(createModeTask({}))`, src/lib/every-time.ts), so clicking it
 * is always a change: a hard-coded "Monday" was a no-op every Monday. It
 * follows the product if its notion of "today" changes.
 */
function weekdayOtherThanPlaceholder(): string {
  const draft = draftFromTask(createModeTask({}), {
    timezone: TZ,
    morningTime: '09:00',
    now: new Date(),
    // The E2E server runs with the task queue off, so the browser's day is
    // the calendar day (`useDayStart` → midnight).
    dayStart: CALENDAR_DAY_START,
  })
  const code = Object.keys(WEEKDAY_NAMES).find((d) => !draft.rule.days.includes(d))!
  return WEEKDAY_NAMES[code]
}
test.use({ timezoneId: TZ })

const FRIDAYS_4PM = 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=16;BYMINUTE=0'
const unified = { default_grouping: 'unified' }

type TaskState = Record<string, unknown> & {
  rrule: string | null
  due_at: string | null
  deadline_at: string | null
  repeat_anchor: string | null
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

/** The next local `weekday` (1 = Mon … 7 = Sun) at `hour`, at least a day out. */
function nextWeekday(weekday: number, hour: number): DateTime {
  let d = DateTime.now().setZone(TZ).plus({ days: 2 }).startOf('day')
  while (d.weekday !== weekday) d = d.plus({ days: 1 })
  return d.set({ hour })
}

/** The next month's 1st Saturday at 8 AM whose eve (6 PM, or `eveHour`) is still ahead. */
function nextFirstSaturday(eveHour = 18): DateTime {
  let month = DateTime.now().setZone(TZ).startOf('month')
  for (;;) {
    let d = month
    while (d.weekday !== 6) d = d.plus({ days: 1 })
    const at = d.set({ hour: 8 })
    if (at.minus({ days: 1 }).set({ hour: eveHour }) > DateTime.now()) return at
    month = month.plus({ months: 1 })
  }
}

/** "Register for Home Depot Craft": monthly, 1st Saturday 8 AM, the target the day before at 6 PM. */
function homeDepot(page: Page) {
  return create(page, {
    title: uniqueTitle('Register for Home Depot Craft'),
    rrule: 'FREQ=MONTHLY;BYDAY=1SA;BYHOUR=8;BYMINUTE=0',
    repeat_anchor: 'deadline',
    deadline_at: nextFirstSaturday().toUTC().toISO(),
    target_days_before: 1,
    target_time: '18:00',
  })
}

/** A weekly deadline-anchored repeat: Saturdays 8 AM, the target Friday 6 PM. */
function weeklyDeadline(page: Page, title = 'Weekly deadline') {
  return create(page, {
    title: uniqueTitle(title),
    rrule: 'FREQ=WEEKLY;BYDAY=SA;BYHOUR=8;BYMINUTE=0',
    repeat_anchor: 'deadline',
    deadline_at: nextWeekday(6, 8).toUTC().toISO(),
    target_days_before: 1,
    target_time: '18:00',
  })
}

/** Open the task's Quick panel from the dashboard (desktop: a double-click on its row). */
async function openPanel(page: Page, id: number): Promise<Locator> {
  const row = page.locator(`#task-row-${id}`)
  await waitForPrefsLoaded(page, () => page.goto('/'), row)
  await row.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await row.dblclick()
  const dialog = page.getByRole('dialog')
  await expect(dialog.locator('[data-this-one]')).toBeVisible()
  return dialog
}

/** The link into every-time mode, then the mode itself. */
async function enterEveryTime(dialog: Locator): Promise<Locator> {
  await dialog.locator('[data-quick-panel-repeat-link]').click()
  const region = dialog.getByRole('region', { name: 'Editing every time' })
  await expect(region).toBeVisible()
  await expect(region.getByRole('heading', { name: 'Editing every time' })).toBeFocused()
  return region
}

async function pick(page: Page, select: Locator, option: string | RegExp) {
  await select.click()
  await page.getByRole('option', { name: option }).click()
}

/** Every PATCH of the task, recorded from now on. */
function patches(page: Page, id: number): Request[] {
  const seen: Request[] = []
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && new URL(r.url()).pathname === `/api/tasks/${id}`) seen.push(r)
  })
  return seen
}

function nextDates(region: Locator) {
  return region.locator('[data-every-time-next] [data-next-date]')
}

test('Home Depot: Next shows three occurrences, one per line; "2 days before" saves in one PATCH, and Undo restores', async ({
  authenticatedPage: page,
}) => {
  const id = await homeDepot(page)
  try {
    await withPreferences(page, unified, async () => {
      const before = await stateOf(page, id)
      const dialog = await openPanel(page, id)
      await expect(dialog.locator('[data-quick-panel-deadline-repeat]')).toHaveText(
        '· target the day before at 6:00 PM',
      )
      await expect(dialog.locator('[data-quick-panel-repeat-link]')).toContainText(
        'Monthly on the 1st Sat, deadline 8:00 AM',
      )
      const region = await enterEveryTime(dialog)
      await expect(region.getByRole('radio', { name: 'Deadline' })).toHaveAttribute(
        'aria-checked',
        'true',
      )
      await expect(nextDates(region)).toHaveCount(3)
      await expect(nextDates(region).first()).toHaveText(
        /^Sat [A-Z][a-z]{2} \d+ · deadline 8:00 AM · target Fri( [A-Z][a-z]{2} \d+)? 6:00 PM$/,
      )
      // Opening changes nothing.
      await expect(region.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()

      const sent = patches(page, id)
      await pick(
        page,
        region.getByRole('combobox', { name: 'Days before the deadline' }),
        /^2 days before/,
      )
      await expect(region.locator('[data-every-time-hint]')).toContainText('starting with this one')
      await region.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      const toast = page.locator('[data-sonner-toast]', { hasText: 'Target 2 days before' })
      await expect(toast).toBeVisible()
      expect(sent).toHaveLength(1)
      expect(sent[0].postDataJSON()).toEqual({ target_days_before: 2, target_time: '18:00' })
      const after = await stateOf(page, id)
      expect(after.target_days_before).toBe(2)
      expect(Date.parse(after.due_at!)).toBe(
        DateTime.fromISO(before.due_at!).minus({ days: 1 }).toMillis(),
      )

      await toast.getByRole('button', { name: 'Undo' }).click()
      await expect.poll(async () => (await stateOf(page, id)).target_days_before).toBe(1)
      expect((await stateOf(page, id)).due_at).toBe(before.due_at)
    })
  } finally {
    await trash(page, [id])
  }
})

test('"+ Add" an 8 AM deadline to a 4 PM target: the day before, one PATCH that switches the anchor', async ({
  authenticatedPage: page,
}) => {
  const id = await create(page, {
    title: uniqueTitle('Weekly allowance ($8)'),
    rrule: FRIDAYS_4PM,
  })
  try {
    await withPreferences(page, unified, async () => {
      const before = await stateOf(page, id)
      const dialog = await openPanel(page, id)
      // A target-anchored repeat's Deadline row says None and opens every-time with "+ Add" focused.
      const deadline = dialog.locator('[data-quick-panel-deadline]')
      await expect(deadline).toHaveText('None')
      await deadline.click()
      const region = dialog.getByRole('region', { name: 'Editing every time' })
      const add = region.locator('[data-every-time-add-deadline]')
      await expect(add).toBeFocused()

      await add.click()
      await page.getByRole('option', { name: '8:00 AM', exact: true }).click()
      await expect(region.getByRole('radio', { name: 'Deadline' })).toHaveAttribute(
        'aria-checked',
        'true',
      )
      await expect(region.getByRole('combobox', { name: 'Days before the deadline' })).toHaveText(
        'the day before',
      )
      await expect(region.getByRole('combobox', { name: 'Target time' })).toHaveText('4:00 PM')
      await expect(nextDates(region).first()).toHaveText(
        /^Sat [A-Z][a-z]{2} \d+ · deadline 8:00 AM · target Fri( [A-Z][a-z]{2} \d+)? 4:00 PM$/,
      )

      const sent = patches(page, id)
      await region.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expect.poll(() => sent.length).toBe(1)
      const body = sent[0].postDataJSON()
      expect(body).toMatchObject({
        repeat_anchor: 'deadline',
        rrule: 'FREQ=WEEKLY;BYDAY=SA;BYHOUR=8;BYMINUTE=0',
        target_days_before: 1,
        target_time: '16:00',
      })
      const after = await stateOf(page, id)
      expect(after.repeat_anchor).toBe('deadline')
      // The target stays exactly where it was: Fri 4 PM, the deadline Sat 8 AM.
      expect(after.due_at).toBe(before.due_at)
      expect(DateTime.fromISO(after.deadline_at!).setZone(TZ).toFormat('ccc h:mm a')).toBe(
        'Sat 8:00 AM',
      )
    })
  } finally {
    await trash(page, [id])
  }
})

test("Repeats on → Target: the deadline goes; a 1st-Saturday rule that can't move is refused inline", async ({
  authenticatedPage: page,
}) => {
  const weekly = await weeklyDeadline(page)
  const monthly = await homeDepot(page)
  try {
    await withPreferences(page, unified, async () => {
      let dialog = await openPanel(page, weekly)
      let region = await enterEveryTime(dialog)
      await region.getByRole('radio', { name: 'Target' }).click()
      await expect(region.getByRole('combobox', { name: 'Target time' })).toHaveText('6:00 PM')
      await expect(region.locator('[data-every-time-add-deadline]')).toBeVisible()
      await region.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expect.poll(async () => (await stateOf(page, weekly)).repeat_anchor).toBe('target')
      const after = await stateOf(page, weekly)
      expect(after.deadline_at).toBeNull()
      expect(after.rrule).toBe('FREQ=WEEKLY;BYDAY=FR;BYHOUR=18;BYMINUTE=0')

      dialog = await openPanel(page, monthly)
      region = await enterEveryTime(dialog)
      await region.getByRole('radio', { name: 'Target' }).click()
      await expect(region.locator('[data-every-time-problem]')).toContainText(
        "can't be written as their own days",
      )
      await expect(region.getByRole('radio', { name: 'Deadline' })).toHaveAttribute(
        'aria-checked',
        'true',
      )
    })
  } finally {
    await trash(page, [weekly, monthly])
  }
})

test('Stop repeating: a one-time task that keeps its target and deadline', async ({
  authenticatedPage: page,
}) => {
  const id = await weeklyDeadline(page, 'Stop me')
  try {
    await withPreferences(page, unified, async () => {
      const before = await stateOf(page, id)
      const dialog = await openPanel(page, id)
      const region = await enterEveryTime(dialog)
      await region.locator('[data-every-time-stop]').click()
      await expect(region.locator('[data-every-time-hint]')).toContainText(
        'This one stays as a one-time task',
      )
      const sent = patches(page, id)
      await region.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expect.poll(() => sent.length).toBe(1)
      expect(sent[0].postDataJSON()).toEqual({ rrule: null })
      const after = await stateOf(page, id)
      expect(after.rrule).toBeNull()
      expect(after.deadline_at).toBe(before.deadline_at)
      expect(after.due_at).toBe(before.due_at)
    })
  } finally {
    await trash(page, [id])
  }
})

test('a repeating task: the target has no Clear, and nothing in this mode removes the rule', async ({
  authenticatedPage: page,
}) => {
  const id = await create(page, { title: uniqueTitle('No clear'), rrule: FRIDAYS_4PM })
  try {
    await withPreferences(page, unified, async () => {
      const dialog = await openPanel(page, id)
      await dialog.locator('[data-quick-panel-date]').click()
      await expect(page.getByRole('button', { name: 'Set Date' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Clear', exact: true })).toHaveCount(0)
      await page.keyboard.press('Escape')
      await dialog.getByRole('button', { name: 'More options' }).click()
      await expect(page.getByRole('menuitem', { name: /Remove target/ })).toHaveCount(0)
      await page.keyboard.press('Escape')
      expect((await stateOf(page, id)).rrule).toBe(FRIDAYS_4PM)
    })
  } finally {
    await trash(page, [id])
  }
})

test('a refused choice is greyed, a problem disables Save, and no request goes out', async ({
  authenticatedPage: page,
}) => {
  // Daily, deadline 8 AM, the target the day before at 6 PM: two days
  // before would land on or before the previous deadline.
  const daily = await create(page, {
    title: uniqueTitle('Daily deadline'),
    rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0',
    repeat_anchor: 'deadline',
    deadline_at: DateTime.now()
      .setZone(TZ)
      .plus({ days: 2 })
      .set({ hour: 8, minute: 0 })
      .toUTC()
      .toISO(),
    target_days_before: 1,
    target_time: '18:00',
  })
  const fridays = await create(page, { title: uniqueTitle('Fridays'), rrule: FRIDAYS_4PM })
  try {
    await withPreferences(page, unified, async () => {
      let dialog = await openPanel(page, daily)
      let region = await enterEveryTime(dialog)
      await region.getByRole('combobox', { name: 'Days before the deadline' }).click()
      await expect(page.getByRole('option', { name: /^2 days before/ })).toHaveAttribute(
        'aria-disabled',
        'true',
      )
      await expect(page.getByRole('option', { name: /^the deadline day/ })).toHaveAttribute(
        'aria-disabled',
        'true',
      )
      await page.keyboard.press('Escape')
      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(dialog).toHaveCount(0)

      dialog = await openPanel(page, fridays)
      region = await enterEveryTime(dialog)
      const sent = patches(page, fridays)
      await region.getByRole('button', { name: 'Friday' }).click()
      await expect(region.locator('[data-every-time-problem]')).toHaveText('Pick at least one day.')
      const save = region.getByRole('button', { name: 'Save', exact: true })
      await expect(save).toBeDisabled()
      await save.click({ force: true })
      expect(sent).toHaveLength(0)
    })
  } finally {
    await trash(page, [daily, fridays])
  }
})

test('the link is disabled while this one has unsaved edits; Back with a changed draft asks first', async ({
  authenticatedPage: page,
}) => {
  const id = await create(page, { title: uniqueTitle('Dirty link'), rrule: FRIDAYS_4PM })
  try {
    await withPreferences(page, unified, async () => {
      const dialog = await openPanel(page, id)
      await dialog.getByRole('button', { name: '+1 hr', exact: true }).click()
      await expect(dialog.locator('[data-quick-panel-repeat-link]')).toBeDisabled()
      await dialog.getByRole('button', { name: 'Reset', exact: true }).click()
      const region = await enterEveryTime(dialog)
      await region.getByRole('button', { name: 'Saturday' }).click()
      await region.locator('[data-every-time-back]').click()
      const confirm = page.getByRole('alertdialog')
      await expect(confirm).toContainText('Discard changes to every time?')
      await confirm.getByRole('button', { name: 'Discard' }).click()
      await expect(region).toHaveCount(0)
      // Focus comes back to the link.
      await expect(dialog.locator('[data-quick-panel-repeat-link]')).toBeFocused()
      await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    })
  } finally {
    await trash(page, [id])
  }
})

test('create: "Make it repeat" → Done stages the rule; Create Task sends it', async ({
  authenticatedPage: page,
}) => {
  const title = uniqueTitle('Water the plants')
  // The full add form, the way a phone reaches it (as unsaved-edits.spec).
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto('/')
  await page.waitForSelector('[id^="task-row-"], .text-4xl, [data-now-summary]')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await page.getByRole('textbox', { name: 'Quick add task' }).fill(title)
  await page.getByRole('button', { name: 'Open full add form' }).click()
  const form = page.getByRole('dialog', { name: 'New Task' })
  await form.locator('[data-quick-panel-repeat-link]').click()
  const region = form.getByRole('region', { name: 'Editing every time' })
  await expect(region).toBeVisible()
  // Cancel leaves every time (the draft dropped) — never the whole add form.
  await region.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(region).toHaveCount(0)
  await expect(form).toBeVisible()
  await expect(form.locator('[data-quick-panel-repeat-link]')).toHaveText('Make it repeat')
  await form.locator('[data-quick-panel-repeat-link]').click()
  await pick(page, region.getByRole('combobox', { name: 'How often' }), 'Daily')
  await region.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(region).toHaveCount(0)
  await expect(form.locator('[data-quick-panel-repeat-link]')).toContainText('Daily at')
  await expect(form.locator('[data-quick-panel-repeat-link]')).toContainText('edit')

  const posted = page.waitForRequest(
    (r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/tasks',
  )
  await form.getByRole('button', { name: 'Create Task' }).click()
  const body = (await posted).postDataJSON()
  expect(body.rrule).toMatch(/^FREQ=DAILY;BYHOUR=\d+;BYMINUTE=\d+$/)
  // A fixed schedule is the default: only a change of mode is sent.
  expect(body.recurrence_mode).toBeUndefined()
  await expect(form).toHaveCount(0)
  const found = await page.request.get(`/api/tasks?search=${encodeURIComponent(title)}`)
  const tasks = (await found.json()).data.tasks as { id: number; rrule: string }[]
  expect(tasks).toHaveLength(1)
  expect(tasks[0].rrule).toBe(body.rrule)
  await trash(
    page,
    tasks.map((t) => t.id),
  )
})

test('bulk: a deadline in the selection disables it; one-offs take one rule, with one Undo', async ({
  authenticatedPage: page,
}) => {
  const soon = new Date(Date.now() + 2 * 86_400_000).toISOString()
  const a = await create(page, { title: uniqueTitle('Bulk A'), due_at: soon })
  const b = await create(page, { title: uniqueTitle('Bulk B'), due_at: soon })
  const c = await create(page, {
    title: uniqueTitle('Bulk deadline'),
    deadline_at: new Date(Date.now() + 5 * 86_400_000).toISOString(),
  })
  const row = (id: number) => page.locator(`#task-row-${id}`)
  const bar = page.locator('[data-selection-sheet]')
  try {
    await withPreferences(page, unified, async () => {
      await waitForPrefsLoaded(page, () => page.goto('/'), row(a))
      for (const id of [a, c]) await cmdClickRow(row(id))
      await bar.getByRole('button', { name: 'More', exact: true }).click()
      let dialog = page.getByRole('dialog', { name: '2 tasks selected' })
      const link = dialog.locator('[data-quick-panel-repeat-link]')
      await expect(link).toBeDisabled()
      await expect(link).toHaveAttribute(
        'title',
        'Some of these have deadlines — edit them one at a time.',
      )
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      await cmdClickRow(row(c))
      await cmdClickRow(row(b))
      await expect(bar).toContainText('2 selected')

      await bar.getByRole('button', { name: 'More', exact: true }).click()
      dialog = page.getByRole('dialog', { name: '2 tasks selected' })
      await dialog.locator('[data-quick-panel-repeat-link]').click()
      const region = dialog.getByRole('region', { name: 'Editing every time' })
      await expect(region.getByRole('radiogroup', { name: 'Repeats on' })).toHaveCount(0)
      await expect(region.getByRole('combobox', { name: 'Ends' })).toHaveCount(0)
      await expect(region.locator('[data-every-time-hint]')).toHaveText(
        'Changes apply to all 2 selected tasks.',
      )
      const sent = page.waitForRequest(
        (r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/tasks/bulk/edit',
      )
      await region.getByRole('button', { name: 'Save', exact: true }).click()
      const body = (await sent).postDataJSON()
      expect(body.changes.rrule).toMatch(/^FREQ=WEEKLY;BYDAY=[A-Z]{2};BYHOUR=\d+;BYMINUTE=\d+$/)
      expect(Object.keys(body.changes).sort()).toEqual(['recurrence_mode', 'rrule'])
      await expect.poll(async () => (await stateOf(page, a)).rrule).toBe(body.changes.rrule)
      expect((await stateOf(page, b)).rrule).toBe(body.changes.rrule)
      // One undo entry for both (the header's Undo).
      await page.getByRole('button', { name: /^Undo \(\d+ available\)$/ }).click()
      await expect.poll(async () => (await stateOf(page, a)).rrule).toBeNull()
      expect((await stateOf(page, b)).rrule).toBeNull()
    })
  } finally {
    await trash(page, [a, b, c])
  }
})

test('save-and-leave declines a half-picked end: "On date…" with no date keeps the count', async ({
  authenticatedPage: page,
}) => {
  const id = await create(page, {
    title: uniqueTitle('Six Fridays'),
    rrule: FRIDAYS_4PM,
    repeat_count: 6,
  })
  try {
    await page.goto(`/tasks/${id}`)
    await page.locator('[data-quick-panel-repeat-link]').click()
    const region = page.getByRole('region', { name: 'Editing every time' })
    await pick(page, region.getByRole('combobox', { name: 'Ends' }), 'On date…')
    await expect(region.locator('[data-every-time-problem]')).toHaveText(
      'Pick the date it ends on.',
    )
    const sent = patches(page, id)
    await page.getByRole('button', { name: 'Back to dashboard' }).click()
    const dialog = page.getByRole('alertdialog', { name: 'Unsaved Changes' })
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    // Nothing sent, still here, the end untouched.
    await expect(page).toHaveURL(`/tasks/${id}`)
    await expect(region).toBeVisible()
    expect(sent).toHaveLength(0)
    expect((await stateOf(page, id)).repeat_count).toBe(6)
  } finally {
    await trash(page, [id])
  }
})

test("a rule the editor can't hold (BYMONTHDAY=1,15) is read-only; Stop repeating still works", async ({
  authenticatedPage: page,
}) => {
  const rrule = 'FREQ=MONTHLY;BYMONTHDAY=1,15;BYHOUR=9;BYMINUTE=0'
  const id = await create(page, { title: uniqueTitle('Twice a month'), rrule })
  try {
    await withPreferences(page, unified, async () => {
      const dialog = await openPanel(page, id)
      const region = await enterEveryTime(dialog)
      await expect(region.locator('[data-every-time-locked]')).toContainText(
        "This repeat can't be edited here.",
      )
      await expect(region.getByRole('combobox', { name: 'How often' })).toHaveCount(0)
      await expect(region.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
      const sent = patches(page, id)
      await region.locator('[data-every-time-stop]').click()
      await region.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expect.poll(() => sent.length).toBe(1)
      expect(sent[0].postDataJSON()).toEqual({ rrule: null })
    })
  } finally {
    await trash(page, [id])
  }
})

test('bulk with different rules reads "Repeats — mixed"; an untouched placeholder never saves', async ({
  authenticatedPage: page,
}) => {
  const a = await create(page, { title: uniqueTitle('Mixed A'), rrule: FRIDAYS_4PM })
  const b = await create(page, {
    title: uniqueTitle('Mixed B'),
    rrule: 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0',
  })
  const row = (id: number) => page.locator(`#task-row-${id}`)
  const bar = page.locator('[data-selection-sheet]')
  try {
    await withPreferences(page, unified, async () => {
      await waitForPrefsLoaded(page, () => page.goto('/'), row(a))
      for (const id of [a, b]) await cmdClickRow(row(id))
      await bar.getByRole('button', { name: 'More', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '2 tasks selected' })
      const link = dialog.locator('[data-quick-panel-repeat-link]')
      await expect(link).toContainText('Repeats — mixed')
      await link.click()
      const region = dialog.getByRole('region', { name: 'Editing every time' })
      const save = region.getByRole('button', { name: 'Save', exact: true })
      await expect(save).toBeDisabled()
      await region.getByRole('button', { name: weekdayOtherThanPlaceholder() }).click()
      await expect(save).toBeEnabled()
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      await page.getByRole('alertdialog').getByRole('button', { name: 'Discard' }).click()
      expect((await stateOf(page, a)).rrule).toBe(FRIDAYS_4PM)
      expect((await stateOf(page, b)).rrule).toBe('FREQ=DAILY;BYHOUR=7;BYMINUTE=0')
    })
  } finally {
    await trash(page, [a, b])
  }
})

test('a deadline-anchored repeat: a new deadline previews the target it re-derives', async ({
  authenticatedPage: page,
}) => {
  const id = await weeklyDeadline(page, 'Preview target')
  try {
    await withPreferences(page, unified, async () => {
      const dialog = await openPanel(page, id)
      const target = dialog.locator('[data-quick-panel-date]')
      await expect(target).not.toContainText('moves with the deadline')
      // The deadline a day later (the picker's own time): the target, the day before, follows.
      await dialog.locator('[data-quick-panel-deadline]').click()
      const next = nextWeekday(6, 8).plus({ days: 1 })
      const key = await page.evaluate(
        ([y, m, d]) => new Date(y, m - 1, d).toLocaleDateString(),
        [next.year, next.month, next.day],
      )
      const cell = page.locator(`button[data-day="${key}"]`).first()
      if ((await cell.count()) === 0) {
        await page.getByRole('button', { name: /next month/i }).click()
      }
      await cell.click()
      await page.getByRole('button', { name: 'Set Date', exact: true }).click()
      await expect(target).toContainText('moves with the deadline')
      await expect(target).toContainText(next.minus({ days: 1 }).toFormat('ccc, LLL d'))
      await dialog.getByRole('button', { name: 'Reset', exact: true }).click()
    })
  } finally {
    await trash(page, [id])
  }
})

test.describe('Every-time mode: ends', () => {
  test('"After 3 times": Next shows three, the third "· last one"; Save sends repeat_count alone', async ({
    authenticatedPage: page,
  }) => {
    const id = await create(page, { title: uniqueTitle('Three Fridays'), rrule: FRIDAYS_4PM })
    try {
      await withPreferences(page, unified, async () => {
        const dialog = await openPanel(page, id)
        const region = await enterEveryTime(dialog)
        await pick(page, region.getByRole('combobox', { name: 'Ends' }), 'After…')
        await region.getByRole('textbox', { name: 'How many times' }).fill('3')
        await expect(nextDates(region)).toHaveCount(3)
        await expect(nextDates(region).nth(2)).toContainText('· last one')
        await expect(nextDates(region).nth(1)).not.toContainText('last one')
        await expect(region.locator('[data-every-time-ends-progress]')).toHaveText(
          'starting with this one',
        )
        const sent = patches(page, id)
        await region.getByRole('button', { name: 'Save', exact: true }).click()
        await expect(dialog).toHaveCount(0)
        await expect.poll(() => sent.length).toBe(1)
        expect(sent[0].postDataJSON()).toEqual({ repeat_count: 3 })
        const after = await stateOf(page, id)
        expect(after.repeat_count).toBe(3)
        expect(after.rrule).toBe(FRIDAYS_4PM)

        // Reopened: the link and the row say how far it has got.
        const again = await openPanel(page, id)
        await expect(again.locator('[data-quick-panel-repeat-link]')).toContainText('3 times')
        const r2 = await enterEveryTime(again)
        await expect(r2.locator('[data-every-time-ends-progress]')).toHaveText('0 of 3 so far')
      })
    } finally {
      await trash(page, [id])
    }
  })

  test('"On date" says the exact date; a past date is refused inline', async ({
    authenticatedPage: page,
  }) => {
    const id = await create(page, { title: uniqueTitle('Until Fridays'), rrule: FRIDAYS_4PM })
    const end = DateTime.now().setZone(TZ).plus({ days: 60 })
    try {
      await withPreferences(page, unified, async () => {
        const dialog = await openPanel(page, id)
        const region = await enterEveryTime(dialog)
        await pick(page, region.getByRole('combobox', { name: 'Ends' }), 'On date…')
        const day = region.getByLabel('Last day')
        await day.fill(DateTime.now().setZone(TZ).minus({ days: 3 }).toISODate()!)
        await expect(region.locator('[data-every-time-problem]')).toHaveText(
          'That end date has passed.',
        )
        await expect(region.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()

        await day.fill(end.toISODate()!)
        await expect(region.locator('[data-every-time-ends-date]')).toHaveText(
          `Ends ${end.toFormat('LLL d, yyyy')}`,
        )
        await expect(region.locator('[data-every-time-problem]')).toHaveCount(0)
        const sent = patches(page, id)
        await region.getByRole('button', { name: 'Save', exact: true }).click()
        await expect(dialog).toHaveCount(0)
        await expect.poll(() => sent.length).toBe(1)
        expect(sent[0].postDataJSON()).toEqual({ repeat_until: end.toISODate() })
        expect((await stateOf(page, id)).repeat_until).toBe(end.toISODate())
      })
    } finally {
      await trash(page, [id])
    }
  })
})

test.describe('Every-time mode on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true })

  test('the sheet scrolls to the banner, which stays put; the day chips fit with no sideways scroll', async ({
    authenticatedPage: page,
  }) => {
    const id = await create(page, { title: uniqueTitle('Phone Fridays'), rrule: FRIDAYS_4PM })
    try {
      await withPreferences(page, unified, async () => {
        const row = page.locator(`#task-row-${id}`)
        await waitForPrefsLoaded(page, () => page.goto('/'), row)
        await row.evaluate((el) => el.scrollIntoView({ block: 'center' }))
        const box = await row.boundingBox()
        await row.tap({ position: { x: 56, y: box!.height - 6 } })
        const sheet = page.locator('[data-slot="sheet-content"]')
        await expect(sheet.locator('[data-this-one]')).toBeVisible()
        await sheet.evaluate((el) => el.scrollTo(0, el.scrollHeight))
        await sheet.locator('[data-quick-panel-repeat-link]').tap()
        const region = sheet.getByRole('region', { name: 'Editing every time' })
        const banner = region.locator('[data-every-time-back]')
        await expect(banner).toBeInViewport()
        // One line at 375px ("EVERY TIME" · "‹ Back"); the names stay whole.
        await expect(banner).toHaveAccessibleName('Back to this one')
        const heading = region.getByRole('heading', { name: 'Editing every time' })
        expect((await heading.boundingBox())!.height).toBeLessThan(24)
        expect((await banner.boundingBox())!.height).toBeLessThanOrEqual(44)
        await page.screenshot({ path: '.tmp/screens/every-time-banner-375.png' })
        await expect(region.getByRole('button', { name: 'Sunday' })).toBeInViewport()

        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
        ).toBe(true)
        expect(await sheet.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)

        // Sticky: scrolled to the end, the way back is still on screen.
        await sheet.evaluate((el) => el.scrollTo(0, el.scrollHeight))
        await expect(banner).toBeInViewport()
        await banner.tap()
        await expect(region).toHaveCount(0)
      })
    } finally {
      await trash(page, [id])
    }
  })
})

test.describe('Every-time mode on a decked repeat (the queue user)', () => {
  test.afterAll(async ({ request }) => {
    await request.post('/api/test/task-queue', { data: { enabled: false } })
  })

  test('A decked repeat: a new day keeps the deck, and the hint says so', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Username').fill('queue@opentask.local')
    await page.getByLabel('Password').fill('testpass123')
    await page.getByRole('button', { name: /sign in/i }).click()
    await page.waitForURL('/', { timeout: 10_000 })
    await page.request.post('/api/test/task-queue', { data: { enabled: true } })
    const id = await create(page, {
      title: uniqueTitle('Weekly allowance ($8)'),
      rrule: FRIDAYS_4PM,
    })
    try {
      const decked = await page.request.post('/api/tasks/deck', { data: { ids: [id] } })
      expect(decked.ok(), await decked.text()).toBeTruthy()
      const deck = (await stateOf(page, id)).on_deck_day
      expect(deck).not.toBeNull()
      await withPreferences(page, unified, async () => {
        const dialog = await openPanel(page, id)
        await expect(dialog.locator('[data-occurrence-differs]')).toContainText('This is the')
        await expect(dialog.locator('[data-quick-panel-date]')).toHaveText('No target')
        const region = await enterEveryTime(dialog)
        await region.getByRole('button', { name: 'Saturday' }).click()
        await expect(region.locator('[data-every-time-hint]')).toHaveText(
          'Changes apply to every future occurrence. This one stays on deck.',
        )
        await region.getByRole('button', { name: 'Save', exact: true }).click()
        await expect(dialog).toHaveCount(0)
        await expect
          .poll(async () => (await stateOf(page, id)).rrule)
          .toBe('FREQ=WEEKLY;BYDAY=FR,SA;BYHOUR=16;BYMINUTE=0')
        expect((await stateOf(page, id)).on_deck_day).toBe(deck)
      })
    } finally {
      await trash(page, [id])
    }
  })
})

// ===========================================================================
// One surface, never two nested (2026-10-24); Next one occurrence per line
// ===========================================================================

/** A monthly 1st-Saturday repeat, deadline 8 AM, the target the day before at noon. */
function firstSaturdayNoon(page: Page) {
  return create(page, {
    title: uniqueTitle('Monthly first-Saturday workshop'),
    rrule: 'FREQ=MONTHLY;BYDAY=1SA;BYHOUR=8;BYMINUTE=0',
    repeat_anchor: 'deadline',
    deadline_at: nextFirstSaturday(12).toUTC().toISO(),
    target_days_before: 1,
    target_time: '12:00',
  })
}

/** "Sat Nov 7 · deadline 8:00 AM · target Fri 12:00 PM" (the target's date too when it is in the month before). */
const NOON_LINE =
  /^Sat [A-Z][a-z]{2} \d+ · deadline 8:00 AM · target Fri( [A-Z][a-z]{2} \d+)? 12:00 PM$/

/** The element's own frame: its four border widths and its padding. */
function frameOf(el: Locator) {
  return el.evaluate((n) => {
    const s = getComputedStyle(n)
    return {
      border: [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth],
      padding: s.padding,
    }
  })
}
const NO_FRAME = { border: ['0px', '0px', '0px', '0px'], padding: '0px' }

/** No frame inside the host: the editor's surface draws none of its own. */
async function expectFlat(host: Locator) {
  const surface = host.locator('[data-editor-surface]')
  await expect(surface).toHaveAttribute('data-editor-surface', 'flat')
  expect(await frameOf(surface)).toEqual(NO_FRAME)
}

/** Next: one occurrence per line, each labelled and timed; the hint in the same words. */
async function expectNoonNext(region: Locator) {
  await expect(nextDates(region)).toHaveCount(3)
  for (const line of await nextDates(region).all()) await expect(line).toHaveText(NOON_LINE)
  // One per line: each starts below the one before.
  const tops = await nextDates(region).evaluateAll((els) =>
    els.map((e) => e.getBoundingClientRect().top),
  )
  expect(tops[1]).toBeGreaterThan(tops[0])
  expect(tops[2]).toBeGreaterThan(tops[1])
  await expect(region.locator('[data-every-time-hint]')).toHaveText(
    /^Changes apply to every occurrence, starting with this one: Sat [A-Z][a-z]{2} \d+ · deadline 8:00 AM · target Fri( [A-Z][a-z]{2} \d+)? 12:00 PM\.$/,
  )
}

/** Every running animation (a dialog or sheet sliding in) has finished: the screenshot shows where it lands. */
async function settle(page: Page) {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))
}

/** The repeat link has no "since" beside it, and (`oneLine`) fits on one line. */
async function expectRepeatLink(host: Locator, oneLine: boolean) {
  const link = host.locator('[data-quick-panel-repeat-link]')
  await expect(link).toBeVisible()
  await expect(link.locator('xpath=..')).not.toContainText('since')
  if (oneLine) expect((await link.boundingBox())!.height).toBeLessThan(26)
}

/** The latest 1st Saturday at 9 AM that has gone by. */
function lastFirstSaturday(): DateTime {
  let month = DateTime.now().setZone(TZ).startOf('month')
  for (;;) {
    let d = month
    while (d.weekday !== 6) d = d.plus({ days: 1 })
    const at = d.set({ hour: 9 })
    if (at < DateTime.now()) return at
    month = month.minus({ months: 1 })
  }
}

test.describe('The editor is one surface (desktop, light)', () => {
  test.use({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' })

  test('dashboard dialog: no card inside it, no teal box in every-time; Next one per line', async ({
    authenticatedPage: page,
  }) => {
    const id = await firstSaturdayNoon(page)
    // A target-anchored monthly repeat whose occurrence has arrived: its link
    // used to wrap, leaving "· since …" alone on a second line.
    const arrived = await create(page, {
      title: uniqueTitle('Monthly first-Saturday class'),
      rrule: 'FREQ=MONTHLY;BYDAY=1SA;BYHOUR=9;BYMINUTE=0',
      due_at: lastFirstSaturday().toUTC().toISO(),
    })
    try {
      await withPreferences(page, unified, async () => {
        const first = await openPanel(page, arrived)
        await expect(first.locator('[data-quick-panel-repeat-link]')).toContainText(
          'Monthly on the 1st Sat at 9:00 AM',
        )
        await expectRepeatLink(first, true)
        await settle(page)
        await page.screenshot({ path: '.tmp/screens/flat-dialog-link-1280.png' })
        await first.getByRole('button', { name: 'Cancel', exact: true }).click()
        await expect(first).toHaveCount(0)

        const dialog = await openPanel(page, id)
        await expectFlat(dialog)
        await expectRepeatLink(dialog, false)
        await settle(page)
        await page.screenshot({ path: '.tmp/screens/flat-dialog-this-one-1280.png' })

        // Unsaved edits: Save turns solid, and no stripe is painted on the flat surface.
        await dialog.getByRole('button', { name: '+1 day' }).click()
        await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
        const shadow = await dialog
          .locator('[data-editor-surface]')
          .evaluate((n) => getComputedStyle(n).boxShadow)
        expect(shadow).toBe('none')
        await dialog.getByRole('button', { name: 'Reset', exact: true }).click()

        const region = await enterEveryTime(dialog)
        expect(await frameOf(region)).toEqual(NO_FRAME)
        await expectNoonNext(region)
        await settle(page)
        await page.screenshot({ path: '.tmp/screens/flat-dialog-every-time-1280.png' })
      })
    } finally {
      await trash(page, [id, arrived])
    }
  })

  test('the task page keeps one card; every-time inside it draws no second frame', async ({
    authenticatedPage: page,
  }) => {
    const id = await firstSaturdayNoon(page)
    try {
      await page.goto(`/tasks/${id}`)
      const surface = page.locator('[data-editor-surface]')
      await expect(surface).toHaveAttribute('data-editor-surface', 'card')
      expect((await frameOf(surface)).border).toEqual(['1px', '1px', '1px', '1px'])
      await expectRepeatLink(surface, true)
      await settle(page)
      await page.screenshot({ path: '.tmp/screens/flat-page-this-one-1280.png' })
      const region = await enterEveryTime(surface)
      expect(await frameOf(region)).toEqual(NO_FRAME)
      await expectNoonNext(region)
      await settle(page)
      await page.screenshot({ path: '.tmp/screens/flat-page-every-time-1280.png' })
    } finally {
      await trash(page, [id])
    }
  })

  test('the selection bar’s More dialog and the create dialog: no card inside them', async ({
    authenticatedPage: page,
  }) => {
    const id = await firstSaturdayNoon(page)
    try {
      await withPreferences(page, unified, async () => {
        const row = page.locator(`#task-row-${id}`)
        await waitForPrefsLoaded(page, () => page.goto('/'), row)
        await cmdClickRow(row)
        await page.getByRole('button', { name: 'More', exact: true }).click()
        const more = page.getByRole('dialog')
        await expectFlat(more)
        await settle(page)
        await page.screenshot({ path: '.tmp/screens/flat-more-1280.png' })
        await more.getByRole('button', { name: 'Cancel', exact: true }).click()
        await expect(more).toHaveCount(0)
        await page.keyboard.press('Escape')

        await page.getByRole('complementary').getByRole('button', { name: 'Add Task' }).click()
        const form = page.getByRole('dialog', { name: 'New Task' })
        await expectFlat(form)
        await form.locator('[data-quick-panel-repeat-link]').click()
        const region = form.getByRole('region', { name: 'Editing every time' })
        expect(await frameOf(region)).toEqual(NO_FRAME)
        await settle(page)
        await page.screenshot({ path: '.tmp/screens/flat-create-every-time-1280.png' })
      })
    } finally {
      await trash(page, [id])
    }
  })
})

test.describe('The editor is one surface (phone, dark)', () => {
  test.use({
    viewport: { width: 375, height: 812 },
    hasTouch: true,
    isMobile: true,
    colorScheme: 'dark',
  })

  test('the sheet: no card inside it, no teal box in every-time; Next one per line', async ({
    authenticatedPage: page,
  }) => {
    const id = await firstSaturdayNoon(page)
    try {
      await withPreferences(page, unified, async () => {
        const row = page.locator(`#task-row-${id}`)
        await waitForPrefsLoaded(page, () => page.goto('/'), row)
        await row.evaluate((el) => el.scrollIntoView({ block: 'center' }))
        const box = await row.boundingBox()
        await row.tap({ position: { x: 56, y: box!.height - 6 } })
        const sheet = page.locator('[data-slot="sheet-content"]')
        await expect(sheet.locator('[data-this-one]')).toBeVisible()
        await expectFlat(sheet)
        const link = sheet.locator('[data-quick-panel-repeat-link]')
        await expect(link.locator('xpath=..')).not.toContainText('since')
        await settle(page)
        await page.screenshot({ path: '.tmp/screens/flat-sheet-this-one-375-dark.png' })
        await link.tap()
        const region = sheet.getByRole('region', { name: 'Editing every time' })
        expect(await frameOf(region)).toEqual(NO_FRAME)
        await expectNoonNext(region)
        await region.locator('[data-every-time-next]').scrollIntoViewIfNeeded()
        await settle(page)
        await page.screenshot({ path: '.tmp/screens/flat-sheet-every-time-375-dark.png' })
        expect(await sheet.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
      })
    } finally {
      await trash(page, [id])
    }
  })
})
