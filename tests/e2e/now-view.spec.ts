/**
 * The dashboard's Now view (2026-10-14, mockup E1; Trent: "drop the separate
 * Today view"). The view switch is Now · Newest. Now groups by project and
 * shows only what is relevant now — over target, targeted today, in today's
 * Upcoming heads-up, undated High/Urgent — with each project's rest behind a
 * "+ N more in <Project>" fold that opens in place and shuts with "Show
 * fewer". "N of M now · Show all M" beside the switch lifts every fold.
 * The rule itself is pinned in tests/behavioral/dv-now-view.test.ts.
 *
 * Isolation: two projects of the spec's own, sorted first, with tasks made
 * here (backdated, so the Just now card doesn't repeat their titles) and
 * removed in `finally`. `default_grouping` is set with `withPreferences`.
 * The fold state lives in sessionStorage, which each test's fresh browser
 * context starts empty.
 *
 * Every flow runs at phone (375x812) and desktop (1280x800), light and dark.
 */
import {
  test,
  expect,
  backdateCreated,
  cmdClickRow,
  uniqueTitle,
  waitForPrefsLoaded,
  withPreferences,
} from './fixtures'
import type { Page } from '@playwright/test'
import { DateTime } from 'luxon'

const row = (page: Page, id: number) => page.locator(`#task-row-${id}`)

interface Fixture {
  tag: string
  busy: string
  quiet: string
  /** Busy project: relevant now. */
  overdue: number
  urgent: number
  /** Busy project: behind the fold. */
  later: number
  lows: number[]
  /** Quiet project: all behind the fold. */
  quietTasks: number[]
}

async function create(page: Page, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data })
  expect(res.ok(), `create ${JSON.stringify(data)}`).toBeTruthy()
  return (await res.json()).data.id as number
}

async function withNowFixture(page: Page, run: (f: Fixture) => Promise<void>) {
  const tag = uniqueTitle('Nowv').replace(/\s+/g, '')
  const busy = `${tag} busy`
  const quiet = `${tag} quiet`
  const projectIds: number[] = []
  const taskIds: number[] = []
  try {
    for (const [name, sort_order] of [
      [busy, -20],
      [quiet, -19],
    ] as const) {
      const res = await page.request.post('/api/projects', { data: { name, sort_order } })
      expect(res.ok()).toBeTruthy()
      projectIds.push((await res.json()).data.id as number)
    }
    const [busyId, quietId] = projectIds
    const overdue = await create(page, {
      title: `${tag} overdue`,
      project_id: busyId,
      due_at: DateTime.now().minus({ days: 1 }).toUTC().toISO(),
    })
    const urgent = await create(page, { title: `${tag} urgent`, project_id: busyId, priority: 4 })
    // Ten days out, picked today: its heads-ups are 3 days and 1 day before.
    const later = await create(page, {
      title: `${tag} later`,
      project_id: busyId,
      due_at: DateTime.now().plus({ days: 10 }).toUTC().toISO(),
    })
    const lows: number[] = []
    for (const i of [1, 2]) {
      lows.push(await create(page, { title: `${tag} low ${i}`, project_id: busyId, priority: 1 }))
    }
    const quietTasks: number[] = []
    for (const i of [1, 2, 3]) {
      quietTasks.push(await create(page, { title: `${tag} someday ${i}`, project_id: quietId }))
    }
    taskIds.push(overdue, urgent, later, ...lows, ...quietTasks)
    backdateCreated(taskIds)
    await withPreferences(page, { default_grouping: 'project' }, () =>
      run({ tag, busy, quiet, overdue, urgent, later, lows, quietTasks }),
    )
  } finally {
    for (const id of taskIds) await page.request.delete(`/api/tasks/${id}`)
    for (const id of projectIds) await page.request.delete(`/api/projects/${id}`)
  }
}

async function openDashboard(page: Page, f: Fixture) {
  await waitForPrefsLoaded(
    page,
    () => page.goto('/'),
    page.getByRole('button', { name: `Collapse ${f.busy}`, exact: true }),
  )
}

const VARIANTS = [
  { name: 'phone light', viewport: { width: 375, height: 812 }, colorScheme: 'light' },
  { name: 'phone dark', viewport: { width: 375, height: 812 }, colorScheme: 'dark' },
  { name: 'desktop light', viewport: { width: 1280, height: 800 }, colorScheme: 'light' },
  { name: 'desktop dark', viewport: { width: 1280, height: 800 }, colorScheme: 'dark' },
] as const

for (const variant of VARIANTS) {
  test.describe(`Now view — ${variant.name}`, () => {
    test.use({ viewport: variant.viewport, colorScheme: variant.colorScheme })

    test('the switch is Now · Newest, and Now is the project view', async ({
      authenticatedPage: page,
    }) => {
      await withNowFixture(page, async (f) => {
        await openDashboard(page, f)
        const views = page.getByRole('group', { name: 'View mode' })
        await expect(views.getByRole('button')).toHaveText(['Now', 'Newest'])
        await expect(views.getByRole('button', { name: 'Now', pressed: true })).toBeVisible()
        await expect(views.getByRole('button', { name: 'Today' })).toHaveCount(0)
      })
    })

    test('a project shows its relevant rows and folds the rest; the fold opens in place', async ({
      authenticatedPage: page,
    }) => {
      await withNowFixture(page, async (f) => {
        await openDashboard(page, f)
        await expect(row(page, f.overdue)).toBeVisible()
        await expect(row(page, f.urgent)).toBeVisible()
        for (const id of [f.later, ...f.lows]) await expect(row(page, id)).toHaveCount(0)
        // The heading counts relevant of open: "2 of 5".
        await expect(
          page.getByRole('button', { name: `Collapse ${f.busy}`, exact: true }).locator('..'),
        ).toContainText('2 of 5')

        const fold = page.getByRole('button', { name: `3 more in ${f.busy}` })
        await expect(fold).toBeVisible()
        await expect(fold).not.toContainText('nothing due')
        await fold.click()
        for (const id of [f.later, ...f.lows]) await expect(row(page, id)).toBeVisible()
        const fewer = page
          .locator('section[data-task-group]', { has: row(page, f.overdue) })
          .getByRole('button', { name: 'Show fewer' })
        await expect(fewer).toBeVisible()

        // The open fold lasts the session: a reload keeps it open.
        await openDashboard(page, f)
        await expect(row(page, f.later)).toBeVisible()
        await fewer.click()
        for (const id of [f.later, ...f.lows]) await expect(row(page, id)).toHaveCount(0)
        await expect(fold).toBeVisible()
      })
    })

    test('a project with nothing relevant is just its fold row, "nothing due"', async ({
      authenticatedPage: page,
    }) => {
      await withNowFixture(page, async (f) => {
        await openDashboard(page, f)
        await expect(
          page.getByRole('button', { name: `Collapse ${f.quiet}`, exact: true }),
        ).toBeVisible()
        for (const id of f.quietTasks) await expect(row(page, id)).toHaveCount(0)
        const fold = page.getByRole('button', { name: `3 more in ${f.quiet} · nothing due` })
        await expect(fold).toBeVisible()
        await fold.click()
        for (const id of f.quietTasks) await expect(row(page, id)).toBeVisible()
      })
    })

    test('Show all lifts every fold until toggled back', async ({ authenticatedPage: page }) => {
      await withNowFixture(page, async (f) => {
        await openDashboard(page, f)
        const summary = page.locator('[data-now-summary]')
        await expect(summary).toContainText(/\d+ of \d+ now/)
        await summary.getByRole('button', { name: /^Show all \d+$/ }).click()
        for (const id of [f.overdue, f.urgent, f.later, ...f.lows, ...f.quietTasks]) {
          await expect(row(page, id)).toBeVisible()
        }
        await expect(page.getByRole('button', { name: `3 more in ${f.busy}` })).toHaveCount(0)
        await expect(summary).toContainText(/^All \d+/)

        await summary.getByRole('button', { name: /^Show \d+ now$/ }).click()
        await expect(row(page, f.later)).toHaveCount(0)
        await expect(row(page, f.overdue)).toBeVisible()
        await expect(page.getByRole('button', { name: `3 more in ${f.busy}` })).toBeVisible()
      })
    })

    test('a search finds a row behind a fold', async ({ authenticatedPage: page }) => {
      await withNowFixture(page, async (f) => {
        await openDashboard(page, f)
        await expect(row(page, f.later)).toHaveCount(0)
        const search = page.getByRole('textbox', { name: 'Search tasks' })
        if (!(await search.isVisible())) {
          await page.getByRole('button', { name: 'Search', exact: true }).click()
        }
        await search.fill(`${f.tag} later`)
        await search.press('Enter')
        await expect(row(page, f.later)).toBeVisible()
        // The folds are off while the list is narrowed, and so is the strip.
        await expect(page.locator('[data-now-summary]')).toHaveCount(0)
      })
    })
  })
}

test.describe('Now view — selection across the fold', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('rows behind an open fold select like any row; shutting it deselects them', async ({
    authenticatedPage: page,
  }) => {
    await withNowFixture(page, async (f) => {
      await openDashboard(page, f)
      await page.getByRole('button', { name: `3 more in ${f.busy}` }).click()
      await cmdClickRow(row(page, f.later))
      await cmdClickRow(row(page, f.overdue))
      await expect(row(page, f.overdue)).toHaveAttribute('aria-selected', 'true')
      await expect(row(page, f.later)).toHaveAttribute('aria-selected', 'true')

      // Shift-click from the overdue row (the range's anchor: the row last
      // clicked) to the project's last row on screen selects the range as
      // drawn: the relevant rows, then the fold's rows.
      const busyRows = page
        .locator('section[data-task-group]', { has: row(page, f.overdue) })
        .locator('[role="option"]')
      await expect(busyRows).toHaveCount(5)
      await busyRows.last().click({ modifiers: ['Shift'], position: { x: 56, y: 10 } })
      for (const id of [f.overdue, f.urgent, f.later, ...f.lows]) {
        await expect(row(page, id)).toHaveAttribute('aria-selected', 'true')
      }

      await page
        .locator('section[data-task-group]', { has: row(page, f.overdue) })
        .getByRole('button', { name: 'Show fewer' })
        .click()
      await expect(row(page, f.overdue)).toHaveAttribute('aria-selected', 'true')
      await expect(row(page, f.urgent)).toHaveAttribute('aria-selected', 'true')
      await page.getByRole('button', { name: `3 more in ${f.busy}` }).click()
      for (const id of [f.later, ...f.lows]) {
        await expect(row(page, id)).not.toHaveAttribute('aria-selected', 'true')
      }
    })
  })

  test('arrow keys skip the rows behind a shut fold', async ({ authenticatedPage: page }) => {
    await withNowFixture(page, async (f) => {
      await openDashboard(page, f)
      const folded = [f.later, ...f.lows]
      const foldedFocused = page.locator(folded.map((id) => `#task-row-${id}:focus`).join(', '))
      // A plain click on desktop puts keyboard focus on the row.
      const focusRow = async (id: number) => {
        const target = row(page, id)
        const box = await target.boundingBox()
        if (!box) throw new Error('row not on screen')
        await target.click({ position: { x: 56, y: box.height - 6 } })
      }
      // The busy project's relevant rows are overdue, then urgent (the
      // horizon sort puts over target first). Down from urgent passes the
      // shut fold.
      await focusRow(f.urgent)
      await page.keyboard.press('ArrowDown')
      await expect(row(page, f.urgent)).not.toBeFocused()
      await expect(foldedFocused).toHaveCount(0)

      // Open, its rows are next.
      await page.getByRole('button', { name: `3 more in ${f.busy}` }).click()
      await focusRow(f.urgent)
      await page.keyboard.press('ArrowDown')
      await expect(foldedFocused).toHaveCount(1)
    })
  })
})
