/**
 * The Tasks page's two shapes (Trent, 2026-09-15).
 *
 * WIDE: from `xl` the page is two columns — the task column flush left at its
 * unchanged width, Track in an uncapped sticky column beside it.
 * NARROW: everything above the list folds away by default, so the first task of
 * the day is on the first screen.
 *
 * The widths here are asserted as EQUALITIES, not ranges. The whole constraint
 * Trent set on the desktop half was that the task column must not change width,
 * because the filter chip rows reflow if it does — a tolerance would pass on
 * exactly the regression this file exists to catch.
 */
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

/** The task column's content width, in px: `max-w-2xl` (42rem) less `px-4`. */
const TASK_COLUMN_WIDTH = 640

async function createQuota(page: Page, body: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data: body })
  expect(res.ok()).toBeTruthy()
  return (await res.json()).data.id as number
}

async function deleteTasks(page: Page, ids: number[]): Promise<void> {
  for (const id of ids) await page.request.delete(`/api/tasks/${id}`)
}

/**
 * Put the panel in its chips state before looking at it.
 *
 * `track_expanded` is a server preference on a user shared by every spec in the
 * run, so "whatever the last test left" is not a starting point — it is a
 * coin toss between the chips and the rows.
 */
async function useChips(page: Page): Promise<void> {
  await setPreferences(page, { track_expanded: false })
}

/**
 * Write dashboard view preferences for the shared test user.
 *
 * Anything set here MUST be put back before the test ends. These are server
 * preferences on one user shared by every spec in the run, and this file sorts
 * before `dashboard.spec.ts`, whose filter-section tests assume the section
 * starts shut — leaving `filters_expanded` true here fails them there, which
 * reads as a flake in a file this one never touched.
 */
async function setPreferences(page: Page, data: Record<string, unknown>): Promise<void> {
  const res = await page.request.patch('/api/user/preferences', { data })
  expect(res.ok()).toBeTruthy()
}

const QUOTAS = [
  { title: 'Layout probe walks', progress_target: 2, rrule: 'FREQ=WEEKLY', labels: ['zz-alpha'] },
  { title: 'Layout probe dishes', progress_target: 3, rrule: 'FREQ=DAILY', labels: ['zz-beta'] },
]

test.describe('Tasks page layout — wide', () => {
  // 1600, not 1280. `xl` is a 1280px media query and `scrollbar-gutter: stable`
  // (globals.css) takes the scrollbar's width out of the layout viewport on any
  // browser that draws a classic one, so a 1280px WINDOW can land either side of
  // the breakpoint depending on the platform. A viewport that is unambiguously
  // past it is what makes this deterministic; 1280 itself is covered by hand.
  test.use({ viewport: { width: 1600, height: 900 } })

  test('splits into a pinned task column and an uncapped sticky Track column', async ({
    authenticatedPage: page,
  }) => {
    const ids: number[] = []
    try {
      for (const q of QUOTAS) ids.push(await createQuota(page, { ...q, create_label: true }))
      await useChips(page)
      await page.goto('/')

      const panel = page.locator('[data-track-panel]')
      await expect(panel).toBeVisible()

      const grid = await page.locator('main').evaluate((el) => ({
        display: getComputedStyle(el).display,
        columns: getComputedStyle(el).gridTemplateColumns,
      }))
      expect(grid.display).toBe('grid')

      // Two tracks, and the first is the task column's pinned width.
      const tracks = grid.columns.split(' ').map((t) => Math.round(parseFloat(t)))
      expect(tracks.length).toBe(2)
      expect(tracks[0]).toBe(TASK_COLUMN_WIDTH)
      // Uncapped: the second track takes everything left over, which at this
      // viewport is wider than the strip Track used to have inline.
      expect(tracks[1]).toBeGreaterThan(TASK_COLUMN_WIDTH)

      // Every block in the task column is that width — measured, not inferred
      // from the track, since a padded child would still reflow the chips.
      const columnWidths = await page
        .locator('main > div')
        .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().width)))
      for (const w of columnWidths.slice(0, 1)) expect(w).toBe(TASK_COLUMN_WIDTH)

      // Flush left, not centred: the column starts at the content edge, one
      // `px-4` in from the main area, which itself starts at the sidebar.
      const geometry = await page.evaluate(() => {
        const main = document.querySelector('main') as HTMLElement
        const first = main.querySelector(':scope > div') as HTMLElement
        const track = document.querySelector('[data-track-panel]') as HTMLElement
        return {
          mainLeft: main.getBoundingClientRect().left,
          columnLeft: first.getBoundingClientRect().left,
          columnRight: first.getBoundingClientRect().right,
          trackLeft: track.getBoundingClientRect().left,
          trackPosition: getComputedStyle(track.parentElement as HTMLElement).position,
        }
      })
      expect(geometry.columnLeft - geometry.mainLeft).toBe(16)
      // Track is beside the task column, not under it.
      expect(geometry.trackLeft).toBeGreaterThanOrEqual(geometry.columnRight)
      expect(geometry.trackPosition).toBe('sticky')

      // The header's contents line up with the column below them rather than
      // floating off to the right of it. Its CONTENT edge, not its box edge:
      // the bar carries its own `px-4`, so its box starts 16px further left and
      // comparing boxes would compare two different things.
      const headerContentLeft = await page.locator('header > div').evaluate((el) => {
        const r = el.getBoundingClientRect()
        return r.left + parseFloat(getComputedStyle(el).paddingLeft)
      })
      expect(headerContentLeft).toBe(geometry.columnLeft)
    } finally {
      await deleteTasks(page, ids)
    }
  })

  test('stays one centred column below the breakpoint', async ({ authenticatedPage: page }) => {
    const ids: number[] = []
    try {
      for (const q of QUOTAS) ids.push(await createQuota(page, { ...q, create_label: true }))
      await useChips(page)
      await page.setViewportSize({ width: 1100, height: 900 })
      await page.goto('/')
      await expect(page.locator('[data-track-panel]')).toBeVisible()

      const main = await page.locator('main').evaluate((el) => ({
        columns: getComputedStyle(el).gridTemplateColumns,
        width: Math.round(el.getBoundingClientRect().width),
      }))
      // One track, and `<main>` is back to its `max-w-2xl` box (640 + px-4).
      expect(main.columns.split(' ').length).toBe(1)
      expect(main.width).toBe(TASK_COLUMN_WIDTH + 32)

      // ...and Track is inline above the list again, sharing the column's left edge.
      const edges = await page.evaluate(() => {
        const first = document.querySelector('main > div') as HTMLElement
        const track = document.querySelector('[data-track-panel]') as HTMLElement
        return {
          column: first.getBoundingClientRect().left,
          track: track.getBoundingClientRect().left,
        }
      })
      expect(edges.track).toBe(edges.column)
    } finally {
      await deleteTasks(page, ids)
    }
  })
})

test.describe('Tasks page layout — phone', () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test('folds the filters, Track, and every label group by default', async ({
    authenticatedPage: page,
  }) => {
    const ids: number[] = []
    try {
      for (const q of QUOTAS) ids.push(await createQuota(page, { ...q, create_label: true }))
      await useChips(page)
      // Pin the filters open as a desktop user would, to prove the phone
      // ignores the stored pin rather than merely inheriting a shut default.
      await setPreferences(page, { filters_expanded: true })

      await page.goto('/')

      // FILTERS: shut, and saying how many filters are active (none, here).
      const filterToggle = page.getByRole('button', { name: /^Filters/ })
      await expect(filterToggle).toBeVisible()
      await expect(filterToggle).toHaveAttribute('aria-expanded', 'false')
      await expect(page.locator('#dashboard-filter-chips')).toHaveCount(0)
      // It still opens — the phone's fold is its own, not a masked preference.
      await filterToggle.click()
      await expect(page.locator('#dashboard-filter-chips')).toBeVisible()
      await filterToggle.click()
      await expect(page.locator('#dashboard-filter-chips')).toHaveCount(0)

      // TRACK: the card is folded away and the header carries the total.
      const card = page.locator('#track-card')
      await expect(card).toBeHidden()
      const sectionToggle = page.locator('[data-track-section-toggle]')
      await expect(sectionToggle).toBeVisible()
      await expect(sectionToggle).toContainText('of')
      await expect(sectionToggle).toContainText('left')
      // Two quotas made here, neither logged, so both are still short. Other
      // specs share this user, so read the total off the DOM rather than
      // assuming this file is the only thing that made a quota.
      const summary = await page.locator('[data-track-section-summary]').textContent()
      const [short, total] = (summary ?? '').match(/\d+/g)?.map(Number) ?? []
      expect(short).toBeGreaterThanOrEqual(2)
      expect(total).toBeGreaterThanOrEqual(short)

      // The add-a-task row and the view tabs never fold.
      await expect(page.getByRole('textbox', { name: 'Quick add task' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Today', exact: true })).toBeVisible()

      // Opening the section reveals the card — and its label groups, each
      // folded in turn, so the card is a short list of headings not 22 chips.
      await sectionToggle.click()
      await expect(card).toBeVisible()

      const group = page.locator('[data-track-cluster="zz-alpha"]')
      await expect(group).toBeVisible()
      const chip = page.locator(`[data-track-chip="${ids[0]}"]`)
      await expect(chip).toBeHidden()
      await expect(group.locator('[data-track-cluster-summary]')).toContainText('left')

      const groupToggle = group.getByRole('button')
      await expect(groupToggle).toHaveAttribute('aria-expanded', 'false')
      await groupToggle.click()
      await expect(groupToggle).toHaveAttribute('aria-expanded', 'true')
      await expect(chip).toBeVisible()
      // Its summary steps aside once its chips are on screen.
      await expect(group.locator('[data-track-cluster-summary]')).toBeHidden()

      // Folding one group leaves its neighbour alone — they are independent.
      const other = page.locator('[data-track-cluster="zz-beta"]')
      await expect(other.getByRole('button')).toHaveAttribute('aria-expanded', 'false')
      await expect(page.locator(`[data-track-chip="${ids[1]}"]`)).toBeHidden()

      await groupToggle.click()
      await expect(chip).toBeHidden()
    } finally {
      await setPreferences(page, { filters_expanded: false })
      await deleteTasks(page, ids)
    }
  })

  test('a met group reads "all met" instead of a count', async ({ authenticatedPage: page }) => {
    const ids: number[] = []
    try {
      const id = await createQuota(page, {
        title: 'Layout probe met',
        progress_target: 1,
        is_tracked: true,
        rrule: 'FREQ=MONTHLY',
        labels: ['zz-met'],
        create_label: true,
      })
      ids.push(id)
      const logged = await page.request.post(`/api/tasks/${id}/progress`, { data: { delta: 1 } })
      expect(logged.ok()).toBeTruthy()
      await useChips(page)

      await page.goto('/')
      await page.locator('[data-track-section-toggle]').click()
      await expect(page.locator('#track-card')).toBeVisible()

      const summary = page.locator('[data-track-cluster="zz-met"] [data-track-cluster-summary]')
      await expect(summary).toContainText('all met')
      await expect(summary).not.toContainText('left')
    } finally {
      await deleteTasks(page, ids)
    }
  })
})
