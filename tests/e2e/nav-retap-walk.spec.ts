/**
 * Re-tapping the tab you are on walks you to what needs you (Trent,
 * 2026-10-29; `src/lib/retap-walk.ts`, docs/SPEC.md § Guiding Principles 6):
 * - Reminders: the period that needs you, then the topmost task segment with
 *   something waiting, then the top — and round again;
 * - Dashboard: the Reminders card, the Task queue card, the task list's
 *   groups that need you, then the top;
 * - Quotas: the first period (Today), then the top;
 * - switching to a tab never scrolls.
 *
 * The E2E users are shared, so the reminders and tasks answers are trimmed to
 * this spec's own rows: the walk's stops are then exactly the ones made here.
 * A spacer below the page lets every stop rise to its landing line.
 */
import { DateTime } from 'luxon'
import { test, expect, backdateCreated, uniqueTitle } from './fixtures'
import type { Locator, Page } from '@playwright/test'

const TEST_TZ = process.env.E2E_TZ || 'America/Chicago'

test.use({ viewport: { width: 390, height: 700 } })

async function create(page: Page, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data })
  expect(res.ok(), `create ${JSON.stringify(data)}`).toBeTruthy()
  return (await res.json()).data.id as number
}

/** A moment a few minutes ago, today: a reminder there is in a period that has started. */
function inStartedSlot(): string {
  const now = DateTime.now().setZone(TEST_TZ)
  const passed = now.minus({ minutes: 5 })
  const safe = passed.hasSame(now, 'day') ? passed : now.startOf('day').plus({ minutes: 1 })
  return safe.toUTC().toISO() as string
}

/** The reminders and tasks answers with only these rows in them. */
async function onlyThese(page: Page, ids: number[]) {
  await page.route('**/api/reminders?*', async (route) => {
    const response = await route.fetch()
    const json = await response.json()
    for (const g of json.data.groups) {
      g.reminders = g.reminders.filter((t: { id: number }) => ids.includes(t.id))
      g.count = g.reminders.length
      g.prompts = []
    }
    json.data.not_today = []
    for (const s of json.data.task_segments) {
      s.tasks = s.tasks.filter((t: { id: number }) => ids.includes(t.id))
    }
    await route.fulfill({ response, json })
  })
  await page.route('**/api/tasks?limit=1000', async (route) => {
    const response = await route.fetch()
    const json = await response.json()
    json.data.tasks = json.data.tasks.filter((t: { id: number }) => ids.includes(t.id))
    await route.fulfill({ response, json })
  })
}

/** The page can scroll every stop up to its line. */
async function room(page: Page) {
  await page.addStyleTag({ content: 'body { padding-bottom: 3000px; }' })
}

/** The stop's header rests on its landing line (its `scroll-margin-top`). */
async function landed(stop: Locator) {
  await expect
    .poll(async () =>
      stop.evaluate((el) => {
        const line = parseFloat(getComputedStyle(el).scrollMarginTop) || 0
        return Math.abs(el.getBoundingClientRect().top - line) <= 1
      }),
    )
    .toBe(true)
}

const atTop = (page: Page) => expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)

const tab = (page: Page, name: string) =>
  page.locator('nav').getByRole('link', { name, exact: true })

test('Reminders: the period that needs you, then the topmost waiting segment, then the top', async ({
  authenticatedPage: p,
}) => {
  const reminder = await create(p, {
    title: uniqueTitle('RW reminder'),
    is_reminder: true,
    due_at: inStartedSlot(),
  })
  const days = await create(p, { title: uniqueTitle('RW days'), horizon: 'days' })
  backdateCreated([days], { inSegments: true })
  try {
    await onlyThese(p, [reminder, days])
    await p.goto('/reminders')
    await expect(p.locator(`li[data-reminder-id="${reminder}"]`)).toBeVisible()
    await room(p)
    const period = p.locator('[data-slot-key][data-needs-you]')
    await expect(period).toHaveCount(1)

    await tab(p, 'Reminders').click()
    await landed(period)
    await tab(p, 'Reminders').click()
    await landed(p.locator('[data-section-key="tasks:days"]'))
    await tab(p, 'Reminders').click()
    await atTop(p)
    // And round again.
    await tab(p, 'Reminders').click()
    await landed(period)
  } finally {
    await p.unrouteAll({ behavior: 'ignoreErrors' })
    await p.request.post('/api/tasks/bulk/delete', { data: { ids: [reminder, days] } })
  }
})

test('Dashboard: the Reminders card, the Task queue card, the task list, then the top', async ({
  authenticatedPage: p,
}) => {
  const reminder = await create(p, {
    title: uniqueTitle('RW dash reminder'),
    is_reminder: true,
    due_at: inStartedSlot(),
  })
  const days = await create(p, { title: uniqueTitle('RW dash days'), horizon: 'days' })
  backdateCreated([days], { inSegments: true })
  const late = await create(p, {
    title: uniqueTitle('RW dash over target'),
    target_at: DateTime.now().minus({ hours: 2 }).toUTC().toISO(),
  })
  try {
    await onlyThese(p, [reminder, days, late])
    await p.goto('/?mode=today')
    await expect(p.locator('[data-reminders-panel]')).toBeVisible()
    await expect(p.locator('[data-mode-section="today"]')).toBeVisible()
    await room(p)

    await tab(p, 'Dashboard').click()
    await landed(p.locator('[data-reminders-panel]'))
    await tab(p, 'Dashboard').click()
    await landed(p.locator('section[data-tasks-panel]'))
    await tab(p, 'Dashboard').click()
    // Over target: in Today, where an over-target row needs you.
    await landed(p.locator('[data-mode-section="today"]'))
    await tab(p, 'Dashboard').click()
    await atTop(p)
    // It only scrolled: the cards kept their pages and the mode its view.
    expect(new URL(p.url()).searchParams.get('mode') ?? 'today').toBe('today')
  } finally {
    await p.unrouteAll({ behavior: 'ignoreErrors' })
    await p.request.post('/api/tasks/bulk/delete', { data: { ids: [reminder, days, late] } })
  }
})

test('Quotas: the first period, Today, then the top', async ({ authenticatedPage: p }) => {
  const quota = await create(p, {
    title: uniqueTitle('RW daily quota'),
    progress_target: 2,
    rrule: 'FREQ=DAILY',
  })
  try {
    await p.goto('/quotas')
    const today = p.locator('li[data-quota-period]').first()
    await expect(today).toHaveAttribute('data-quota-period', 'DAILY')
    await room(p)

    await tab(p, 'Quotas').click()
    await landed(today)
    await tab(p, 'Quotas').click()
    await atTop(p)
  } finally {
    await p.request.post('/api/tasks/bulk/delete', { data: { ids: [quota] } })
  }
})

test('switching to a tab never scrolls', async ({ authenticatedPage: p }) => {
  for (const [from, to, path] of [
    ['/', 'Reminders', '/reminders'],
    ['/reminders', 'Quotas', '/quotas'],
    ['/quotas', 'Dashboard', '/'],
  ] as const) {
    await p.goto(from)
    await tab(p, to).click()
    await p.waitForURL((u) => u.pathname === path)
    await expect(p.locator('main')).toBeVisible()
    expect(await p.evaluate(() => window.scrollY)).toBe(0)
  }
})
