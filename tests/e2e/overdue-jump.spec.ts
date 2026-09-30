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
 *
 * From `md` up the same button is fixed at the viewport's bottom-right
 * (Trent, 2026-09-28) — it stays on screen while a long list scrolls.
 */
import { test, expect, uniqueTitle } from './fixtures'
import type { Locator, Page } from '@playwright/test'
import { DateTime } from 'luxon'

/** Must track `globalSetup.ts`'s `E2E_TZ` override — see dashboard.spec.ts. */
const TEST_TZ = process.env.E2E_TZ || 'America/Chicago'
/** `scroll-below-header`'s margin with no safe-area inset: 4.5rem. */
const LANDING_Y = 72

/** Both placements are always in the DOM together (one per breakpoint), so
 *  every lookup names which one it means. */
const fab = (page: Page) => page.locator('[data-overdue-jump-fab="phone"]')
const deskFab = (page: Page) => page.locator('[data-overdue-jump-fab="desktop"]')
const pinned = (page: Page) => page.locator('[data-pinned-date-chip="overdue"]')
/** The top bar's red pill — anchored at both ends, because the md+ overdue
 *  jump button's label ("N overdue — show only overdue tasks and scroll to
 *  them") starts the same way. */
const redPill = (page: Page) =>
  page.getByRole('button', {
    name: /^\d+ overdue — (show only overdue tasks|clear the overdue filter)$/,
  })
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
  // Smooth scroll: poll until it settles on the spot. The scroll offset is a
  // whole device pixel (DPR 1 here) while the group's layout position can sit
  // on a half pixel, so it rests at 71.5 or 72 depending on the rows above —
  // within one device pixel is "on the spot", not a tolerance for landing
  // elsewhere.
  await expect.poll(async () => Math.abs((await firstGroupTop(page)) - LANDING_Y)).toBeLessThan(1)
  const bar = await page.locator('header').first().boundingBox()
  expect(bar).not.toBeNull()
  expect(await firstGroupTop(page)).toBeGreaterThanOrEqual(bar!.y + bar!.height)
}

/**
 * After a jump the button stays, drawn pressed (Trent, 2026-09-28), and a
 * second tap takes the Overdue filter off without asking for a scroll —
 * the lit pill's rule. Needs `countScrollRequests` called before the jump.
 */
async function expectLitThenCleared(page: Page, button: Locator) {
  await expect(button).toBeVisible()
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  await button.click()
  await expect(pinned(page)).toHaveAttribute('aria-pressed', 'false')
  await expect(button).toHaveAttribute('aria-pressed', 'false')
  expect(await scrollRequests(page)).toBe(1)
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
    // New: one flat, uncapped list, so every filtered row is on the page and
    // it is tall enough to scroll. (All, grouped by project, caps each
    // project at the user's `project_preview_count`.)
    const written = await page.request.patch('/api/user/preferences', {
      data: { filters_expanded: false, default_grouping: 'new' },
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

    test('the FAB filters to overdue and scrolls the first group under the top bar; lit, it clears the filter', async ({
      authenticatedPage: page,
    }) => {
      const button = fab(page)
      await expect(button).toBeVisible()
      // Its number is the pinned chip's (and the red pill's) — one date facet.
      const chipCount = ((await pinned(page).getAttribute('aria-label')) ?? '').match(/\d+/)
      expect(chipCount).not.toBeNull()
      await expect(button).toHaveAttribute('aria-label', new RegExp(`^${chipCount![0]} overdue — `))
      // Icon only: the count lives in the label, not on the button face.
      await expect(button).toHaveText('')
      // The list starts below the panels — there is somewhere to jump to.
      expect(await firstGroupTop(page)).toBeGreaterThan(LANDING_Y + 100)

      await countScrollRequests(page)
      await button.click()
      await expect(pinned(page)).toHaveAttribute('aria-pressed', 'true')
      await expectLandedUnderTopBar(page)
      await expectLitThenCleared(page, button)

      // Stacked ABOVE the snooze FAB, sharing its right edge, clear of its badge.
      const jumpBox = (await button.boundingBox())!
      const snoozeBox = (await page.locator('[data-snooze-all-fab]').boundingBox())!
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

  test.describe('desktop', () => {
    // At `xl` the panels move beside the list, so the list alone has to make
    // the page tall enough for the first group to reach the landing spot.
    test.beforeEach(async ({ authenticatedPage: page }) => {
      const startOfToday = DateTime.now().setZone(TEST_TZ).startOf('day')
      for (let i = 12; i < 30; i++) {
        taskIds.push(
          await post(page, '/api/tasks', {
            title: uniqueTitle(`Jump row ${i}`),
            project_id: projectIds[0],
            due_at: startOfToday.toUTC().toISO(),
          }),
        )
      }
      await page.reload()
      await expect(firstGroup(page)).toBeVisible()
    })

    /** The snooze FAB sits 24px (`right-6 bottom-6`) in from the viewport's
     *  bottom-right corner, and the jump button stacks on it as on the phone:
     *  same right edge, 12px above. The right edge is measured from
     *  `<body>`'s, which stops short of the scrollbar gutter `html` always
     *  reserves (`scrollbar-gutter: stable`, globals.css). */
    async function expectPinnedToViewportCorner(page: Page) {
      const width = await page.evaluate(() => document.body.getBoundingClientRect().right)
      const snooze = (await page.locator('[data-snooze-all-fab]').boundingBox())!
      expect(snooze.y + snooze.height).toBeCloseTo(page.viewportSize()!.height - 24, 0)
      expect(snooze.x + snooze.width).toBeCloseTo(width - 24, 0)
      const box = (await deskFab(page).boundingBox())!
      expect(box.x + box.width).toBeCloseTo(width - 24, 0)
      expect(snooze.y - (box.y + box.height)).toBeCloseTo(12, 0)
    }

    // `xl` is 90.625rem (1450px, globals.css), so 1280 is still one column.
    for (const { name, width, height } of [
      { name: 'xl, two columns', width: 1500, height: 900 },
      { name: '1280, single column', width: 1280, height: 800 },
      { name: 'md, single column', width: 900, height: 800 },
    ]) {
      test.describe(name, () => {
        test.use({ viewport: { width, height } })

        test('stays in the viewport corner while scrolling, jumps, then hides', async ({
          authenticatedPage: page,
        }) => {
          const button = deskFab(page)
          await expect(button).toBeVisible()
          await expect(fab(page)).toBeHidden()
          const chipCount = ((await pinned(page).getAttribute('aria-label')) ?? '').match(/\d+/)
          expect(chipCount).not.toBeNull()
          await expect(button).toHaveAttribute(
            'aria-label',
            new RegExp(`^${chipCount![0]} overdue — `),
          )
          await expectPinnedToViewportCorner(page)

          // Slightly see-through, so a Quotas row they float over still shows.
          await expect(button).toHaveCSS('opacity', '0.9')
          await expect(page.locator('[data-snooze-all-fab]')).toHaveCSS('opacity', '0.9')

          // Halfway down a long list it is still there, in the same corner.
          await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight / 2))
          await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(200)
          await expectPinnedToViewportCorner(page)

          await countScrollRequests(page)
          await button.click()
          await expect(pinned(page)).toHaveAttribute('aria-pressed', 'true')
          await expectLandedUnderTopBar(page)
          await expectLitThenCleared(page, button)
        })

        // The toaster is bottom-center and 356px wide: it never reaches the
        // corner, so a toast leaves the button where it is.
        test('a toast leaves it where it is', async ({ authenticatedPage: page }) => {
          const button = deskFab(page)
          await expect(button).toBeVisible()
          await page.getByRole('button', { name: /^Mark ".*Jump row 5.*" as done$/ }).click()
          const toast = page.locator('[data-sonner-toast]').first()
          await expect(toast).toBeVisible()
          const t = (await toast.boundingBox())!
          expect((await button.boundingBox())!.x).toBeGreaterThan(t.x + t.width)
          await expectPinnedToViewportCorner(page)
        })
      })
    }
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
