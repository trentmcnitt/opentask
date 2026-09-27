/**
 * "Take me to the tasks" (Trent, 2026-09-27): the phone's overdue jump button
 * (stacked above the snooze-all FAB) and the top bar's overdue / today pills
 * apply their date filter AND scroll the first task group up under the top
 * bar, past the Reminders and Quotas panels that sit above the list below
 * `xl`. A pill tap that CLEARS its filter does not scroll.
 *
 * Landing spot: every target carries `scroll-below-header`, whose
 * scroll-margin is `env(safe-area-inset-top) + 4.5rem` — 72px in Chromium,
 * which has no safe area. Each test makes enough rows that the page is tall
 * enough for the group to actually reach that spot (a short list stops at the
 * bottom of the page, by design).
 */
import { test, expect, uniqueTitle } from './fixtures'
import type { Page } from '@playwright/test'
import { DateTime } from 'luxon'

/** Must track `globalSetup.ts`'s `E2E_TZ` override — see dashboard.spec.ts. */
const TEST_TZ = process.env.E2E_TZ || 'America/Chicago'
/** `scroll-below-header`'s margin with no safe-area inset: 4.5rem. */
const LANDING_Y = 72

const fab = (page: Page) => page.locator('[data-overdue-jump-fab]')
const pinned = (page: Page) => page.locator('[data-pinned-date-chip="overdue"]')
const redPill = (page: Page) => page.getByRole('button', { name: /^\d+ overdue — / })
const todayPill = (page: Page) => page.getByRole('button', { name: /^\d+ due today — / })
const firstGroup = (page: Page) => page.locator('[data-task-group]').first()

async function post(page: Page, url: string, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post(url, { data })
  expect(res.ok()).toBeTruthy()
  return (await res.json()).data.id as number
}

/** Top of the first task group, in viewport pixels. */
async function firstGroupTop(page: Page): Promise<number> {
  const box = await firstGroup(page).boundingBox()
  expect(box).not.toBeNull()
  return box!.y
}

/** The first group has come to rest just under the top bar. */
async function expectLandedUnderTopBar(page: Page) {
  // Smooth scroll: poll until it settles on the spot. `toBeCloseTo(.., 0)` is
  // ±0.5px — sub-pixel layout rounding, not a tolerance for landing elsewhere.
  await expect.poll(() => firstGroupTop(page)).toBeCloseTo(LANDING_Y, 0)
  const bar = await page.locator('header').first().boundingBox()
  expect(bar).not.toBeNull()
  expect(await firstGroupTop(page)).toBeGreaterThanOrEqual(bar!.y + bar!.height)
}

/** Count `scrollIntoView` calls from here on (the jump's only way to scroll). */
async function countScrollRequests(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __scrollRequests: number }
    w.__scrollRequests = 0
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (...args) {
      w.__scrollRequests++
      return original.apply(this, args)
    }
  })
}

async function scrollRequests(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __scrollRequests: number }).__scrollRequests)
}

async function scrollToBottom(page: Page) {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  await expect.poll(() => firstGroupTop(page)).toBeLessThan(0)
}

test.describe('Overdue jump: filter + scroll to the first group', () => {
  let taskIds: number[] = []
  let projectIds: number[] = []
  let grouping = 'slot'

  test.beforeEach(async ({ authenticatedPage: page }) => {
    grouping = (await (await page.request.get('/api/user/preferences')).json()).data
      .default_grouping as string
    const written = await page.request.patch('/api/user/preferences', {
      data: { filters_expanded: false, default_grouping: 'project' },
    })
    expect(written.ok()).toBeTruthy()

    const startOfToday = DateTime.now().setZone(TEST_TZ).startOf('day')
    const project = await post(page, '/api/projects', { name: uniqueTitle('Jump project') })
    projectIds = [project]
    taskIds = []
    // What the jump has to scroll past: a quota (Track panel) and a reminder
    // (Reminders panel), both above the list below `xl`.
    taskIds.push(
      await post(page, '/api/tasks', {
        title: uniqueTitle('Jump probe quota'),
        progress_target: 2,
        rrule: 'FREQ=WEEKLY',
        create_label: true,
      }),
      await post(page, '/api/tasks', {
        title: uniqueTitle('Jump probe reminder'),
        is_reminder: true,
        due_at: startOfToday.set({ hour: 12 }).toUTC().toISO(),
      }),
    )
    // Local midnight today: overdue AND due today whatever time the suite
    // runs, so one batch fills both filtered lists enough to scroll.
    for (let i = 0; i < 12; i++) {
      taskIds.push(
        await post(page, '/api/tasks', {
          title: uniqueTitle(`Jump row ${i}`),
          project_id: project,
          due_at: startOfToday.toUTC().toISO(),
        }),
      )
    }
    await page.reload()
    await expect(firstGroup(page)).toBeVisible()
  })

  test.afterEach(async ({ authenticatedPage: page }) => {
    for (const id of taskIds.splice(0)) await page.request.delete(`/api/tasks/${id}`)
    for (const id of projectIds.splice(0)) await page.request.delete(`/api/projects/${id}`)
    await page.request.patch('/api/user/preferences', { data: { default_grouping: grouping } })
  })

  test.describe('phone', () => {
    test.use({ viewport: { width: 375, height: 812 } })

    test('the FAB filters to overdue, scrolls the first group under the top bar, then hides', async ({
      authenticatedPage: page,
    }) => {
      const button = fab(page)
      await expect(button).toBeVisible()
      // Its number is the pinned chip's (and the red pill's) — one date facet.
      const chipCount = ((await pinned(page).getAttribute('aria-label')) ?? '').match(/\d+/)
      expect(chipCount).not.toBeNull()
      await expect(button).toHaveAttribute('aria-label', new RegExp(`^${chipCount![0]} overdue — `))
      await expect(button).toHaveText(new RegExp(`^${chipCount![0]}\\s*overdue$`))
      // The list starts below the panels — there is somewhere to jump to.
      expect(await firstGroupTop(page)).toBeGreaterThan(LANDING_Y + 100)

      await button.click()
      await expect(pinned(page)).toHaveAttribute('aria-pressed', 'true')
      await expectLandedUnderTopBar(page)
      // The filter is on: nothing left for it to do.
      await expect(button).toHaveCount(0)

      // Stacked ABOVE the snooze FAB, sharing its right edge, clear of its badge.
      await pinned(page).click()
      await expect(button).toBeVisible()
      const jumpBox = (await button.boundingBox())!
      const snoozeBox = (await page
        .getByRole('button', { name: /^Snooze .*hold for options/ })
        .last()
        .boundingBox())!
      expect(jumpBox.x + jumpBox.width).toBeCloseTo(snoozeBox.x + snoozeBox.width, 0)
      // Badge pokes 4px above the snooze FAB; the gap is 12px.
      expect(snoozeBox.y - (jumpBox.y + jumpBox.height)).toBeCloseTo(12, 0)
    })

    test('the FAB is absent when nothing in view is overdue', async ({
      authenticatedPage: page,
    }) => {
      // A project with only a future task: the date facet (which respects the
      // project filter) counts 0 overdue, whatever else the shared user has.
      const empty = await post(page, '/api/projects', { name: uniqueTitle('Jump empty') })
      projectIds.push(empty)
      taskIds.push(
        await post(page, '/api/tasks', {
          title: uniqueTitle('Jump future row'),
          project_id: empty,
          due_at: DateTime.now().setZone(TEST_TZ).plus({ days: 2 }).toUTC().toISO(),
        }),
      )
      await expect(fab(page)).toBeVisible()
      await page.goto(`/?project=${empty}`)
      await expect(page.locator('[data-task-group]')).toHaveCount(1)
      await expect(fab(page)).toHaveCount(0)
    })
  })

  test.describe('top-bar pills (md, single column)', () => {
    // Below `xl` the panels are still above the list; at md the pills are
    // always rendered (on a phone the container query may drop them).
    test.use({ viewport: { width: 800, height: 600 } })

    test('the red pill filters and scrolls; tapping it again clears without scrolling', async ({
      authenticatedPage: page,
    }) => {
      const pill = redPill(page)
      await countScrollRequests(page)
      await scrollToBottom(page)
      await pill.click()
      await expect(pill).toHaveAttribute('aria-pressed', 'true')
      await expectLandedUnderTopBar(page)
      expect(await scrollRequests(page)).toBe(1)

      // Second tap: the filter clears and NO scroll is asked for. Counted at
      // the call rather than read off `scrollY`, which Chrome's scroll
      // anchoring legitimately nudges when the banner above the list goes.
      await pill.click()
      await expect(pill).toHaveAttribute('aria-pressed', 'false')
      await expect(page.getByText(/Showing \d+ of \d+ tasks/)).toHaveCount(0)
      expect(await scrollRequests(page)).toBe(1)
    })

    test('the today pill filters and scrolls — after the chip section it opens', async ({
      authenticatedPage: page,
    }) => {
      const pill = todayPill(page)
      await scrollToBottom(page)
      await pill.click()
      await expect(pill).toHaveAttribute('aria-pressed', 'true')
      // A Today selection opens the chip section above the list, in the same
      // commit as the filter (`useFilterSection`), so the landing accounts for it.
      await expect(page.locator('#dashboard-filter-chips')).toBeVisible()
      await expectLandedUnderTopBar(page)

      await pill.click()
      await expect(pill).toHaveAttribute('aria-pressed', 'false')
    })
  })
})
