/**
 * Phone thumb controls (Trent, 2026-09-29):
 *
 * - "Jump to tasks" (`JumpToTasksFab`): a frosted button at the top of the
 *   right-hand FAB column, shown only while the start of the task list is
 *   BELOW the viewport (an IntersectionObserver on the list's wrapper). A
 *   tap scrolls the first task group up under the top bar — the same landing
 *   as the overdue jump — and the button then fades out.
 * - The phone overdue button is 80% opaque while its filter is off, and fully
 *   opaque while the filter is on (the pressed toggle state).
 *
 * The list start is pushed below the fold by seeding quotas, whose panel sits
 * above the list below `xl` whatever the time of day (the Reminders panel
 * shows only the current period, so its height depends on when the suite
 * runs); each test asserts that precondition rather than assuming it.
 */
import { test, expect, uniqueTitle } from './fixtures'
import type { Page } from '@playwright/test'
import { DateTime } from 'luxon'

/** Must track `globalSetup.ts`'s `E2E_TZ` override — see dashboard.spec.ts. */
const TEST_TZ = process.env.E2E_TZ || 'America/Chicago'
/** `scroll-below-header`'s margin with no safe-area inset: 4.5rem. */
const LANDING_Y = 72
const VIEWPORT = { width: 375, height: 812 }

const jumpFab = (page: Page) => page.locator('[data-jump-to-tasks-fab]')
const overdueFab = (page: Page) => page.locator('[data-overdue-jump-fab="phone"]')
const snoozeFab = (page: Page) => page.locator('[data-snooze-all-fab]')
const firstGroup = (page: Page) => page.locator('[data-task-group]').first()

async function post(page: Page, url: string, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post(url, { data })
  expect(res.ok(), `POST ${url}`).toBeTruthy()
  return (await res.json()).data.id as number
}

async function firstGroupTop(page: Page): Promise<number> {
  const box = await firstGroup(page).boundingBox()
  expect(box).not.toBeNull()
  return box!.y
}

/** Scroll so the first group's top sits at `y` in the viewport. */
async function scrollGroupTo(page: Page, y: number) {
  const top = await firstGroupTop(page)
  await page.evaluate((dy) => window.scrollBy(0, dy), top - y)
  await expect.poll(async () => Math.abs((await firstGroupTop(page)) - y)).toBeLessThan(2)
}

test.describe('Phone thumb controls', () => {
  test.use({ viewport: VIEWPORT })

  let taskIds: number[] = []
  let grouping = 'slot'

  test.beforeEach(async ({ authenticatedPage: page }) => {
    grouping = (await (await page.request.get('/api/user/preferences')).json()).data
      .default_grouping as string
    const written = await page.request.patch('/api/user/preferences', {
      data: { filters_expanded: false, default_grouping: 'new' },
    })
    expect(written.ok()).toBeTruthy()

    const startOfToday = DateTime.now().setZone(TEST_TZ).startOf('day')
    taskIds = []
    // What sits above the list on a phone: the Quotas panel.
    for (let i = 0; i < 12; i++) {
      taskIds.push(
        await post(page, '/api/tasks', {
          title: uniqueTitle(`Thumb quota ${i}`),
          progress_target: 3,
          rrule: 'FREQ=WEEKLY',
          create_label: true,
        }),
      )
    }
    // Overdue rows, enough to make the page tall enough for the list's first
    // group to reach the top bar.
    for (let i = 0; i < 12; i++) {
      taskIds.push(
        await post(page, '/api/tasks', {
          title: uniqueTitle(`Thumb row ${i}`),
          due_at: startOfToday.toUTC().toISO(),
        }),
      )
    }
    await page.reload()
    await expect(firstGroup(page)).toBeVisible()
  })

  test.afterEach(async ({ authenticatedPage: page }) => {
    if (taskIds.length > 0) {
      await page.request.post('/api/tasks/bulk/delete', { data: { ids: taskIds.splice(0) } })
    }
    await page.request.patch('/api/user/preferences', { data: { default_grouping: grouping } })
  })

  test('jump to tasks: shown while the list starts below the fold, scrolls to it, then hides', async ({
    authenticatedPage: page,
  }) => {
    // Precondition: the panels push the list's start below the viewport.
    expect(await firstGroupTop(page)).toBeGreaterThan(VIEWPORT.height)

    const button = jumpFab(page)
    await expect(button).toBeVisible()
    await expect(button).toHaveAttribute('aria-label', 'Jump to tasks')

    // Top of the FAB column: above the overdue button, same right edge, the
    // same 12px gap the overdue button keeps above the snooze FAB.
    const jumpBox = (await button.boundingBox())!
    const overdueBox = (await overdueFab(page).boundingBox())!
    const snoozeBox = (await snoozeFab(page).boundingBox())!
    expect(jumpBox.width).toBe(48)
    expect(jumpBox.x + jumpBox.width).toBeCloseTo(overdueBox.x + overdueBox.width, 0)
    expect(overdueBox.y - (jumpBox.y + jumpBox.height)).toBeCloseTo(12, 0)
    expect(snoozeBox.y - (overdueBox.y + overdueBox.height)).toBeCloseTo(12, 0)

    // List start on screen (mid-viewport): hidden.
    await scrollGroupTo(page, 400)
    await expect(button).toBeHidden()
    // Scrolled past it: still hidden.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await expect.poll(() => firstGroupTop(page)).toBeLessThan(0)
    await expect(button).toBeHidden()
    // Back up to the top, list start below the fold again: it returns.
    await page.evaluate(() => window.scrollTo(0, 0))
    await expect.poll(() => firstGroupTop(page)).toBeGreaterThan(VIEWPORT.height)
    await expect(button).toBeVisible()

    // Tap: no filter, the first group lands under the top bar, button hides.
    await button.click()
    await expect.poll(async () => Math.abs((await firstGroupTop(page)) - LANDING_Y)).toBeLessThan(1)
    await expect(button).toBeHidden()
    await expect(page.locator('[data-pinned-date-chip="overdue"]')).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  test('jump to tasks takes the overdue slot when nothing is overdue', async ({
    authenticatedPage: page,
  }) => {
    // A project with only a future task: the date facet counts 0 overdue, so
    // the overdue button is gone and the column must not keep its gap.
    const project = await post(page, '/api/projects', { name: uniqueTitle('Thumb empty') })
    taskIds.push(
      await post(page, '/api/tasks', {
        title: uniqueTitle('Thumb future row'),
        project_id: project,
        due_at: DateTime.now().setZone(TEST_TZ).plus({ days: 2 }).toUTC().toISO(),
      }),
    )
    try {
      await page.goto(`/?project=${project}`)
      await expect(page.locator('[data-task-group]')).toHaveCount(1)
      await expect(overdueFab(page)).toHaveCount(0)
      expect(await firstGroupTop(page)).toBeGreaterThan(VIEWPORT.height)
      const button = jumpFab(page)
      await expect(button).toBeVisible()
      const jumpBox = (await button.boundingBox())!
      const snoozeBox = (await snoozeFab(page).boundingBox())!
      expect(snoozeBox.y - (jumpBox.y + jumpBox.height)).toBeCloseTo(12, 0)
    } finally {
      await page.request.post('/api/tasks/bulk/delete', { data: { ids: taskIds.splice(-1) } })
      await page.request.delete(`/api/projects/${project}`)
    }
  })

  test('jump to tasks is gone while searching', async ({ authenticatedPage: page }) => {
    await expect(jumpFab(page)).toBeVisible()
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await page.getByPlaceholder('Search...').fill('Thumb row')
    await expect(page.getByText(/\d+ results? for/)).toBeVisible()
    await expect(jumpFab(page)).toHaveCount(0)
  })

  test('the overdue button is 80% opaque with its filter off, opaque with it on', async ({
    authenticatedPage: page,
  }) => {
    const button = overdueFab(page)
    await expect(button).toHaveAttribute('aria-pressed', 'false')
    await expect(button).toHaveClass(/(^|\s)opacity-80(\s|$)/)
    await expect(button).toHaveCSS('opacity', '0.8')

    await button.click()
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    await expect(button).not.toHaveClass(/(^|\s)opacity-80(\s|$)/)
    await expect(button).toHaveCSS('opacity', '1')
  })
})
