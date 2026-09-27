/**
 * One-tap date filters from the always-visible parts of the dashboard
 * (Trent, 2026-09-26):
 *
 * - the pinned "Overdue N" chip in FilterBar's control row, which applies the
 *   Overdue date filter exclusively WITHOUT opening the filter-chip section,
 *   and clears it on a second tap;
 * - the top bar's red overdue pill and today pill, which apply the Overdue /
 *   Today filter the same way.
 *
 * The pill, the pinned chip and the "Showing N of M" banner must all carry the
 * same number — they count one date-facet set (`useDateFacetCounts`).
 */
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import { DateTime } from 'luxon'

/** Must track `globalSetup.ts`'s `E2E_TZ` override — see dashboard.spec.ts. */
const TEST_TZ = process.env.E2E_TZ || 'America/Chicago'

const pinned = (page: Page) => page.locator('[data-pinned-date-chip="overdue"]')
const redPill = (page: Page) => page.getByRole('button', { name: /^\d+ overdue — / })
const todayPill = (page: Page) => page.getByRole('button', { name: /^\d+ due today — / })
const banner = (page: Page) => page.getByText(/Showing \d+ of \d+ tasks/)

async function createTask(page: Page, body: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data: body })
  expect(res.ok()).toBeTruthy()
  return (await res.json()).data.id as number
}

/** The N in "Showing N of M tasks". */
async function shownCount(page: Page): Promise<number> {
  await expect(banner(page)).toBeVisible()
  const match = (await banner(page).innerText()).match(/Showing (\d+) of/)
  expect(match).not.toBeNull()
  return parseInt(match![1], 10)
}

/** The number a pill/chip displays, read from its accessible name. */
async function leadingNumber(text: Promise<string | null>): Promise<number> {
  const match = ((await text) ?? '').match(/(\d+)/)
  expect(match).not.toBeNull()
  return parseInt(match![1], 10)
}

test.describe('One-tap overdue / today filters', () => {
  let ids: number[] = []
  let grouping = 'slot'

  test.beforeEach(async ({ authenticatedPage: page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    grouping = (await (await page.request.get('/api/user/preferences')).json()).data
      .default_grouping as string
    // Establish the preconditions rather than inherit them from earlier specs:
    // chip section collapsed, Today view (overdue and due-today rows show).
    const written = await page.request.patch('/api/user/preferences', {
      data: { filters_expanded: false, default_grouping: 'slot' },
    })
    expect(written.ok()).toBeTruthy()

    const startOfToday = DateTime.now().setZone(TEST_TZ).startOf('day')
    ids = [
      // Long overdue: overdue, not today.
      await createTask(page, {
        title: 'Pinned chip long-overdue task',
        due_at: startOfToday.minus({ days: 30 }).set({ hour: 9 }).toUTC().toISO(),
      }),
      // Local midnight today: always inside today (and already past), whatever
      // time the suite runs — no clock-edge case.
      await createTask(page, {
        title: 'Pinned chip due-today task',
        due_at: startOfToday.toUTC().toISO(),
      }),
      // Tomorrow noon: neither overdue nor today.
      await createTask(page, {
        title: 'Pinned chip tomorrow task',
        due_at: startOfToday.plus({ days: 1 }).set({ hour: 12 }).toUTC().toISO(),
      }),
    ]
    await page.reload()
    await expect(page.getByRole('button', { name: 'Today', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  test.afterEach(async ({ authenticatedPage: page }) => {
    for (const id of ids) await page.request.delete(`/api/tasks/${id}`)
    await page.request.patch('/api/user/preferences', { data: { default_grouping: grouping } })
  })

  test('the pinned Overdue chip filters to overdue only, without opening the chips, and clears', async ({
    authenticatedPage: page,
  }) => {
    const [overdueId, todayId, tomorrowId] = ids
    const chip = pinned(page)
    await expect(chip).toBeVisible()
    await expect(chip).toHaveAttribute('aria-pressed', 'false')
    // Lives in the always-visible control row, not in the collapsible block.
    await expect(page.locator('#dashboard-filter-chips')).toHaveCount(0)
    const chipCount = await leadingNumber(chip.getAttribute('aria-label'))
    // Same number as the top bar's red pill — one definition, one set.
    expect(await leadingNumber(redPill(page).getAttribute('aria-label'))).toBe(chipCount)

    await chip.click()
    await expect(chip).toHaveAttribute('aria-pressed', 'true')
    expect(await shownCount(page)).toBe(chipCount)
    await expect(page.locator(`#task-row-${overdueId}`)).toBeVisible()
    await expect(page.locator(`#task-row-${todayId}`)).toBeVisible() // due at midnight: overdue too
    await expect(page.locator(`#task-row-${tomorrowId}`)).toHaveCount(0)
    // The filter shows on the toggle's badge, but the section stays shut:
    // the pinned chip itself is the visible state.
    await expect(page.getByRole('button', { name: /^Filters/ })).toContainText('1')
    await expect(page.locator('#dashboard-filter-chips')).toHaveCount(0)

    await chip.click()
    await expect(chip).toHaveAttribute('aria-pressed', 'false')
    await expect(banner(page)).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Filters/ })).toHaveText('Filters')
  })

  test('the red top-bar pill applies the overdue filter; a second tap clears it', async ({
    authenticatedPage: page,
  }) => {
    const pill = redPill(page)
    await expect(pill).toBeVisible()
    const count = await leadingNumber(pill.getAttribute('aria-label'))

    await pill.click()
    await expect(pill).toHaveAttribute('aria-pressed', 'true')
    await expect(pinned(page)).toHaveAttribute('aria-pressed', 'true')
    expect(await shownCount(page)).toBe(count)
    await expect(page.locator(`#task-row-${ids[2]}`)).toHaveCount(0)

    await pill.click()
    await expect(pill).toHaveAttribute('aria-pressed', 'false')
    await expect(banner(page)).toHaveCount(0)
  })

  test('the today pill applies the Today filter exclusively', async ({
    authenticatedPage: page,
  }) => {
    const [overdueId, todayId] = ids
    const pill = todayPill(page)
    await expect(pill).toBeVisible()
    const count = await leadingNumber(pill.getAttribute('aria-label'))

    // Start from the Overdue filter to prove "exclusively": Today replaces it.
    await pinned(page).click()
    await expect(pinned(page)).toHaveAttribute('aria-pressed', 'true')

    await pill.click()
    await expect(pill).toHaveAttribute('aria-pressed', 'true')
    await expect(pinned(page)).toHaveAttribute('aria-pressed', 'false')
    expect(await shownCount(page)).toBe(count)
    await expect(page.locator(`#task-row-${todayId}`)).toBeVisible()
    await expect(page.locator(`#task-row-${overdueId}`)).toHaveCount(0)
    // A Today selection is not shown by the control row, so the chips open.
    await expect(page.locator('#dashboard-filter-chips [data-date-chip="today"]')).toHaveClass(
      /bg-foreground/,
    )

    await pill.click()
    await expect(banner(page)).toHaveCount(0)
  })
})
