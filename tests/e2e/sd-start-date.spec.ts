/**
 * THE START DATE on the web (2026-11-12, docs/TASK-MODEL.md § Start date):
 *  - the quick panel's "Starts" row on a deadline one-off with no target:
 *    Pick a date → the chip and the "Comes round…" line → Save; "Days
 *    instead"; the chip's ✕ back to Default;
 *  - the Due page's two groups, "Coming due" and "Open window", with one row
 *    in each, and the open row's words.
 *
 * Its own user with the task-queue switch on (as deadlines-page.spec). Days
 * are the SERVER's OpenTask days (`openTaskDay`), never the calendar's.
 * Unique invented titles; every task trashed in `finally`.
 */
import { DateTime } from 'luxon'
import { test, expect, openTaskDay, uniqueTitle } from './fixtures'
import type { Page } from '@playwright/test'

const TZ = process.env.E2E_TZ || 'America/Chicago'
test.use({ timezoneId: TZ, viewport: { width: 1280, height: 800 } })

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill('queue@opentask.local')
  await page.getByLabel('Password').fill('testpass123')
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL('/', { timeout: 10_000 })
}

async function create(page: Page, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data })
  expect(res.ok(), `create ${JSON.stringify(data)}: ${await res.text()}`).toBeTruthy()
  return (await res.json()).data.id as number
}

async function stateOf(page: Page, id: number): Promise<Record<string, unknown>> {
  return (await (await page.request.get(`/api/tasks/${id}`)).json()).data
}

async function trash(page: Page, ids: number[]) {
  if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
}

/** 5:00 PM on the OpenTask day `n` days from the server's today, as an instant. */
async function deadlineIn(page: Page, n: number): Promise<string> {
  const day = await openTaskDay(page, n, TZ)
  return DateTime.fromISO(`${day}T17:00`, { zone: TZ }).toUTC().toISO()!
}

/** Pick `day` (yyyy-MM-dd) in the open Starts calendar, turning the month if needed. */
async function pickDay(page: Page, day: string) {
  const picker = page.getByRole('dialog', { name: 'Starts on…' })
  const d = DateTime.fromISO(day)
  const key = await page.evaluate(
    ([y, m, dd]) => new Date(y, m - 1, dd).toLocaleDateString(),
    [d.year, d.month, d.day],
  )
  const cell = picker.locator(`button[data-day="${key}"]`).first()
  if ((await cell.count()) === 0) await picker.getByRole('button', { name: /next month/i }).click()
  return { picker, cell }
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

test('the Starts row: pick a date, Days instead, and ✕ back to Default', async ({ page }) => {
  const ids: number[] = []
  try {
    const id = await create(page, {
      title: uniqueTitle('Synthetic fern voucher'),
      horizon: 'weeks',
      deadline_at: await deadlineIn(page, 40),
    })
    ids.push(id)
    const today = await openTaskDay(page, 0, TZ)
    await page.goto(`/tasks/${id}`)
    const fields = page.locator('[data-task-model-fields]')
    const lead = page.locator('[data-quick-panel-lead="deadline"]')
    await expect(fields).toContainText('Starts')
    await expect(fields).not.toContainText('Lead time')
    await expect(lead.locator('[data-lead-days]')).toBeVisible()

    // Pick a date: the last two days before the deadline are greyed.
    await lead.locator('[data-starts-pick]').click()
    const net = await pickDay(page, await openTaskDay(page, 39, TZ))
    await expect(net.cell).toBeDisabled()
    await expect(net.picker.locator('[data-starts-submit]')).toBeDisabled()
    await page.keyboard.press('Escape')
    await lead.locator('[data-starts-pick]').click()
    const pick = await pickDay(page, today)
    await pick.cell.click()
    await pick.picker.locator('[data-starts-submit]').click()

    // The chip, how far ahead, and what the date does — staged, then saved.
    const chip = lead.locator(`[data-starts-date="${today}"]`)
    await expect(chip).toHaveText(DateTime.fromISO(today).toFormat('ccc LLL d'))
    await expect(lead.locator('[data-starts-before]')).toHaveText('40 days before')
    await expect(lead.locator('[data-starts-line]')).toHaveText(
      /^Comes round weekly from \w{3} \w{3} \d+ until \w{3} \w{3} \d+, then daily$/,
    )
    await expect(lead.locator('[data-lead-days]')).toHaveCount(0)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(async () => (await stateOf(page, id)).start_date).toBe(today)
    expect((await stateOf(page, id)).deadline_window).toBe('open')

    // Reloaded: the stored date draws the same row.
    await page.goto(`/tasks/${id}`)
    await expect(chip).toBeVisible()
    await expect(lead.locator('[data-starts-line]')).toContainText('Comes round weekly from')

    // "Days instead": the stepper on the default lead; the date goes.
    await lead.locator('[data-starts-days]').click()
    await expect(lead.locator('[data-lead-days]')).toHaveText('4 days')
    await expect(lead.locator('[data-starts-date]')).toHaveCount(0)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(async () => (await stateOf(page, id)).start_date).toBeNull()
    expect((await stateOf(page, id)).lead_days).toBe(4)

    // A date again (it takes the Days override's place), then its ✕: Default.
    await page.goto(`/tasks/${id}`)
    await lead.locator('[data-starts-pick]').click()
    const again = await pickDay(page, today)
    await again.cell.click()
    await again.picker.locator('[data-starts-submit]').click()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(async () => (await stateOf(page, id)).start_date).toBe(today)
    expect((await stateOf(page, id)).lead_days).toBeNull()
    await page.goto(`/tasks/${id}`)
    await lead.locator('[data-starts-clear]').click()
    await expect(lead.locator('[data-starts-date]')).toHaveCount(0)
    await expect(lead.locator('[data-lead-words]')).toContainText('On the deadlines page from')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(async () => (await stateOf(page, id)).start_date).toBeNull()
    expect((await stateOf(page, id)).lead_days).toBeNull()
  } finally {
    await trash(page, ids)
  }
})

test('the Due page: Coming due, then Open window, each with its count', async ({ page }) => {
  const ids: number[] = []
  try {
    const today = await openTaskDay(page, 0, TZ)
    // Daily from today: a deadline five days out, a 30-day lead.
    const due = await create(page, {
      title: uniqueTitle('Synthetic moss permit'),
      deadline_at: await deadlineIn(page, 5),
      lead_days: 30,
    })
    // In its open window: started today, 40 days to go.
    const open = await create(page, {
      title: uniqueTitle('Synthetic fern voucher'),
      horizon: 'weeks',
      deadline_at: await deadlineIn(page, 40),
      start_date: today,
    })
    ids.push(due, open)
    await page.goto('/reminders')
    const section = page.locator('[data-task-segments] [data-task-segment="deadlines"]')
    const groups = section.locator('[data-deadline-group]')
    await expect(groups).toHaveCount(2)
    await expect(groups.nth(0)).toHaveAttribute('data-deadline-group', 'due')
    await expect(groups.nth(0)).toContainText(/Coming due/i)
    await expect(groups.nth(1)).toHaveAttribute('data-deadline-group', 'open')
    await expect(groups.nth(1)).toContainText(/Open window/i)
    // The open row comes after its heading and says its cadence and what is left.
    const openRow = section.locator(`[data-segment-task="${open}"]`)
    await expect(openRow.locator('[data-open-window-words]')).toHaveText(
      /^· weekly · next \w{3}( \d+)? · 5 weeks left$/,
    )
    await expect(
      section.locator(`[data-segment-task="${due}"] [data-open-window-words]`),
    ).toHaveCount(0)
    const order = await section
      .locator('[data-deadline-group], [data-segment-task]')
      .evaluateAll((els) =>
        els.map(
          (e) => e.getAttribute('data-deadline-group') ?? e.getAttribute('data-segment-task'),
        ),
      )
    expect(order.indexOf('open')).toBeLessThan(order.indexOf(String(open)))
    expect(order.indexOf(String(due))).toBeLessThan(order.indexOf('open'))

    // Considered: the open row leaves, and one kind of row needs no heading.
    await openRow.getByRole('button', { name: /as considered/ }).click()
    await expect(section.locator(`[data-segment-task="${open}"]`)).toHaveCount(0)
    await expect(groups).toHaveCount(0)
  } finally {
    await trash(page, ids)
  }
})
