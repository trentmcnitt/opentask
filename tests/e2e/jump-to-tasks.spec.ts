/**
 * The dashboard's right-hand FAB column (`DashboardFabStack`), 2026-09-29:
 *
 * - "Jump to tasks" (`JumpToTasksFab`, phone only): a frosted chevron at the
 *   top of the column. A tap scrolls the task list's TOOLBAR ROW ("Select
 *   All" and the sort control) up to just under the top bar, not the first
 *   group — so that row stays visible. It shows whenever the page is scrolled
 *   above that landing (by at least 1px), and hides at or past it.
 * - The view-mode button (`ViewModeFab`): shown while the view is Today or
 *   Newest, with that view's icon, drawn pressed; a tap goes back to All.
 * - Stack order top to bottom: chevron, view mode, overdue, snooze — 12px
 *   apart, one right edge, no hole when one is missing.
 * - The phone overdue button is 80% opaque while its filter is off, and fully
 *   opaque while the filter is on (the pressed toggle state).
 *
 * Seeds: quotas (whose panel sits above the list below `xl`) and enough
 * overdue rows that the page is tall enough for the list's toolbar row to
 * reach the top bar. `beforeEach` starts every test in the Newest view.
 */
import { test, expect, uniqueTitle, waitForPreferenceSave } from './fixtures'
import type { Locator, Page } from '@playwright/test'
import { DateTime } from 'luxon'

/** Must track `globalSetup.ts`'s `E2E_TZ` override — see dashboard.spec.ts. */
const TEST_TZ = process.env.E2E_TZ || 'America/Chicago'
/** `scroll-below-header`'s margin with no safe-area inset: 4.5rem. */
const LANDING_Y = 72
const VIEWPORT = { width: 375, height: 812 }

const jumpFab = (page: Page) => page.locator('[data-jump-to-tasks-fab]')
const viewFab = (page: Page) => page.locator('[data-view-mode-fab]')
const overdueFab = (page: Page) => page.locator('[data-overdue-jump-fab="phone"]')
const snoozeFab = (page: Page) => page.locator('[data-snooze-all-fab]')
/** The zero-height marker at the top of the list wrapper = the toolbar row's top. */
const landingMarker = (page: Page) => page.locator('[data-task-list-landing]')

async function post(page: Page, url: string, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post(url, { data })
  expect(res.ok(), `POST ${url}`).toBeTruthy()
  return (await res.json()).data.id as number
}

/** The toolbar row's top, in viewport pixels. */
async function landingTop(page: Page): Promise<number> {
  return landingMarker(page).evaluate((el) => el.getBoundingClientRect().top)
}

async function box(locator: Locator) {
  const b = await locator.boundingBox()
  expect(b).not.toBeNull()
  return b!
}

/** Each box sits `gap` px above the next, and they share a right edge. */
async function expectColumn(buttons: Locator[], gap = 12) {
  const boxes = []
  for (const b of buttons) boxes.push(await box(b))
  for (let i = 0; i < boxes.length - 1; i++) {
    const [above, below] = [boxes[i], boxes[i + 1]]
    expect(below.y - (above.y + above.height)).toBeCloseTo(gap, 0)
    expect(above.x + above.width).toBeCloseTo(below.x + below.width, 0)
  }
  for (const b of boxes) expect(b.width).toBe(48)
}

/** The width `right-*` on a fixed element measures from: the window's, less
 *  the gutter `scrollbar-gutter: stable` (globals.css) reserves for a classic
 *  scrollbar — `<html>`'s own `clientWidth` still reports the full window. */
async function layoutWidth(page: Page): Promise<number> {
  return page.evaluate(() => document.body.clientWidth)
}

async function viewButton(page: Page, name: 'All' | 'Today' | 'Newest') {
  return page.getByRole('group', { name: 'View mode' }).getByRole('button', { name, exact: true })
}

/**
 * The phone suites' seed, registered as `beforeEach`/`afterEach` in whichever
 * describe calls it. Returns the live id list: a test may push ids of its own
 * onto it, and whatever is on it at the end is deleted.
 */
function usePhoneSeed(): number[] {
  const taskIds: number[] = []
  let grouping = 'slot'

  test.beforeEach(async ({ authenticatedPage: page }) => {
    grouping = (await (await page.request.get('/api/user/preferences')).json()).data
      .default_grouping as string
    const written = await page.request.patch('/api/user/preferences', {
      data: { filters_expanded: false, default_grouping: 'new' },
    })
    expect(written.ok()).toBeTruthy()

    const startOfToday = DateTime.now().setZone(TEST_TZ).startOf('day')
    taskIds.length = 0
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
    // Overdue rows, enough to make the page tall enough for the list's
    // toolbar row to reach the top bar.
    for (let i = 0; i < 16; i++) {
      taskIds.push(
        await post(page, '/api/tasks', {
          title: uniqueTitle(`Thumb row ${i}`),
          due_at: startOfToday.toUTC().toISO(),
        }),
      )
    }
    await page.reload()
    await expect(landingMarker(page)).toHaveCount(1)
    await expect(page.locator('[data-task-group]').first()).toBeVisible()
  })

  test.afterEach(async ({ authenticatedPage: page }) => {
    if (taskIds.length > 0) {
      await page.request.post('/api/tasks/bulk/delete', { data: { ids: taskIds.splice(0) } })
    }
    await page.request.patch('/api/user/preferences', { data: { default_grouping: grouping } })
  })
  return taskIds
}

test.describe('FAB column — phone: jump to tasks', () => {
  test.use({ viewport: VIEWPORT })
  const taskIds = usePhoneSeed()

  test('jump to tasks lands with "Select All" under the top bar, and returns on any scroll up', async ({
    authenticatedPage: page,
  }) => {
    // At the top of the page the toolbar row is below the landing: showing.
    expect(await landingTop(page)).toBeGreaterThan(LANDING_Y)
    const button = jumpFab(page)
    await expect(button).toBeVisible()
    await expect(button).toHaveAttribute('aria-label', 'Jump to tasks')

    // Tap: no filter; the toolbar row lands on the line, just under the top
    // bar — "Select All" and the sort caption visible, not hidden behind it.
    await button.click()
    await expect.poll(async () => Math.abs((await landingTop(page)) - LANDING_Y)).toBeLessThan(1)
    await expect(button).toBeHidden()
    const header = await box(page.locator('header').first())
    const selectAll = page.getByRole('button', { name: 'Select All', exact: true })
    await expect(selectAll).toBeInViewport()
    expect((await box(selectAll)).y).toBeGreaterThanOrEqual(header.y + header.height)
    const sortCaption = page.locator('[data-new-order]')
    await expect(sortCaption).toBeInViewport()
    expect((await box(sortCaption)).y).toBeGreaterThanOrEqual(header.y + header.height)
    await expect(page.locator('[data-pinned-date-chip="overdue"]')).toHaveAttribute(
      'aria-pressed',
      'false',
    )

    // Scroll up 20px from the landing: back at once.
    await page.evaluate(() => window.scrollBy(0, -20))
    await expect.poll(() => landingTop(page)).toBeGreaterThan(LANDING_Y + 1)
    await expect(button).toBeVisible()

    // Past the landing: hidden.
    await page.evaluate(() => window.scrollBy(0, 300))
    await expect.poll(() => landingTop(page)).toBeLessThan(LANDING_Y)
    await expect(button).toBeHidden()

    // From the bottom of the page straight back to the top in one jump (the
    // iOS status-bar tap): it must still notice.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await expect(button).toBeHidden()
    await page.evaluate(() => window.scrollTo(0, 0))
    await expect(button).toBeVisible()
  })

  test('jump to tasks never shows when the landing cannot be scrolled to', async ({
    authenticatedPage: page,
  }) => {
    // A project with one future task and nothing else: the page is too short
    // to bring the list's toolbar row up to the top bar.
    const project = await post(page, '/api/projects', { name: uniqueTitle('Thumb short') })
    taskIds.push(
      await post(page, '/api/tasks', {
        title: uniqueTitle('Thumb short row'),
        project_id: project,
        due_at: DateTime.now().setZone(TEST_TZ).plus({ days: 2 }).toUTC().toISO(),
      }),
    )
    try {
      await page.goto(`/?project=${project}`)
      await expect(page.locator('[data-task-group]')).toHaveCount(1)
      const reachable = await page.evaluate(() => {
        const marker = document.querySelector('[data-task-list-landing]')!
        const target = marker.getBoundingClientRect().top + window.scrollY - 72
        return target - (document.documentElement.scrollHeight - window.innerHeight) < 1
      })
      // Precondition — otherwise the assertion below is vacuous.
      expect(reachable).toBe(false)
      expect(await landingTop(page)).toBeGreaterThan(LANDING_Y)
      await expect(viewFab(page)).toBeVisible()
      await expect(jumpFab(page)).toBeHidden()
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
})

test.describe('FAB column — phone: the stack and the view button', () => {
  test.use({ viewport: VIEWPORT })
  const taskIds = usePhoneSeed()

  test('all four stack chevron, view, overdue, snooze — and close up when one is missing', async ({
    authenticatedPage: page,
  }) => {
    await expect(jumpFab(page)).toBeVisible()
    await expect(viewFab(page)).toBeVisible()
    await expect(overdueFab(page)).toBeVisible()
    await expect(snoozeFab(page)).toBeVisible()
    await expectColumn([jumpFab(page), viewFab(page), overdueFab(page), snoozeFab(page)])
    // 16px in from the layout viewport's right edge (inside any scrollbar gutter).
    const snooze = await box(snoozeFab(page))
    expect(snooze.x + snooze.width).toBeCloseTo((await layoutWidth(page)) - 16, 0)

    // A project with only future tasks: nothing overdue, so the overdue
    // button goes and the rest close up. Enough rows that the chevron's
    // landing can be reached.
    const project = await post(page, '/api/projects', { name: uniqueTitle('Thumb future') })
    const future = DateTime.now().setZone(TEST_TZ).plus({ days: 2 }).toUTC().toISO()
    for (let i = 0; i < 16; i++) {
      taskIds.push(
        await post(page, '/api/tasks', {
          title: uniqueTitle(`Thumb future ${i}`),
          project_id: project,
          due_at: future,
        }),
      )
    }
    try {
      await page.goto(`/?project=${project}`)
      await expect(page.locator('[data-task-group]').first()).toBeVisible()
      await expect(overdueFab(page)).toHaveCount(0)
      await expect(jumpFab(page)).toBeVisible()
      await expectColumn([jumpFab(page), viewFab(page), snoozeFab(page)])
    } finally {
      await page.request.post('/api/tasks/bulk/delete', { data: { ids: taskIds.splice(-16) } })
      await page.request.delete(`/api/projects/${project}`)
    }
  })

  test('the view button shows in Newest and Today with their icons, not in All; a tap goes to All', async ({
    authenticatedPage: page,
  }) => {
    // Newest (from beforeEach).
    const fab = viewFab(page)
    await expect(fab).toBeVisible()
    await expect(fab).toHaveAttribute('data-view-mode-fab', 'new')
    await expect(fab).toHaveAttribute('aria-label', 'Viewing Newest — tap to show All')
    await expect(fab.locator('svg')).toHaveClass(/lucide-arrow-down-wide-narrow/)
    // Drawn pressed: a ring around it, like the lit overdue button.
    expect(await fab.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none')

    // Today.
    let saved = waitForPreferenceSave(page, 'default_grouping')
    await (await viewButton(page, 'Today')).click()
    await saved
    await expect(fab).toHaveAttribute('data-view-mode-fab', 'slot')
    await expect(fab).toHaveAttribute('aria-label', 'Viewing Today — tap to show All')
    await expect(fab.locator('svg')).toHaveClass(/lucide-calendar-clock/)

    // Independent of the Overdue filter: both lit together.
    await overdueFab(page).click()
    await expect(overdueFab(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(fab).toBeVisible()
    await overdueFab(page).click()
    await expect(overdueFab(page)).toHaveAttribute('aria-pressed', 'false')

    // Tap: back to All, saved like a click on the toggle's "All".
    saved = waitForPreferenceSave(page, 'default_grouping')
    await fab.click()
    await saved
    await expect(await viewButton(page, 'All')).toHaveAttribute('aria-pressed', 'true')
    await expect(viewFab(page)).toHaveCount(0)
    const prefs = (await (await page.request.get('/api/user/preferences')).json()).data
    expect(prefs.default_grouping).toBe('time')

    // Survives a reload: still All, still no button.
    await page.reload()
    await expect(await viewButton(page, 'All')).toHaveAttribute('aria-pressed', 'true')
    await expect(viewFab(page)).toHaveCount(0)
    await expect(snoozeFab(page)).toBeVisible()
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

test.describe('FAB column — desktop', () => {
  test.use({ viewport: { width: 1512, height: 900 } })

  let taskIds: number[] = []
  let grouping = 'slot'

  test.beforeEach(async ({ authenticatedPage: page }) => {
    grouping = (await (await page.request.get('/api/user/preferences')).json()).data
      .default_grouping as string
    taskIds = [
      await post(page, '/api/tasks', {
        title: uniqueTitle('Desk overdue row'),
        due_at: DateTime.now().setZone(TEST_TZ).startOf('day').toUTC().toISO(),
      }),
    ]
  })

  test.afterEach(async ({ authenticatedPage: page }) => {
    await page.request.post('/api/tasks/bulk/delete', { data: { ids: taskIds.splice(0) } })
    await page.request.patch('/api/user/preferences', { data: { default_grouping: grouping } })
  })

  test('the view button joins the bottom-right stack in Today and Newest, not in All', async ({
    authenticatedPage: page,
  }) => {
    for (const [view, value] of [
      ['new', 'new'],
      ['slot', 'slot'],
    ] as const) {
      const res = await page.request.patch('/api/user/preferences', {
        data: { default_grouping: view },
      })
      expect(res.ok()).toBeTruthy()
      await page.goto('/')
      const fab = viewFab(page)
      await expect(fab).toBeVisible()
      await expect(fab).toHaveAttribute('data-view-mode-fab', value)
      // No chevron at this width; the view button tops the column, then the
      // desktop overdue button, then snooze — 24px in from the right edge.
      await expect(jumpFab(page)).toBeHidden()
      const desktopOverdue = page.locator('[data-overdue-jump-fab="desktop"]')
      await expectColumn([fab, desktopOverdue, snoozeFab(page)])
      const snooze = await box(snoozeFab(page))
      expect(snooze.x + snooze.width).toBeCloseTo((await layoutWidth(page)) - 24, 0)
      expect(snooze.y + snooze.height).toBeCloseTo(900 - 24, 0)
    }

    const res = await page.request.patch('/api/user/preferences', {
      data: { default_grouping: 'time' },
    })
    expect(res.ok()).toBeTruthy()
    await page.goto('/')
    await expect(snoozeFab(page)).toBeVisible()
    await expect(viewFab(page)).toHaveCount(0)
  })
})
