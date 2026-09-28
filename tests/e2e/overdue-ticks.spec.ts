/**
 * The dashboard's overdue indicators follow the clock, not just the data
 * (2026-09-27), and the Overdue filter lets go when nothing is left in it.
 *
 * Bug: tasks crossed their due time while the page was open; the rows turned
 * red but the red pill, the pinned Overdue chip and the "↓ N overdue" jump
 * button never appeared, because their counts only re-read "now" when the task
 * list changed. The page now advances one clock at each due time
 * (`useDashboardNow`). Playwright's fake clock moves time forward here, so
 * nothing waits in real time.
 *
 * Every test works inside its own fresh project (`?project=`): the date facet
 * the pill, chip and button count respects the project filter, so the numbers
 * are exact whatever else the shared test user holds.
 */
import { test, expect, uniqueTitle } from './fixtures'
import type { Page } from '@playwright/test'
import { DateTime } from 'luxon'

const pinned = (page: Page) => page.locator('[data-pinned-date-chip="overdue"]')
const redPill = (page: Page) => page.getByRole('button', { name: /^\d+ overdue — / })
const fab = (page: Page) => page.locator('[data-overdue-jump-fab]')
const row = (page: Page, id: number) => page.locator(`#task-row-${id}`)

async function post(page: Page, url: string, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post(url, { data })
  expect(res.ok()).toBeTruthy()
  return (await res.json()).data.id as number
}

test.describe('Overdue follows the clock', () => {
  let taskIds: number[] = []
  let projectId = 0
  let grouping = 'slot'

  test.beforeEach(async ({ authenticatedPage: page }) => {
    grouping = (await (await page.request.get('/api/user/preferences')).json()).data
      .default_grouping as string
    // By-project view: every open task shows, so a task due a minute from now
    // is on screen even when the suite runs just before midnight.
    const written = await page.request.patch('/api/user/preferences', {
      data: { filters_expanded: false, default_grouping: 'project' },
    })
    expect(written.ok()).toBeTruthy()
    projectId = await post(page, '/api/projects', { name: uniqueTitle('Clock project') })
    taskIds = []
  })

  test.afterEach(async ({ authenticatedPage: page }) => {
    for (const id of taskIds.splice(0)) await page.request.delete(`/api/tasks/${id}`)
    await page.request.delete(`/api/projects/${projectId}`)
    await page.request.patch('/api/user/preferences', { data: { default_grouping: grouping } })
  })

  /**
   * One task due a minute from now, in the fresh project; the page loaded
   * under a fake clock. The clock is installed BEFORE the navigation so every
   * timer the page sets runs on it.
   */
  async function openWithTaskDueSoon(page: Page): Promise<number> {
    const id = await post(page, '/api/tasks', {
      title: uniqueTitle('Clock row'),
      project_id: projectId,
      due_at: DateTime.now().plus({ minutes: 1 }).toUTC().toISO(),
    })
    taskIds.push(id)
    await page.clock.install({ time: new Date() })
    await page.goto(`/?project=${projectId}`)
    await expect(row(page, id)).toBeVisible()
    return id
  }

  test('desktop: the red pill and the pinned chip appear when the task becomes overdue', async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const id = await openWithTaskDueSoon(page)
    await expect(pinned(page)).toHaveCount(0)
    await expect(redPill(page)).toHaveCount(0)
    await expect(row(page, id)).not.toHaveClass(/border-l-destructive/)

    // No reload, no data change: only time passes.
    await page.clock.fastForward('02:00')

    await expect(pinned(page)).toBeVisible()
    await expect(pinned(page)).toHaveAttribute('aria-label', /^Overdue, 1 /)
    await expect(redPill(page)).toHaveAttribute('aria-label', /^1 overdue — /)
    await expect(row(page, id)).toHaveClass(/border-l-destructive/)
  })

  test.describe('phone', () => {
    test.use({ viewport: { width: 375, height: 812 } })

    test('the jump button appears when the task becomes overdue', async ({
      authenticatedPage: page,
    }) => {
      await openWithTaskDueSoon(page)
      await expect(fab(page)).toHaveCount(0)

      await page.clock.fastForward('02:00')

      await expect(fab(page)).toBeVisible()
      await expect(fab(page)).toHaveAttribute('aria-label', /^1 overdue — /)
    })
  })

  test('the Overdue filter turns itself off when its last task is done, keeping the project filter', async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const yesterday = DateTime.now().minus({ days: 1 }).toUTC().toISO()
    const overdueA = await post(page, '/api/tasks', {
      title: uniqueTitle('Clock overdue A'),
      project_id: projectId,
      due_at: yesterday,
    })
    const overdueB = await post(page, '/api/tasks', {
      title: uniqueTitle('Clock overdue B'),
      project_id: projectId,
      due_at: yesterday,
    })
    const future = await post(page, '/api/tasks', {
      title: uniqueTitle('Clock future'),
      project_id: projectId,
      due_at: DateTime.now().plus({ days: 2 }).toUTC().toISO(),
    })
    taskIds.push(overdueA, overdueB, future)
    await page.goto(`/?project=${projectId}`)
    await expect(row(page, future)).toBeVisible()

    await expect(pinned(page)).toHaveAttribute('aria-label', /^Overdue, 2 /)
    await pinned(page).click()
    await expect(pinned(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(row(page, future)).toHaveCount(0)

    // One left: the filter stays.
    await row(page, overdueA)
      .getByRole('button', { name: /^Mark ".*" as done$/ })
      .click()
    await expect(row(page, overdueA)).toHaveCount(0)
    await expect(pinned(page)).toHaveAttribute('aria-label', /^Overdue, 1 /)
    await expect(pinned(page)).toHaveAttribute('aria-pressed', 'true')

    // The last one: the filter clears itself and says so.
    await row(page, overdueB)
      .getByRole('button', { name: /^Mark ".*" as done$/ })
      .click()
    await expect(page.getByText('No overdue tasks left — Overdue filter cleared')).toBeVisible()
    await expect(pinned(page)).toHaveCount(0)
    await expect(row(page, future)).toBeVisible()
    // Only Overdue went: the project filter is still the one active filter.
    await expect(page.getByRole('button', { name: /^Filters/ })).toContainText('1')
  })

  test('selecting Overdue with nothing overdue is left alone (no transition, no auto-clear)', async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    taskIds.push(
      await post(page, '/api/tasks', {
        title: uniqueTitle('Clock future only'),
        project_id: projectId,
        due_at: DateTime.now().plus({ days: 2 }).toUTC().toISO(),
      }),
    )
    // The deep link the overdue push and the widget use, landing on a view
    // with nothing overdue: the filter must stay on until the user clears it.
    await page.goto(`/?filter=overdue&project=${projectId}`)
    await expect(pinned(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByText(/Showing 0 of \d+ tasks/)).toBeVisible()
    await expect(page.getByText('No overdue tasks left — Overdue filter cleared')).toHaveCount(0)
  })
})
