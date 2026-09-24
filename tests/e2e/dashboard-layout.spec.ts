/**
 * The Tasks page's two shapes (Trent, 2026-09-15).
 *
 * WIDE: from `xl` the page is two EQUAL columns — the day on the left, Track in
 * a sticky column of the same width beside it, the pair centred inside a capped
 * box with a real side margin.
 * NARROW: everything above the list folds away by default, so the first task of
 * the day is on the first screen.
 *
 * The first cut pinned the task column at 640px and let Track take every spare
 * pixel, so the chip rows could not reflow. Trent rejected the result ("the
 * left side is too skinny or the right too wide, it looks bizarre") and
 * replaced the constraint: the columns match each other, and the chip rows
 * reflowing is accepted. So the equality asserted here is now BETWEEN THE TWO
 * COLUMNS rather than against a fixed number.
 *
 * THE BLANK BAND. `<main>` is `flex-1` in a `min-h-screen` flex column and a
 * grid, and a grid's default `align-content` divides leftover height between
 * its rows. Every short-content state therefore used to open a band between the
 * filters, Track and the list. Two tests below measure that the three blocks
 * still sit directly on top of one another when the page does not fill the
 * viewport; they assert their own preconditions (that leftover exists, and at
 * `xl` that Track is the taller column) because without those they would pass
 * on a page that simply had no leftover to distribute.
 */
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

/** `xl:max-w-[86.5rem]`, in px — see `mainClass` for the arithmetic. */
const MAIN_MAX_WIDTH = 86.5 * 16
/** `xl:px-10`. */
const WIDE_PADDING = 40
/** The single column's content width below `xl`: `max-w-2xl` (42rem) less `px-4`. */
const NARROW_COLUMN_WIDTH = 640

async function createQuota(page: Page, body: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data: body })
  expect(res.ok()).toBeTruthy()
  return (await res.json()).data.id as number
}

async function deleteTasks(page: Page, ids: number[]): Promise<void> {
  for (const id of ids) await page.request.delete(`/api/tasks/${id}`)
}

/**
 * Write dashboard view preferences for the shared test user.
 *
 * Anything set here MUST be put back before the test ends, with
 * `restorePreferences` — these are server preferences on one user shared by
 * every spec in the run, and this file sorts before `dashboard.spec.ts`.
 * `withPreferences` does the reading, writing and restoring in one piece so a
 * test cannot forget the last part.
 */
async function setPreferences(page: Page, data: Record<string, unknown>): Promise<void> {
  const res = await page.request.patch('/api/user/preferences', { data })
  expect(res.ok()).toBeTruthy()
}

/**
 * Put preferences back. NO `expect` ANYWHERE IN HERE, deliberately: this runs
 * from `finally`, and an assertion that fails during cleanup replaces the real
 * failure with a meaningless one and hides what the test actually caught.
 */
async function restorePreferences(page: Page, data: Record<string, unknown>): Promise<void> {
  await page.request.patch('/api/user/preferences', { data }).catch(() => {})
}

/**
 * Run `body` with the given preferences applied, then put back exactly what was
 * there before — read from the server rather than assumed, since another spec
 * in the same run may have left them anywhere.
 */
async function withPreferences(
  page: Page,
  data: Record<string, boolean>,
  body: () => Promise<void>,
): Promise<void> {
  const res = await page.request.get('/api/user/preferences')
  expect(res.ok()).toBeTruthy()
  const before = (await res.json()).data as Record<string, unknown>
  const previous = Object.fromEntries(Object.keys(data).map((k) => [k, before[k]]))
  await setPreferences(page, data)
  try {
    await body()
  } finally {
    await restorePreferences(page, previous)
  }
}

/** The three grid children of `<main>`, in DOM order: filters, Track, list. */
async function gridGeometry(page: Page) {
  return page.evaluate(() => {
    const main = document.querySelector('main') as HTMLElement
    const children = Array.from(main.children) as HTMLElement[]
    const box = (el: HTMLElement) => {
      const r = el.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }
    }
    return {
      rowGap: parseFloat(getComputedStyle(main).rowGap) || 0,
      mainHeight: main.getBoundingClientRect().height,
      mainWidth: main.getBoundingClientRect().width,
      mainLeft: main.getBoundingClientRect().left,
      paddingLeft: parseFloat(getComputedStyle(main).paddingLeft),
      columns: getComputedStyle(main)
        .gridTemplateColumns.split(' ')
        .map((t) => Math.round(parseFloat(t))),
      filters: box(children[0]),
      track: box(children[1]),
      list: box(children[2]),
    }
  })
}

const QUOTAS = [
  { title: 'Layout probe walks', progress_target: 2, rrule: 'FREQ=WEEKLY', labels: ['zz-alpha'] },
  { title: 'Layout probe dishes', progress_target: 3, rrule: 'FREQ=DAILY', labels: ['zz-beta'] },
]

/** Enough quotas, in the rows view, to make Track unambiguously the tall column. */
const TALL_QUOTAS = Array.from({ length: 10 }, (_, i) => ({
  title: `Layout probe tall ${i}`,
  progress_target: 2,
  rrule: 'FREQ=WEEKLY',
  labels: [i % 2 === 0 ? 'zz-alpha' : 'zz-beta'],
}))

/**
 * Fold every group in the task list, leaving a column of headings.
 *
 * Scoped to the list's own grid child: the Track panel's desktop header button
 * used to be labelled "Collapse Quotas" and would have been swept up. The loop
 * waits on the COUNT rather than on any one button — clicking relabels the
 * button to "Expand …", so each click removes exactly one from the set, and
 * Playwright's own retry does the waiting.
 */
async function collapseAllGroups(page: Page): Promise<void> {
  const collapse = page.locator('main > div').nth(2).locator('button[aria-label^="Collapse "]')
  let remaining = await collapse.count()
  expect(remaining).toBeGreaterThan(0)
  while (remaining > 0) {
    await collapse.first().click()
    remaining -= 1
    await expect(collapse).toHaveCount(remaining)
  }
}

test.describe('Tasks page layout — wide', () => {
  // 1600, not 1280. `xl` is a 1280px media query and `scrollbar-gutter: stable`
  // (globals.css) takes the scrollbar's width out of the layout viewport on any
  // browser that draws a classic one, so a 1280px WINDOW can land either side of
  // the breakpoint depending on the platform. A viewport that is unambiguously
  // past it is what makes this deterministic; 1280 itself is covered by hand.
  test.use({ viewport: { width: 1600, height: 900 } })

  test('splits into two equal columns inside a capped, padded box', async ({
    authenticatedPage: page,
  }) => {
    const ids: number[] = []
    try {
      for (const q of QUOTAS) ids.push(await createQuota(page, { ...q, create_label: true }))
      await withPreferences(page, { track_expanded: false }, async () => {
        await page.goto('/')

        const panel = page.locator('[data-track-panel]')
        await expect(panel).toBeVisible()

        const g = await gridGeometry(page)
        expect(await page.locator('main').evaluate((el) => getComputedStyle(el).display)).toBe(
          'grid',
        )

        // Two tracks, and they are the same width as each other. That is the
        // whole desktop constraint now.
        expect(g.columns.length).toBe(2)
        expect(g.columns[0]).toBe(g.columns[1])

        // The pair is capped, and never wider than the space it is given.
        expect(g.mainWidth).toBeLessThanOrEqual(MAIN_MAX_WIDTH)

        // A REAL side margin, not `px-4`'s 16px: this is the fix for the logo
        // sitting hard against the sidebar.
        expect(g.paddingLeft).toBe(WIDE_PADDING)

        // Both blocks in the task column are the column's width — measured, not
        // inferred from the track, since a padded child would sit narrower.
        expect(Math.round(g.filters.right - g.filters.left)).toBe(g.columns[0])
        expect(Math.round(g.list.right - g.list.left)).toBe(g.columns[0])

        // Track is beside the task column, not under it, and sticky.
        expect(g.track.left).toBeGreaterThanOrEqual(g.filters.right)
        const position = await page
          .locator('[data-track-panel]')
          .evaluate((el) => getComputedStyle(el.parentElement as HTMLElement).position)
        expect(position).toBe('sticky')

        // The header's contents line up with the column below them rather than
        // floating off to one side. Its CONTENT edge, not its box edge: the bar
        // carries its own padding, so comparing boxes would compare two
        // different things.
        const headerContentLeft = await page.locator('header > div').evaluate((el) => {
          const r = el.getBoundingClientRect()
          return r.left + parseFloat(getComputedStyle(el).paddingLeft)
        })
        expect(headerContentLeft).toBe(g.filters.left)
      })
    } finally {
      await deleteTasks(page, ids)
    }
  })

  test('stops growing on an ultrawide window', async ({ authenticatedPage: page }) => {
    const ids: number[] = []
    try {
      for (const q of QUOTAS) ids.push(await createQuota(page, { ...q, create_label: true }))
      await withPreferences(page, { track_expanded: false }, async () => {
        await page.setViewportSize({ width: 2400, height: 900 })
        await page.goto('/')
        await expect(page.locator('[data-track-panel]')).toBeVisible()

        const g = await gridGeometry(page)
        // Capped exactly, and centred in what is left — so the margin grows
        // rather than the columns.
        expect(Math.round(g.mainWidth)).toBe(MAIN_MAX_WIDTH)
        expect(g.columns[0]).toBe(g.columns[1])
        // Each column tops out at the width the single column has always been.
        expect(g.columns[0]).toBe(NARROW_COLUMN_WIDTH)
      })
    } finally {
      await deleteTasks(page, ids)
    }
  })

  test('leaves no blank band when the columns are short and Track is tall', async ({
    authenticatedPage: page,
  }) => {
    const ids: number[] = []
    try {
      for (const q of TALL_QUOTAS) ids.push(await createQuota(page, { ...q, create_label: true }))
      // Rows, not chips: rows are what make Track taller than the task column,
      // which is the state that exposes the `row-span-2` half of the bug.
      await withPreferences(page, { track_expanded: true, filters_expanded: false }, async () => {
        await page.goto('/')
        await expect(page.locator('[data-track-panel]')).toBeVisible()
        // A short LEFT column is the point of this test.
        await collapseAllGroups(page)

        const g = await gridGeometry(page)

        // PRECONDITIONS. Without both of these the assertion below is vacuous.
        // 1. There is leftover height for `align-content` to distribute.
        expect(g.mainHeight).toBeGreaterThan(g.filters.height + g.list.height)
        // 2. Track really is the taller column, so it is spanning into the row
        //    the list lives in.
        expect(g.track.height).toBeGreaterThan(g.filters.height + g.list.height)

        // THE ASSERTION: the list sits directly under the filters, with only
        // the grid's own row gap (none) between them.
        expect(g.list.top - g.filters.bottom).toBe(g.rowGap)
      })
    } finally {
      await deleteTasks(page, ids)
    }
  })

  test('stays one centred column below the breakpoint', async ({ authenticatedPage: page }) => {
    const ids: number[] = []
    try {
      for (const q of QUOTAS) ids.push(await createQuota(page, { ...q, create_label: true }))
      await withPreferences(page, { track_expanded: false }, async () => {
        await page.setViewportSize({ width: 1100, height: 900 })
        await page.goto('/')
        await expect(page.locator('[data-track-panel]')).toBeVisible()

        const g = await gridGeometry(page)
        // One track, and `<main>` is back to its `max-w-2xl` box (640 + px-4).
        expect(g.columns.length).toBe(1)
        expect(Math.round(g.mainWidth)).toBe(NARROW_COLUMN_WIDTH + 32)

        // ...and Track is inline above the list again, sharing the column's left edge.
        const trackLeft = await page
          .locator('[data-track-panel]')
          .evaluate((el) => el.getBoundingClientRect().left)
        expect(trackLeft).toBe(g.filters.left)
      })
    } finally {
      await deleteTasks(page, ids)
    }
  })
})

test.describe('Tasks page layout — phone', () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test('folds the filters, but leaves Track and its label groups open', async ({
    authenticatedPage: page,
  }) => {
    const ids: number[] = []
    try {
      for (const q of QUOTAS) ids.push(await createQuota(page, { ...q, create_label: true }))
      // Pin the filters open as a desktop user would, to prove the phone
      // ignores the stored pin rather than merely inheriting a shut default.
      await withPreferences(page, { track_expanded: false, filters_expanded: true }, async () => {
        await page.goto('/')

        // FILTERS: still shut on a phone, and saying how many filters are
        // active (none, here). Only Track's default changed.
        const filterToggle = page.getByRole('button', { name: /^Filters/ })
        await expect(filterToggle).toBeVisible()
        await expect(filterToggle).toHaveAttribute('aria-expanded', 'false')
        await expect(page.locator('#dashboard-filter-chips')).toHaveCount(0)
        // It still opens — the phone's fold is its own, not a masked preference.
        await filterToggle.click()
        await expect(page.locator('#dashboard-filter-chips')).toBeVisible()
        await filterToggle.click()
        await expect(page.locator('#dashboard-filter-chips')).toHaveCount(0)

        // TRACK: open by default now, chips and all, so a quota can be checked
        // off without opening anything first. Trent reversed this on
        // 2026-09-21 ("Everything should be expanded for the track on mobile.
        // Otherwise I can't check things off easily"), accepting that it
        // pushes the day down.
        const card = page.locator('#track-card')
        await expect(card).toBeVisible()
        const group = page.locator('[data-track-cluster="zz-alpha"]')
        await expect(group).toBeVisible()
        await expect(group.getByRole('button')).toHaveAttribute('aria-expanded', 'true')
        // The chips themselves are reachable — the point of the reversal.
        await expect(page.locator(`[data-track-chip="${ids[0]}"]`)).toBeVisible()
        await expect(page.locator(`[data-track-chip="${ids[1]}"]`)).toBeVisible()
        // A group's shut-state summary stands aside while its chips show.
        await expect(group.locator('[data-track-cluster-summary]')).toBeHidden()

        // The add-a-task row and the view tabs never fold.
        await expect(page.getByRole('textbox', { name: 'Quick add task' })).toBeVisible()
        await expect(page.getByRole('button', { name: 'Today', exact: true })).toBeVisible()

        // Shutting still works, and is still per-group — the default moved,
        // the mechanism did not.
        const groupToggle = group.getByRole('button')
        await groupToggle.click()
        await expect(groupToggle).toHaveAttribute('aria-expanded', 'false')
        await expect(page.locator(`[data-track-chip="${ids[0]}"]`)).toBeHidden()
        await expect(group.locator('[data-track-cluster-summary]')).toContainText('left')
        // Its neighbour is untouched.
        await expect(page.locator(`[data-track-chip="${ids[1]}"]`)).toBeVisible()

        // And the whole section still folds from its header.
        const sectionToggle = page.locator('[data-track-section-toggle]')
        await expect(sectionToggle).toBeVisible()
        await sectionToggle.click()
        await expect(card).toBeHidden()
        await expect(sectionToggle).toContainText('left')
      })
    } finally {
      await deleteTasks(page, ids)
    }
  })

  /**
   * The phone half of the blank-band regression, in the state that showed it
   * worst (187px of nothing at 375x812): a search that matches no task. Here
   * the grid is one column of three rows, so the leftover would have been split
   * TWICE — once above Track and once above the list.
   */
  test('leaves no blank band when a search matches nothing', async ({
    authenticatedPage: page,
  }) => {
    const ids: number[] = []
    try {
      for (const q of QUOTAS) ids.push(await createQuota(page, { ...q, create_label: true }))
      await withPreferences(page, { track_expanded: false }, async () => {
        await page.goto('/')
        await expect(page.locator('[data-track-panel]')).toBeVisible()

        await page.getByRole('button', { name: 'Search', exact: true }).click()
        await page.getByRole('textbox', { name: 'Search tasks' }).fill('zz-no-such-task-anywhere')
        await expect(page.getByText(/^0 results for/)).toBeVisible()

        const g = await gridGeometry(page)
        // Precondition: the page really is shorter than the viewport, so there
        // is leftover height for `align-content` to have distributed.
        expect(g.mainHeight).toBeGreaterThan(
          g.filters.height + g.track.height + g.list.height + 2 * g.rowGap,
        )

        expect(g.track.top - g.filters.bottom).toBe(g.rowGap)
        expect(g.list.top - g.track.bottom).toBe(g.rowGap)
      })
    } finally {
      await deleteTasks(page, ids)
    }
  })

  /**
   * `track_expanded` is a SERVER preference, so a user who chose the rows view
   * at a desk arrives on his phone in it. Before this control there was no
   * `sm:hidden` handle for it anywhere and he was simply stuck in the taller
   * view — the regression this test pins.
   */
  test('offers a way back to the chips view on a phone', async ({ authenticatedPage: page }) => {
    const ids: number[] = []
    try {
      for (const q of QUOTAS) ids.push(await createQuota(page, { ...q, create_label: true }))
      await withPreferences(page, { track_expanded: true }, async () => {
        await page.goto('/')
        // No opening click: Track is open by default at every width as of
        // 2026-09-21 (see the fold spec above), so clicking here would SHUT it.
        await expect(page.locator('#track-card')).toBeVisible()

        // Rows, because the stored preference says so. Counted rather than
        // checked for visibility, so this keeps asserting the VIEW (rows exist,
        // chips do not) independently of whether a cluster happens to be open.
        await expect(page.locator(`[data-track-row="${ids[0]}"]`)).toHaveCount(1)
        await expect(page.locator('[data-track-chip]')).toHaveCount(0)

        const viewToggle = page.locator('[data-track-view-toggle]')
        await expect(viewToggle).toBeVisible()
        await expect(viewToggle).toHaveText('Show as chips')
        await viewToggle.click()

        // Chips now — and the control offers the way back.
        await expect(viewToggle).toHaveText('Show as rows')
        await expect(page.locator(`[data-track-chip="${ids[0]}"]`)).toHaveCount(1)
        await expect(page.locator('[data-track-row]')).toHaveCount(0)
      })
    } finally {
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

      await withPreferences(page, { track_expanded: false }, async () => {
        await page.goto('/')
        // No opening click: Track is open by default at every width as of
        // 2026-09-21 (see the fold spec above), so clicking here would SHUT it.
        await expect(page.locator('#track-card')).toBeVisible()

        // Met before the page loaded, so the label is put away — nothing
        // stands in for it inside its period section (Trent, 2026-09-23; see
        // `finishedClusterInSection` in TrackPanel.tsx). Its header — what
        // this test is about — comes back when the met quotas are shown.
        const cluster = page.locator('[data-track-cluster="zz-met"]')
        await expect(cluster).toHaveCount(0)
        await page.locator('[data-track-met-toggle]').click()

        const summary = page.locator('[data-track-cluster="zz-met"] [data-track-cluster-summary]')
        await expect(summary).toContainText('all met')
        await expect(summary).not.toContainText('left')
      })
    } finally {
      await deleteTasks(page, ids)
    }
  })
})
