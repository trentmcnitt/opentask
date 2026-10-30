/**
 * Finishing a section on /reminders scrolls to the next one still waiting
 * (Trent, 2026-10-29: "after you complete a section, it automatically jumps
 * to the next one, the same way that filling segments does on the dashboard
 * or on the widget"; `useScrollToNextSection`, `sectionAfterFinishing`).
 *
 * Two real tasks: one in Heads up (targeted tomorrow, so today is its heads-up
 * day) and one in Days. Heads up comes before Days, so considering the Heads
 * up row finishes that section and the page lands Days' header under the top
 * bar. The E2E users are shared, so the reminders answer is trimmed to these
 * two tasks (and no periods): the next section is then Days whatever other
 * specs left behind. The actions themselves are real.
 */
import path from 'path'
import Database from 'better-sqlite3'
import { DateTime } from 'luxon'
import { test, expect, backdateCreated, openTaskDay, uniqueTitle } from './fixtures'
import type { Page } from '@playwright/test'

const TZ = process.env.E2E_TZ || 'America/Chicago'

async function create(page: Page, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data })
  expect(res.ok(), `create ${JSON.stringify(data)}`).toBeTruthy()
  return (await res.json()).data.id as number
}

/** A target picked days ago: Upcoming counts its heads-up days from `target_set_at`. */
function targetSetDaysAgo(id: number, days: number) {
  const db = new Database(path.join(process.cwd(), 'data', 'test-e2e.db'))
  try {
    db.prepare('UPDATE tasks SET target_set_at = ? WHERE id = ?').run(
      DateTime.now().minus({ days }).toUTC().toISO(),
      id,
    )
  } finally {
    db.close()
  }
}

/** The reminders answer with only these tasks in it: no periods, no other rows. */
async function onlyTheseTasks(page: Page, ids: number[]) {
  await page.route('**/api/reminders?*', async (route) => {
    const response = await route.fetch()
    const json = await response.json()
    json.data.groups = []
    json.data.not_today = []
    for (const segment of json.data.task_segments) {
      segment.tasks = segment.tasks.filter((t: { id: number }) => ids.includes(t.id))
    }
    await route.fulfill({ response, json })
  })
}

test.use({ viewport: { width: 390, height: 640 } })

test('finishing Heads up scrolls Days, the next section still waiting, under the top bar', async ({
  authenticatedPage: page,
}) => {
  const tomorrow = await openTaskDay(page, 1)
  const headsUp = await create(page, {
    title: uniqueTitle('NS heads up'),
    target_at: DateTime.fromISO(tomorrow, { zone: TZ }).set({ hour: 9 }).toUTC().toISO(),
  })
  targetSetDaysAgo(headsUp, 10)
  const days = await create(page, { title: uniqueTitle('NS days'), horizon: 'days' })
  backdateCreated([days], { inSegments: true })
  try {
    await onlyTheseTasks(page, [headsUp, days])
    await page.goto('/reminders')
    const upcoming = page.locator('[data-section-key="tasks:upcoming"]')
    const daysSection = page.locator('[data-section-key="tasks:days"]')
    const row = upcoming.locator(`[data-segment-task="${headsUp}"]`)
    await expect(row).toBeVisible()
    await expect(daysSection.locator(`[data-segment-task="${days}"]`)).toBeAttached()
    const before = await page.evaluate(() => window.scrollY)

    await row.getByRole('button', { name: /as considered/ }).click()

    // The page moves on its own: Days' header lands at its scroll margin
    // (4.5rem, clear of the top bar).
    await expect.poll(async () => Math.round((await daysSection.boundingBox())!.y)).toBe(72)
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(before)
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await page.request.post('/api/tasks/bulk/delete', { data: { ids: [headsUp, days] } })
  }
})

test('a scroll by hand after the last tick keeps the page where the user put it', async ({
  authenticatedPage: page,
}) => {
  const tomorrow = await openTaskDay(page, 1)
  const headsUp = await create(page, {
    title: uniqueTitle('NS heads up'),
    target_at: DateTime.fromISO(tomorrow, { zone: TZ }).set({ hour: 9 }).toUTC().toISO(),
  })
  targetSetDaysAgo(headsUp, 10)
  const days = await create(page, { title: uniqueTitle('NS days'), horizon: 'days' })
  backdateCreated([days], { inSegments: true })
  try {
    await onlyTheseTasks(page, [headsUp, days])
    // The page's timers run on a clock the test steps: the move's delay
    // passes exactly when the test says so.
    await page.clock.install()
    await page.goto('/reminders')
    const upcoming = page.locator('[data-section-key="tasks:upcoming"]')
    const row = upcoming.locator(`[data-segment-task="${headsUp}"]`)
    await expect(row).toBeVisible()

    await row.getByRole('button', { name: /as considered/ }).click()
    await expect(row).toHaveCount(0)
    const clicked = await page.evaluate(() => window.scrollY)
    await page.mouse.wheel(0, 40)
    const handScrolled = clicked + 40
    await expect.poll(async () => page.evaluate(() => window.scrollY)).toBe(handScrolled)

    // Past the move's delay, the page is still where the wheel left it.
    await page.clock.runFor(2000)
    expect(await page.evaluate(() => window.scrollY)).toBe(handScrolled)
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await page.request.post('/api/tasks/bulk/delete', { data: { ids: [headsUp, days] } })
  }
})

test('with a notch inset the header still lands below the top bar', async ({
  authenticatedPage: page,
}) => {
  // The iOS app's top bar grows by the safe-area inset (~47–59px); Chromium's
  // is 0, so the inset is stood in for through the one variable both the bar
  // and the landing line read (`--safe-top`).
  const tomorrow = await openTaskDay(page, 1)
  const headsUp = await create(page, {
    title: uniqueTitle('NS notch heads up'),
    target_at: DateTime.fromISO(tomorrow, { zone: TZ }).set({ hour: 9 }).toUTC().toISO(),
  })
  targetSetDaysAgo(headsUp, 10)
  const days = await create(page, { title: uniqueTitle('NS notch days'), horizon: 'days' })
  backdateCreated([days], { inSegments: true })
  try {
    await onlyTheseTasks(page, [headsUp, days])
    await page.goto('/reminders')
    await page.addStyleTag({ content: ':root { --safe-top: 54px !important; }' })
    const row = page.locator(`[data-section-key="tasks:upcoming"] [data-segment-task="${headsUp}"]`)
    const daysSection = page.locator('[data-section-key="tasks:days"]')
    await expect(row).toBeVisible()

    await row.getByRole('button', { name: /as considered/ }).click()

    // The header's top, measured, is at or below the bar's bottom edge, and
    // the page has come to rest there.
    await expect
      .poll(async () => {
        const bar = (await page.locator('header').first().boundingBox())!
        const top = (await daysSection.boundingBox())!.y
        return top >= bar.y + bar.height && top < bar.y + bar.height + 40
      })
      .toBe(true)
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await page.request.post('/api/tasks/bulk/delete', { data: { ids: [headsUp, days] } })
  }
})
