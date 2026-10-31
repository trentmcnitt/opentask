/**
 * Re-tapping the tab you are on walks you to what needs you (Trent,
 * 2026-10-29; `src/lib/retap-walk.ts`, docs/SPEC.md § Guiding Principles 6):
 * - Reminders: the period that needs you, then the topmost task segment with
 *   something waiting, then the top — and round again;
 * - Dashboard in ONE column (a phone; 2026-10-31,
 *   src/lib/dashboard-landing.ts): a fresh load opens on the tasks, and a
 *   re-tap toggles between the top and the tasks — no walk;
 * - Dashboard in TWO columns: the Reminders card, the Task queue card, the
 *   task list's groups that need you, then the top;
 * - Quotas: the first period (Today), then the top;
 * - switching to a tab never scrolls — except the Dashboard's first visit
 *   since launch, which opens on the tasks.
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

/** The task list's start (`data-task-list-landing`'s wrapper, whose margin is the landing line). */
const tasks = (page: Page) => page.locator('[data-task-list-landing]').locator('..')

/**
 * The dashboard's rows for these tests: a reminder in a started period, a
 * waiting Days task (the queue card), an over-target task (Today), and — for
 * two columns — a quota. The modes need the lean row and the task queue.
 */
async function dashboardRows(p: Page, quota = false): Promise<number[]> {
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
  const ids = [reminder, days, late]
  if (quota) {
    ids.push(
      await create(p, { title: uniqueTitle('RW quota'), progress_target: 2, rrule: 'FREQ=WEEKLY' }),
    )
  }
  const queue = await p.request.post('/api/test/task-queue', { data: { enabled: true } })
  expect(queue.ok()).toBeTruthy()
  await p.addInitScript(() => window.localStorage.setItem('opentask_task_rows', 'lean'))
  await onlyThese(p, ids)
  return ids
}

async function cleanDashboard(p: Page, ids: number[]) {
  await p.request.post('/api/test/task-queue', { data: { enabled: false } })
  await p.unrouteAll({ behavior: 'ignoreErrors' })
  await p.request.post('/api/tasks/bulk/delete', { data: { ids } })
}

test.describe('one column, an iPhone 16 Pro', () => {
  test.use({ viewport: { width: 402, height: 874 } })

  test('Dashboard, one column: a fresh load opens on the tasks; a tap → the top; a tap → the tasks', async ({
    authenticatedPage: p,
  }) => {
    const ids = await dashboardRows(p)
    try {
      // Room below, from the first paint: the tasks can rise to their line.
      await p.addInitScript(() => {
        document.addEventListener('DOMContentLoaded', () => {
          const style = document.createElement('style')
          style.textContent = 'body { padding-bottom: 3000px; }'
          document.head.append(style)
        })
        // The first frame the list is there: where the page was. Landing
        // before the paint means that frame is already on the tasks.
        const w = window as unknown as { __firstListFrameY?: number }
        const watch = () => {
          if (document.querySelector('[data-task-list-landing]')) {
            w.__firstListFrameY = window.scrollY
            return
          }
          requestAnimationFrame(watch)
        }
        requestAnimationFrame(watch)
      })
      await p.goto('/?mode=today')
      await expect(p.locator('[data-reminders-panel]')).toBeVisible()
      await expect(p.locator('[data-mode-section="today"]')).toBeVisible()
      // Opened on the tasks — under Reminders, the queue card and Quotas —
      // and never shown at the top first.
      await landed(tasks(p))
      const first = await p.evaluate(
        () => (window as unknown as { __firstListFrameY?: number }).__firstListFrameY,
      )
      expect(first).toBeGreaterThan(0)
      await p.screenshot({ path: '.tmp/screens/dashboard-lands-on-tasks-402.png' })

      await tab(p, 'Dashboard').click()
      await atTop(p)
      await tab(p, 'Dashboard').click()
      await landed(tasks(p))
      // Where the page is decides: scrolled by hand above the tasks, a tap goes
      // to the tasks; below them, to the top.
      await p.evaluate(() => window.scrollTo({ top: 40, behavior: 'instant' }))
      await tab(p, 'Dashboard').click()
      await landed(tasks(p))
      await p.evaluate(() => window.scrollBy({ top: 200, behavior: 'instant' }))
      await tab(p, 'Dashboard').click()
      await atTop(p)
      // It only scrolled: the mode kept its view.
      expect(new URL(p.url()).searchParams.get('mode') ?? 'today').toBe('today')
    } finally {
      await cleanDashboard(p, ids)
    }
  })
})

test.describe('two columns', () => {
  test.use({ viewport: { width: 1600, height: 700 } })

  test('Dashboard: a fresh load stays at the top — the list is there already', async ({
    authenticatedPage: p,
  }) => {
    const ids = await dashboardRows(p, true)
    try {
      await p.goto('/?mode=today')
      await expect(p.locator('[data-reminders-panel]')).toBeVisible()
      await expect(p.locator('[data-mode-section="today"]')).toBeVisible()
      // Two columns: the list beside the cards, not under them.
      expect(
        await p.evaluate(
          () =>
            getComputedStyle(document.querySelector('main')!).gridTemplateColumns.split(' ').length,
        ),
      ).toBe(2)
      expect(await p.evaluate(() => window.scrollY)).toBe(0)
    } finally {
      await cleanDashboard(p, ids)
    }
  })
})

test('a scroll by hand resets the cycle: the next tap goes to the top, then stop 1', async ({
  authenticatedPage: p,
}) => {
  const reminder = await create(p, {
    title: uniqueTitle('RW hand reminder'),
    is_reminder: true,
    due_at: inStartedSlot(),
  })
  const days = await create(p, { title: uniqueTitle('RW hand days'), horizon: 'days' })
  backdateCreated([days], { inSegments: true })
  try {
    await onlyThese(p, [reminder, days])
    await p.goto('/reminders')
    await expect(p.locator(`li[data-reminder-id="${reminder}"]`)).toBeVisible()
    await room(p)
    const period = p.locator('[data-slot-key][data-needs-you]')

    await tab(p, 'Reminders').click()
    await landed(period)
    // By hand: the wheel.
    const before = await p.evaluate(() => window.scrollY)
    await p.mouse.move(200, 400)
    await p.mouse.wheel(0, 120)
    await expect.poll(() => p.evaluate(() => window.scrollY)).toBeGreaterThan(before)
    await tab(p, 'Reminders').click()
    await atTop(p)
    await tab(p, 'Reminders').click()
    await landed(period)
  } finally {
    await p.unrouteAll({ behavior: 'ignoreErrors' })
    await p.request.post('/api/tasks/bulk/delete', { data: { ids: [reminder, days] } })
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

test('switching to a tab never scrolls — but the first Dashboard visit since launch opens on the tasks', async ({
  authenticatedPage: p,
}) => {
  for (const [from, to, path] of [
    ['/', 'Reminders', '/reminders'],
    ['/reminders', 'Quotas', '/quotas'],
  ] as const) {
    await p.goto(from)
    await tab(p, to).click()
    await p.waitForURL((u) => u.pathname === path)
    await expect(p.locator('main')).toBeVisible()
    expect(await p.evaluate(() => window.scrollY)).toBe(0)
  }
  // A launch on Quotas: the first switch to the Dashboard lands on the tasks…
  await p.goto('/quotas')
  await p.addStyleTag({ content: 'body { padding-bottom: 3000px; }' })
  await tab(p, 'Dashboard').click()
  await p.waitForURL((u) => u.pathname === '/')
  await landed(tasks(p))
  // …and later switches keep to the 10-29 rule: no scroll.
  await tab(p, 'Quotas').click()
  await p.waitForURL((u) => u.pathname === '/quotas')
  await tab(p, 'Dashboard').click()
  await p.waitForURL((u) => u.pathname === '/')
  await expect(p.locator('main')).toBeVisible()
  expect(await p.evaluate(() => window.scrollY)).toBe(0)
})
