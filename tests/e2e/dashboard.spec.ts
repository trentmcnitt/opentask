import { test, expect, waitForPreferenceSave, waitForPrefsLoaded } from './fixtures'
import type { Page } from '@playwright/test'
import { DateTime } from 'luxon'

/**
 * The seeded test user's timezone — slot assignment is done in local time.
 * Must track `globalSetup.ts`'s `E2E_TZ` override (default America/Chicago):
 * "today" is the app's today in the user's zone, so a time built in any other
 * zone lands on the wrong side of midnight whenever the two disagree.
 */
const TEST_TZ = process.env.E2E_TZ || 'America/Chicago'

const filtersToggle = (page: Page) => page.getByRole('button', { name: /^Filters/ })

/**
 * Load the dashboard with the filter section open, and prove the page has
 * APPLIED the server's preferences before anything is clicked.
 *
 * `filters_expanded` is a server preference, and `PreferencesProvider` writes
 * the loaded value over its local state on mount. A click that beat that load
 * was undone by it — the chips closed again, while the click's PATCH had
 * already saved the opposite value for the next test to inherit (the filter
 * badge and chip pill tests, flaky until 2026-09-25).
 *
 * Open is the NON-default value (local state starts `false`), so the toggle
 * reading `aria-expanded="true"` can only be the load's doing: that assertion
 * is the proof, not a timing guess. A test that needs the section closed
 * closes it by hand afterwards, with no load left in flight to undo it.
 */
async function loadWithFiltersOpen(page: Page): Promise<void> {
  const written = await page.request.patch('/api/user/preferences', {
    data: { filters_expanded: true },
  })
  expect(written.ok()).toBeTruthy()
  await waitForPrefsLoaded(page, () => page.reload(), filtersToggle(page))
  await expect(filtersToggle(page)).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('#dashboard-filter-chips')).toBeVisible()
}

/**
 * Click the filter toggle and wait for the PATCH that saves it, so no test
 * ends with a keepalive save still in flight for the next one to race.
 */
async function clickFiltersToggle(page: Page): Promise<void> {
  const saved = waitForPreferenceSave(page, 'filters_expanded')
  await filtersToggle(page).click()
  await saved
}

test.describe('Dashboard', () => {
  test('tasks are displayed on the dashboard', async ({ authenticatedPage: page }) => {
    // Should see task titles from seed
    await expect(page.getByText('Buy groceries')).toBeVisible({ timeout: 5000 })
    await expect(page.getByText('Morning routine')).toBeVisible()
  })

  test('the nav carries the top bar\u2019s overdue and today numbers', async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const bar = page.getByRole('group', { name: 'Task counts' })
    await expect(bar).toBeVisible()
    const nav = page.locator('aside [data-tasks-badge]')
    await expect(nav).toBeVisible()
    // The bar shows total, overdue (if any), today (if any); the nav shows the
    // last two. Same numbers, same order.
    const barPills = (await bar.innerText()).trim().split(/\s+/)
    const navPills = (await nav.innerText()).trim().split(/\s+/)
    expect(navPills.length).toBeGreaterThan(0)
    expect(barPills.slice(-navPills.length)).toEqual(navPills)

    // And it is there on a page that never loads the task list.
    await page.getByRole('link', { name: 'Reminders' }).click()
    await page.waitForURL('/reminders')
    await expect(page.locator('aside [data-tasks-badge]')).toHaveText(navPills.join(''))
  })
})

/**
 * §7.3 — one-offs that never had a date are not "today". They sit last under
 * "Undated", folded, so the day reads as a day; adding one from the quick-add
 * opens the group so the new task doesn't vanish under the user's finger.
 */
test.describe('Undated pile', () => {
  test('sits last, folded, and a newly added undated task opens it', async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const res = await page.request.post('/api/tasks', {
      data: { title: 'A thought with no date yet' },
    })
    expect(res.ok()).toBeTruthy()
    const ids = [(await res.json()).data.id as number]
    // The view toggle persists server-side for the shared test user, so the
    // view this test finds is put back at the end for the specs that follow.
    const views = ['Today', 'Projects', 'All'] as const
    const pressedView = async () => {
      for (const v of views) {
        const b = page.getByRole('button', { name: v, exact: true })
        if ((await b.getAttribute('aria-pressed')) === 'true') return v
      }
      return null
    }
    const switchTo = async (v: (typeof views)[number]) => {
      const saved = waitForPreferenceSave(page, 'default_grouping')
      await page.getByRole('button', { name: v, exact: true }).click()
      await saved
    }
    await page.reload()
    await expect(page.getByRole('button', { name: 'Today', exact: true })).toBeVisible()
    const before = await pressedView()
    try {
      if (before !== 'Today') await switchTo('Today')

      const fold = page.getByRole('button', { name: 'Expand Undated' })
      await expect(fold).toBeVisible()
      await expect(page.getByText('A thought with no date yet')).toHaveCount(0)
      await fold.click()
      await expect(page.getByText('A thought with no date yet')).toBeVisible()

      await page.getByRole('button', { name: 'Collapse Undated' }).click()
      await expect(page.getByText('A thought with no date yet')).toHaveCount(0)
      await page.getByRole('textbox', { name: 'Quick add task' }).fill('Another dateless thought')
      await page.keyboard.press('Enter')
      await expect(page.getByText('Another dateless thought')).toBeVisible()
      await expect(page.getByText('A thought with no date yet')).toBeVisible()

      const list = (await (await page.request.get('/api/tasks?limit=500')).json()).data.tasks
      const other = list.find((t: { title: string }) => t.title === 'Another dateless thought')
      if (other) ids.push(other.id)
    } finally {
      if (before && before !== 'Today') await switchTo(before)
      for (const id of ids) await page.request.delete(`/api/tasks/${id}`)
    }
  })
})

/**
 * REDESIGN-V03 §7.3 — the filter chips collapse behind one control so the front
 * door shows tasks, not a wall of chips. The collapse rules themselves are
 * documented in src/hooks/useFilterSection.ts.
 */
test.describe('Dashboard filter section', () => {
  const toggle = filtersToggle

  test('filter chips are collapsed by default and open in one click', async ({
    authenticatedPage: page,
  }) => {
    // ESTABLISH THE PRECONDITION RATHER THAN INHERIT IT. `filters_expanded` is
    // a server preference on the one user every spec in the run shares, so
    // "collapsed by default" is only true here if nothing earlier in the run
    // pinned it open — which made this test a hostage to file ordering, and it
    // duly broke the first time a new spec sorted ahead of it.
    //
    // Every click below lands after a load the page has provably applied (see
    // `loadWithFiltersOpen`): starting from "open" is what makes the load
    // observable, since closed is also the pre-load default.
    await loadWithFiltersOpen(page)
    const chips = page.locator('#dashboard-filter-chips')

    // Closed by hand: client and server now both hold `false`.
    await clickFiltersToggle(page)
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false')
    await expect(chips).toHaveCount(0)

    // One click opens it.
    await clickFiltersToggle(page)
    await expect(chips).toBeVisible()
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true')
    // The chips the section hides are really there once opened
    await expect(chips.getByText('Overdue', { exact: false }).first()).toBeVisible()

    // ...and close again
    await clickFiltersToggle(page)
    await expect(chips).toHaveCount(0)

    // Collapsed by default: a fresh load with the preference off stays shut.
    await waitForPrefsLoaded(page, () => page.reload(), toggle(page))
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false')
    await expect(chips).toHaveCount(0)
  })

  test('applying a filter shows a count badge on the collapsed control', async ({
    authenticatedPage: page,
  }) => {
    await loadWithFiltersOpen(page)
    const chips = page.locator('#dashboard-filter-chips')
    await chips.getByText('Overdue', { exact: false }).first().click()

    // Filter applied: the list is narrowed and the control carries the count
    await expect(page.getByText(/Showing \d+ of \d+ tasks/)).toBeVisible()
    await expect(toggle(page)).toContainText('1')

    // Collapsing by hand keeps the active filter legible via the badge
    await clickFiltersToggle(page)
    await expect(page.locator('#dashboard-filter-chips')).toHaveCount(0)
    await expect(toggle(page)).toContainText('1')
  })

  test('clearing every filter drops the badge and lets the section stay closed', async ({
    authenticatedPage: page,
  }) => {
    await loadWithFiltersOpen(page)
    const chips = page.locator('#dashboard-filter-chips')
    await chips.getByText('Overdue', { exact: false }).first().click()
    await expect(toggle(page)).toContainText('1')

    await page.getByRole('button', { name: 'Clear filter' }).click()

    await expect(page.getByText(/Showing \d+ of \d+ tasks/)).toHaveCount(0)
    await expect(toggle(page)).toHaveText('Filters')
    // Auto-expand released, so the toggle is free to close again
    await clickFiltersToggle(page)
    await expect(page.locator('#dashboard-filter-chips')).toHaveCount(0)
  })
})

/**
 * `?task=<id>` has two shapes sharing one URL (Trent, 2026-09-22): the
 * widget's deep link adds `&highlight=1` and brings the row into view without
 * opening it (mirrors `/reminders?reminder=<id>`); the bare param — a
 * notification tap or Web Push — still opens QuickActionPanel, unchanged.
 * See `DashboardClient.tsx`'s `?task=` effect.
 */
test.describe('?task=<id> deep link', () => {
  async function createTask(page: Page, body: Record<string, unknown>): Promise<number> {
    const res = await page.request.post('/api/tasks', { data: body })
    expect(res.ok()).toBeTruthy()
    return (await res.json()).data.id as number
  }

  async function deleteTasks(page: Page, ids: number[]): Promise<void> {
    for (const id of ids) await page.request.delete(`/api/tasks/${id}`)
  }

  // ESTABLISH THE PRECONDITION RATHER THAN INHERIT IT — see the filter
  // section tests above: `default_grouping` is a server preference on the one
  // test user every spec in the run shares, so "a Today/Overdue/Undated group
  // exists to find the row in" is only true here if nothing earlier in the
  // run left it on Projects/Unified. Restored in `finally`.
  async function withGrouping(
    page: Page,
    grouping: 'time' | 'slot',
    run: () => Promise<void>,
  ): Promise<void> {
    const before = (await (await page.request.get('/api/user/preferences')).json()).data
      .default_grouping as string
    const written = await page.request.patch('/api/user/preferences', {
      data: { default_grouping: grouping },
    })
    expect(written.ok()).toBeTruthy()
    try {
      await run()
    } finally {
      await page.request.patch('/api/user/preferences', { data: { default_grouping: before } })
    }
  }
  const withTimeGrouping = (page: Page, run: () => Promise<void>) => withGrouping(page, 'time', run)

  test('&highlight=1 brings the row into view; the bare param still opens the editor', async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const ids: number[] = []
    await withTimeGrouping(page, async () => {
      try {
        const id = await createTask(page, {
          title: 'A task the widget links to',
          due_at: new Date(Date.now() + 3600_000).toISOString(),
        })
        ids.push(id)

        // The widget's link: brought on screen and flashed once; nothing opens.
        await page.goto(`/?task=${id}&highlight=1`)
        const row = page.locator(`#task-row-${id}`)
        await expect(row).toHaveAttribute('data-task-highlight', '')
        await expect(row).toBeInViewport()
        await expect(page.getByRole('dialog')).toHaveCount(0)
        // The param is spent, so a reload does not flash the same row again.
        await expect(page).toHaveURL('/')

        // The bare shape (notification tap / Web Push): editor still opens.
        await page.goto(`/?task=${id}`)
        await expect(page.getByRole('dialog')).toBeVisible()
        await expect(page).toHaveURL('/')
      } finally {
        await deleteTasks(page, ids)
      }
    })
  })

  test('&highlight=1 opens a collapsed group to reach the row (Undated)', async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const ids: number[] = []
    await withTimeGrouping(page, async () => {
      try {
        const id = await createTask(page, { title: 'An undated task the widget links to' })
        ids.push(id)

        await page.goto(`/?task=${id}&highlight=1`)
        const row = page.locator(`#task-row-${id}`)
        await expect(row).toHaveAttribute('data-task-highlight', '')
        await expect(row).toBeInViewport()
        await expect(page.getByRole('dialog')).toHaveCount(0)
      } finally {
        await deleteTasks(page, ids)
      }
    })
  })

  /**
   * `grouping === 'slot'` — Trent's own default view (Today's tasks by time
   * of day) — has a SECOND cap `&highlight=1` has to clear that `time`
   * grouping doesn't: each slot only shows its first `GROUP_PREVIEW_COUNT`
   * (5) tasks, expanded via a "Show all" button that lives entirely in
   * `TaskList`'s own local state. A row past that cap is un-collapsed (the
   * slot itself is open) but still not rendered, so a highlight that only
   * cleared `isCollapsed` would resolve to nothing on screen. Caught live by
   * browser-verifying against Trent's real dev account, which defaults to
   * this grouping — the earlier `time`-grouping tests above cannot exercise
   * this cap because `time` groups are never preview-capped.
   */
  test('&highlight=1 opens the "Show all" preview cap on a slot-grouped view', async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const ids: number[] = []
    await withGrouping(page, 'slot', async () => {
      try {
        // Six in the same slot: GROUP_PREVIEW_COUNT (5) shows only the first
        // five, so the sixth — staggered latest, sorts last by due date — is
        // the one past the cap.
        const base = DateTime.now().setZone(TEST_TZ).set({ hour: 13, minute: 0, second: 0 })
        for (let i = 0; i < 6; i++) {
          ids.push(
            await createTask(page, {
              title: `Widget-linked slot task ${i}`,
              due_at: base.plus({ minutes: i }).toUTC().toISO(),
            }),
          )
        }
        const target = ids[5]

        await page.goto(`/?task=${target}&highlight=1`)
        const row = page.locator(`#task-row-${target}`)
        await expect(row).toHaveAttribute('data-task-highlight', '')
        await expect(row).toBeInViewport()
        await expect(page.getByRole('dialog')).toHaveCount(0)
      } finally {
        await deleteTasks(page, ids)
      }
    })
  })
})

/**
 * Faceted filter counts (Trent 2026-09-23): a filter row's chips must count
 * over every OTHER active filter group, not the whole corpus — otherwise the
 * "Work" project filter active still shows "Today N" even though Work has
 * nothing due today. See `applyTaskFilters` (src/hooks/useFilterState.ts) and
 * its behavioral test (tests/behavioral/filter-facets.test.ts) for the pure
 * logic; this reproduces the same scenario end-to-end.
 */
test.describe('Dashboard filter facets', () => {
  async function createTask(page: Page, body: Record<string, unknown>): Promise<number> {
    const res = await page.request.post('/api/tasks', { data: body })
    expect(res.ok()).toBeTruthy()
    return (await res.json()).data.id as number
  }

  async function deleteTasks(page: Page, ids: number[]): Promise<void> {
    for (const id of ids) await page.request.delete(`/api/tasks/${id}`)
  }

  test("a project filter narrows the Today chip's count to that project", async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const ids: number[] = []
    const todayAt = (hour: number) =>
      DateTime.now()
        .setZone(TEST_TZ)
        .set({ hour, minute: 0, second: 0, millisecond: 0 })
        .toUTC()
        .toISO()!

    await loadWithFiltersOpen(page)
    const chips = page.locator('#dashboard-filter-chips')
    const todayChip = chips.locator('[data-date-chip="today"]')
    const workChip = chips.locator('[data-project-chip="3"]')
    // A chip whose facet count is 0 (and isn't itself selected/excluded)
    // doesn't render at all — correct faceting (see DueDateFilterBar), and
    // exactly what should happen to the Today chip once Work is selected if
    // Work has nothing due today. Treat "not present" as a count of 0 rather
    // than waiting for an element that may legitimately never appear.
    const countOf = async (chip: typeof todayChip) => {
      if ((await chip.count()) === 0) return 0
      const text = (await chip.innerText()).trim()
      // The chip's own total is the FIRST number (label, then total, then
      // optionally a due-today/overdue pill — feat/chip-due-badges) — not the
      // last, now that a chip with something due today or overdue renders
      // trailing pill numbers after its total.
      const match = text.match(/(\d+)/)
      return match ? Number(match[1]) : NaN
    }

    // "Clear filter" (not re-clicking the chip) restores the unfiltered
    // state below: the chip's own interaction model treats two clicks within
    // 300ms as a double-click (toggles EXCLUDE, not deselect — see
    // useChipInteraction.ts), which a select-then-immediately-deselect from
    // a test can trip.
    const clearFilter = page.getByRole('button', { name: 'Clear filter' })

    // Read baselines first rather than assume a pristine corpus — the seed
    // deliberately includes an overdue-and-due-today task (globalSetup.ts's
    // "Reply to email", in Inbox) so this test stays correct however the
    // seed evolves, rather than hardcoding "today = 3".
    await expect(todayChip).toBeVisible()
    const baselineToday = await countOf(todayChip)
    await expect(workChip).toBeVisible()
    await workChip.click() // select Work exclusively, facet Today over it
    const baselineWorkToday = await countOf(todayChip)
    await clearFilter.click() // back to unfiltered

    try {
      // Project 1 = Inbox, 3 = Work (scripts/seed-test.ts / globalSetup.ts).
      // Two due-today in Inbox, one due-today in Work.
      ids.push(
        await createTask(page, {
          title: 'Facet test — Inbox today A',
          project_id: 1,
          due_at: todayAt(23),
        }),
      )
      ids.push(
        await createTask(page, {
          title: 'Facet test — Inbox today B',
          project_id: 1,
          due_at: todayAt(22),
        }),
      )
      ids.push(
        await createTask(page, {
          title: 'Facet test — Work today',
          project_id: 3,
          due_at: todayAt(21),
        }),
      )

      await loadWithFiltersOpen(page)

      // Unfiltered: baseline plus all 3 newly created "today" tasks.
      await expect.poll(() => countOf(todayChip)).toBe(baselineToday + 3)

      // Select the Work project chip — the Today row must now facet over
      // "everything else applies, dateFilters skipped", i.e. Work only.
      await expect(workChip).toBeVisible()
      await workChip.click()

      await expect.poll(() => countOf(todayChip)).toBe(baselineWorkToday + 1)

      // Clearing the project filter restores the corpus-wide count.
      await clearFilter.click()
      await expect.poll(() => countOf(todayChip)).toBe(baselineToday + 3)
    } finally {
      await deleteTasks(page, ids)
    }
  })

  /**
   * feat/chip-due-badges (Trent 2026-09-23): the teal completion fill behind
   * these chips is gone, replaced by two little pills after the total — a
   * soft indigo "due later today" pill and a solid red "overdue" pill.
   */
  test('project and Today chips show due-today/overdue pills with faceted counts', async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const ids: number[] = []

    // Both tasks must still be "today" when the chips are read, in the user's
    // own zone: one due between now and midnight, one overdue since midnight.
    // A fixed ±10 minutes broke at both ends of the day — "later today" was
    // tomorrow after 23:50, and "overdue today" was yesterday before 00:10.
    // Each is pinned inside today instead: halfway to midnight (at most 10
    // minutes out), and no earlier than midnight. In the last two minutes of
    // the day there is no "later today" left that outlasts the test itself,
    // so it skips rather than assert on a day that ends mid-run.
    const now = DateTime.now().setZone(TEST_TZ)
    const tomorrowStart = now.startOf('day').plus({ days: 1 })
    const leftToday = tomorrowStart.diff(now)
    test.skip(leftToday.as('minutes') < 2, 'under two minutes of today left')
    const dueLaterToday = DateTime.min(
      now.plus({ minutes: 10 }),
      now.plus({ milliseconds: leftToday.as('milliseconds') / 2 }),
    )
    const overdueToday = DateTime.max(now.startOf('day'), now.minus({ minutes: 10 }))

    await loadWithFiltersOpen(page)
    const chips = page.locator('#dashboard-filter-chips')
    const workChip = chips.locator('[data-project-chip="3"]')
    const todayChip = chips.locator('[data-date-chip="today"]')

    // Pill attributes carry the count as their value (like `data-project-chip`
    // carries the project id) — absent entirely when that count is 0.
    const pillCount = async (chip: typeof workChip, attr: string) => {
      const pill = chip.locator(`[${attr}]`)
      if ((await pill.count()) === 0) return 0
      return Number(await pill.getAttribute(attr))
    }

    await expect(workChip).toBeVisible()
    const baselineWorkDueToday = await pillCount(workChip, 'data-chip-due-today')
    const baselineWorkOverdue = await pillCount(workChip, 'data-chip-overdue')
    const baselineTodayOverdue = await pillCount(todayChip, 'data-chip-overdue')

    try {
      // Project 3 = Work (scripts/seed-test.ts / globalSetup.ts).
      ids.push(
        await createTask(page, {
          title: 'Chip badge test — Work due later today',
          project_id: 3,
          due_at: dueLaterToday.toUTC().toISO(),
        }),
      )
      ids.push(
        await createTask(page, {
          title: 'Chip badge test — Work overdue today',
          project_id: 3,
          due_at: overdueToday.toUTC().toISO(),
        }),
      )

      await loadWithFiltersOpen(page)

      await expect(workChip).toBeVisible()
      await expect
        .poll(() => pillCount(workChip, 'data-chip-due-today'))
        .toBe(baselineWorkDueToday + 1)
      await expect
        .poll(() => pillCount(workChip, 'data-chip-overdue'))
        .toBe(baselineWorkOverdue + 1)
      // Spelled out for screen readers, not just carried by color.
      await expect(workChip).toHaveAttribute('aria-label', /due today/)
      await expect(workChip).toHaveAttribute('aria-label', /overdue/)

      // The Today chip's own total already means "due today" — it gets the
      // overdue pill (this task is both) but never a due-today pill.
      await expect
        .poll(() => pillCount(todayChip, 'data-chip-overdue'))
        .toBe(baselineTodayOverdue + 1)
      await expect(todayChip.locator('[data-chip-due-today]')).toHaveCount(0)
    } finally {
      await deleteTasks(page, ids)
    }
  })
})

/**
 * `/?project=<id>` — the widget's dashboard-header deep link (native side
 * built separately, ios/CLAUDE.md). Applies the project filter exclusively
 * and scrolls to top; consumes the param. See `DashboardClient.tsx`'s
 * `?project=` effect.
 */
test.describe('?project=<id> deep link', () => {
  test('applies the project filter exclusively and scrolls to top', async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    // Project 3 = Work (scripts/seed-test.ts / globalSetup.ts). Seeded task 5
    // ("Review PRs") is in Work; seeded task 1 ("Buy groceries") is in Inbox.
    await page.goto('/?project=3')

    await expect(page.getByText('Review PRs')).toBeVisible({ timeout: 5000 })
    await expect(page.getByText('Buy groceries')).toHaveCount(0)

    // The param is consumed.
    await expect(page).toHaveURL('/')

    // The scroll effect fires — the page lands at (or animates smoothly to) the top.
    await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 2000 }).toBe(0)
  })
})

/**
 * The top bar's "N total tasks" pill counts the list on screen. In the Today
 * view (`grouping === 'slot'`) that list stops at the end of today, so a task
 * due next week is not on it and must not be in the number — it used to be,
 * because the pill read the filtered corpus instead of the rendered groups.
 * See `shownTaskCount` in `DashboardClient.tsx`.
 */
test.describe('Top bar total', () => {
  async function createTask(page: Page, body: Record<string, unknown>): Promise<number> {
    const res = await page.request.post('/api/tasks', { data: body })
    expect(res.ok()).toBeTruthy()
    return (await res.json()).data.id as number
  }

  /** The number in the pill's popover ("N total tasks"), then shut it again. */
  async function readTotal(page: Page): Promise<number> {
    const counts = page.getByRole('group', { name: 'Task counts' })
    await counts.click()
    const line = page.getByText(/^\d+ total tasks$/)
    await expect(line).toBeVisible()
    const n = parseInt((await line.innerText()).trim(), 10)
    await page.keyboard.press('Escape')
    await expect(line).toHaveCount(0)
    return n
  }

  async function setGrouping(page: Page, grouping: string): Promise<void> {
    const res = await page.request.patch('/api/user/preferences', {
      data: { default_grouping: grouping },
    })
    expect(res.ok()).toBeTruthy()
  }

  /**
   * Reload into a view and wait until the page is IN it. Until the
   * preferences fetch settles the dashboard groups by the `'project'`
   * fallback (see `useDefaultGrouping`), and a count read in that window is
   * the Projects view's, not the one asked for.
   */
  async function reloadInto(page: Page, view: 'Today' | 'All'): Promise<void> {
    await page.reload()
    await expect(page.getByRole('button', { name: view, exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  }

  test('counts only what the Today view shows', async ({ authenticatedPage: page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const before = (await (await page.request.get('/api/user/preferences')).json()).data
      .default_grouping as string
    const ids: number[] = []
    try {
      await setGrouping(page, 'slot')
      await reloadInto(page, 'Today')
      const baseline = await readTotal(page)

      // Due a week out: in the corpus, not on today's list.
      const later = await createTask(page, {
        title: 'Top bar probe next week',
        due_at: DateTime.now()
          .setZone(TEST_TZ)
          .plus({ days: 7 })
          .set({ hour: 12, minute: 0 })
          .toUTC()
          .toISO(),
      })
      ids.push(later)
      // Undated: the Today view keeps these, so this one does count.
      ids.push(await createTask(page, { title: 'Top bar probe undated' }))

      await reloadInto(page, 'Today')
      await expect(page.locator(`#task-row-${later}`)).toHaveCount(0)
      expect(await readTotal(page)).toBe(baseline + 1)

      // The All view shows the whole corpus, so the week-out task counts there.
      await setGrouping(page, 'time')
      // (Its row may sit in a folded group, so only the number is asserted.)
      await reloadInto(page, 'All')
      expect(await readTotal(page)).toBeGreaterThanOrEqual(baseline + 2)
    } finally {
      for (const id of ids) await page.request.delete(`/api/tasks/${id}`)
      await setGrouping(page, before)
    }
  })
})
