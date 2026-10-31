/**
 * The dashboard modes (`src/lib/modes/`, `src/components/modes/`): Today |
 * Scan | All, on with the lean row. CI builds the card default, so this file
 * turns the lean row on per device before each page load; every other spec
 * keeps the dashboard as it was.
 *
 * Covers: the switch (Today by default, remembered, `?mode=`), the project
 * chips above Filters narrowing every mode, Today's one section (over
 * target, later today and the deadline net, by time, with their tints) and
 * its compact On deck rows, Scan's sections ("Show 5 more" / "Show less",
 * sticky headings, counts only where a section claims), the sort pill
 * (re-orders, remembered, "Sort every section"), All (the list, no folds),
 * and the phone layout (the pill clear of the tab bar and the FABs).
 *
 * Each test's tasks are in a project of its own, picked with its chip, so
 * the shared E2E database's other tasks never land in the sections looked
 * at. The task-queue switch is on for the file (decks need it).
 */
import { DateTime } from 'luxon'
import { test, expect, backdateCreated, openTaskDay, uniqueTitle } from './fixtures'
import type { Locator, Page } from '@playwright/test'

const HOUR = 60 * 60 * 1000
const TZ = process.env.E2E_TZ || 'America/Chicago'

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ request, page }) => {
  const res = await request.post('/api/test/task-queue', { data: { enabled: true } })
  expect(res.ok()).toBeTruthy()
  // Lean rows (and with them the modes) on this device; a fresh mode and sort.
  await page.addInitScript(() => {
    window.localStorage.setItem('opentask_task_rows', 'lean')
  })
})
test.afterAll(async ({ request }) => {
  await request.post('/api/test/task-queue', { data: { enabled: false } })
})

const projects = new Map<string, { id: number; name: string }>()
async function projectFor(page: Page): Promise<{ id: number; name: string }> {
  const key = test.info().testId
  const known = projects.get(key)
  if (known) return known
  const name = uniqueTitle('MD')
  const res = await page.request.post('/api/projects', { data: { name } })
  expect(res.ok()).toBeTruthy()
  const project = { id: (await res.json()).data.id as number, name }
  projects.set(key, project)
  return project
}

async function create(page: Page, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', {
    data: { project_id: (await projectFor(page)).id, enrich: false, ...data },
  })
  expect(res.ok(), `create ${JSON.stringify(data)}`).toBeTruthy()
  return (await res.json()).data.id as number
}

async function cleanUp(page: Page, ids: number[]) {
  if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
  const project = projects.get(test.info().testId)
  if (project) {
    await page.request.delete(`/api/projects/${project.id}`)
    projects.delete(test.info().testId)
  }
}

/** The dashboard in `mode`, narrowed to the test's project by its chip. */
async function open(page: Page, mode: 'today' | 'pick-mode' | 'all') {
  await page.goto(`/?mode=${mode}`)
  const { id } = await projectFor(page)
  const chip = page.locator(`[data-project-row] [data-project-chip="${id}"]`)
  await expect(chip).toBeVisible()
  await chip.click()
  await expect(page.locator('[data-lean-row]').first()).toBeVisible()
}

const section = (page: Page, id: string): Locator =>
  page.locator(`section[data-mode-section="${id}"]`)
const rowIn = (scope: Locator, id: number): Locator => scope.locator(`[data-lean-row="${id}"]`)
const idsIn = (scope: Locator) =>
  scope
    .locator('[data-lean-row]')
    .evaluateAll((rows) => rows.map((r) => Number(r.getAttribute('data-lean-row'))))

/** A moment later today, before the OpenTask day ends, whatever the hour. */
async function laterToday(page: Page): Promise<Date> {
  const { rollover_time } = (await (await page.request.get('/api/user/preferences')).json())
    .data as { rollover_time: string }
  const dayEnd = DateTime.fromISO(`${await openTaskDay(page, 1)}T${rollover_time}`, { zone: TZ })
  return new Date(Math.min(Date.now() + 40 * 60 * 1000, dayEnd.toMillis() - 2 * 60 * 1000))
}

test.describe('Dashboard modes · where the sections sit', () => {
  // Trent, 2026-10-29: on a phone "Reminders, task queue, minimized Quotas,
  // then the task list" — main's order; the sections are the task list.
  test('phone: the side column (Reminders, task queue, Quotas) first, then the sections', async ({
    authenticatedPage: page,
  }) => {
    // A Days row, so the task queue's card has a segment to show (an empty
    // segment is hidden since 2026-10-30, and with none the card is too).
    const ids = [await create(page, { title: uniqueTitle('MD side'), horizon: 'days' })]
    backdateCreated(ids, { inSegments: true })
    try {
      await page.setViewportSize({ width: 375, height: 812 })
      await page.goto('/?mode=today')
      // The side column: Reminders and Quotas when there are any today (this
      // user has neither), and the task queue's Tasks card.
      const side = page.locator('[data-dashboard-side]')
      const section = page.locator('section[data-mode-section]').first()
      await expect(side.getByRole('region', { name: 'Tasks' })).toBeVisible()
      await expect(section).toBeVisible()
      const box = async (l: typeof section) => (await l.boundingBox())!
      expect((await box(side)).y + (await box(side)).height).toBeLessThanOrEqual(
        (await box(section)).y,
      )
    } finally {
      await cleanUp(page, ids)
    }
  })
})

test.describe('Dashboard modes · the switch', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('Today by default; Scan and All; remembered on the device; ?mode= opens one', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/')
    const switcher = page.locator('[data-mode-switch]')
    await expect(switcher.getByRole('button')).toHaveText(['Today', 'Scan', 'All'])
    await expect(switcher.locator('[data-mode="today"]')).toHaveAttribute('aria-pressed', 'true')
    // No Now / Newest toggle and no "N of M now" outside All.
    await expect(page.getByRole('group', { name: 'View mode' })).toHaveCount(0)

    await switcher.locator('[data-mode="pick-mode"]').click()
    await expect(switcher.locator('[data-mode="pick-mode"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await page.reload()
    await expect(page.locator('[data-mode="pick-mode"]')).toHaveAttribute('aria-pressed', 'true')

    // All: the list as it was — its own view toggle, no sort, no sections.
    await page.locator('[data-mode="all"]').click()
    await expect(page.getByRole('group', { name: 'View mode' })).toBeVisible()
    await expect(page.locator('[data-sort-button]')).toHaveCount(0)
    await expect(page.locator('section[data-mode-section]')).toHaveCount(0)

    await page.goto('/?mode=today')
    await expect(page.locator('[data-mode="today"]')).toHaveAttribute('aria-pressed', 'true')
  })
})

test.describe('Dashboard modes · Today', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('one section by time: over target, later today, the deadline net — with their tints; decks in compact rows', async ({
    authenticatedPage: page,
  }) => {
    const now = Date.now()
    const deadlineTomorrow = DateTime.fromISO(`${await openTaskDay(page, 1)}T17:00`, { zone: TZ })
    const ids = {
      net: await create(page, {
        title: uniqueTitle('MD net'),
        deadline_at: deadlineTomorrow.toUTC().toISO(),
      }),
      soon: await create(page, {
        title: uniqueTitle('MD soon'),
        due_at: (await laterToday(page)).toISOString(),
      }),
      over: await create(page, {
        title: uniqueTitle('MD over'),
        due_at: new Date(now - 2 * HOUR).toISOString(),
      }),
      future: await create(page, {
        title: uniqueTitle('MD next week'),
        due_at: new Date(now + 7 * 24 * HOUR).toISOString(),
      }),
      deck: await create(page, {
        title: uniqueTitle('MD deck'),
        priority: 3,
        horizon: 'months',
        labels: ['ai-failed'],
        deadline_at: DateTime.fromISO(`${await openTaskDay(page, 3)}T17:00`, { zone: TZ })
          .toUTC()
          .toISO(),
      }),
    }
    try {
      const deck = await page.request.patch(`/api/tasks/${ids.deck}`, {
        data: { on_deck_day: await openTaskDay(page) },
      })
      expect(deck.ok(), await deck.text()).toBeTruthy()
      await open(page, 'today')

      // ONE section, by time — the target, else the deadline: past first.
      const today = section(page, 'today')
      await expect(today.locator('[data-section-heading]')).toContainText('Today')
      expect(await idsIn(today)).toEqual([ids.over, ids.soon, ids.net])
      await expect(today.locator('[data-section-count]')).toHaveText('3')
      // Next week's target isn't today's.
      await expect(page.locator(`[data-lean-row="${ids.future}"]`)).toHaveCount(0)
      // The tints: over target blue, later today the faint blue.
      await expect(rowIn(today, ids.over)).toHaveAttribute('data-row-state', 'over')
      await expect(rowIn(today, ids.soon)).toHaveAttribute('data-row-state', 'soon')

      // On deck: the compact row.
      const decks = section(page, 'on-deck')
      const d = rowIn(decks, ids.deck)
      await expect(d).toHaveAttribute('data-compact-row', '')
      // The done square shows the horizon it set (a deadline task too,
      // Trent 2026-10-29); the lit deck icon.
      await expect(d.locator('[data-lean-done]')).toHaveAttribute('data-horizon-square', 'months')
      await expect(d.locator('[data-on-deck-active]')).toBeVisible()
      // "!", the deadline's DAY (no time), the grey project name.
      await expect(d.locator('[data-priority-tab]')).toHaveText('!')
      await expect(d.locator('[data-compact-deadline]')).toHaveText(/^[A-Z][a-z]+( night)?$/)
      await expect(d.locator('[data-compact-project]')).toHaveText((await projectFor(page)).name)
      // Never on a compact row: labels, the created date, the meta line.
      await expect(d.locator('[data-label-badges]')).toHaveCount(0)
      await expect(d.locator('[data-created]')).toHaveCount(0)
      await expect(d.locator('[data-lean-meta]')).toHaveCount(0)
      // One line.
      const box = (await d.locator('[data-lean-title]').boundingBox())!
      expect(box.height).toBeLessThan(30)

      // A double-click opens the details, as on every row.
      await d.locator('[data-lean-title]').dblclick()
      await expect(page.getByRole('dialog')).toBeVisible()
      await page.keyboard.press('Escape')
    } finally {
      await cleanUp(page, Object.values(ids))
    }
  })
})

test.describe('Dashboard modes · Scan', () => {
  test.use({ viewport: { width: 1280, height: 600 } })

  test('sections in order; "Show 5 more" / "Show less"; sticky headings; counts only where a section claims', async ({
    authenticatedPage: page,
  }) => {
    const ids: number[] = []
    try {
      for (let i = 0; i < 7; i++) {
        ids.push(await create(page, { title: uniqueTitle(`MD weeks ${i}`), horizon: 'weeks' }))
      }
      const soon = await create(page, {
        title: uniqueTitle('MD coming'),
        deadline_at: new Date(Date.now() + 30 * HOUR).toISOString(),
      })
      ids.push(soon)
      await open(page, 'pick-mode')

      const order = await page
        .locator('section[data-mode-section]')
        .evaluateAll((s) => s.map((e) => e.getAttribute('data-mode-section')))
      expect(order).toEqual(['newest', 'coming-up', 'horizon-weeks'])
      // Counts: Coming up claims its rows; Newest and the horizon lists don't.
      await expect(section(page, 'coming-up').locator('[data-section-count]')).toHaveText('1')
      await expect(section(page, 'newest').locator('[data-section-count]')).toHaveCount(0)
      await expect(section(page, 'horizon-weeks').locator('[data-section-count]')).toHaveCount(0)

      // Five, then "Show 2 more", then "Show less".
      const weeks = section(page, 'horizon-weeks')
      await expect(weeks.locator('[data-lean-row]')).toHaveCount(5)
      await weeks.getByRole('button', { name: 'Show 2 more' }).click()
      await expect(weeks.locator('[data-lean-row]')).toHaveCount(7)
      await weeks.getByRole('button', { name: 'Show less' }).click()
      await expect(weeks.locator('[data-lean-row]')).toHaveCount(5)

      // Sticky: scrolled past its top, the heading stays under the top bar.
      const heading = section(page, 'newest').locator('[data-section-heading]')
      await expect(heading).toHaveCSS('position', 'sticky')
      // The section's third row at the top of the window: its heading and
      // first rows are above it, its last rows still below.
      const third = section(page, 'newest').locator('[data-lean-row]').nth(2)
      await third.evaluate((el) => el.scrollIntoView({ block: 'start' }))
      const sectionTop = (await section(page, 'newest').boundingBox())!.y
      const headingTop = (await heading.boundingBox())!.y
      expect(sectionTop).toBeLessThan(0)
      expect(headingTop).toBeGreaterThan(50)
      expect(headingTop).toBeLessThan(75)
    } finally {
      await cleanUp(page, ids)
    }
  })
})

test.describe('Dashboard modes · the sort pill', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('re-orders the category sections, not Newest; remembered; "Sort every section" does Newest too', async ({
    authenticatedPage: page,
  }) => {
    const low = await create(page, { title: uniqueTitle('MD low'), horizon: 'weeks', priority: 1 })
    const high = await create(page, {
      title: uniqueTitle('MD high'),
      horizon: 'weeks',
      priority: 4,
    })
    try {
      await open(page, 'pick-mode')
      // The dock's ⇅ (P2, 2026-10-30): the sort is its label.
      const pill = page.locator('[data-sort-button]')
      await expect(pill).toHaveAttribute('aria-label', /Sort: Newest/)
      // Newest first by default (high was made last).
      expect(await idsIn(section(page, 'horizon-weeks'))).toEqual([high, low])

      await pill.click()
      await page.locator('[data-sort-option="oldest"]').click()
      await expect(pill).toHaveAttribute('aria-label', /Sort: Oldest/)
      expect(await idsIn(section(page, 'horizon-weeks'))).toEqual([low, high])
      // Newest keeps its own order.
      expect(await idsIn(section(page, 'newest'))).toEqual([high, low])

      await page.reload()
      await page
        .locator(`[data-project-row] [data-project-chip="${(await projectFor(page)).id}"]`)
        .click()
      await expect(page.locator('[data-sort-button]')).toHaveAttribute('aria-label', /Sort: Oldest/)
      expect(await idsIn(section(page, 'horizon-weeks'))).toEqual([low, high])

      await page.locator('[data-sort-button]').click()
      await page.locator('[data-sort-everywhere]').click()
      await expect.poll(() => idsIn(section(page, 'newest'))).toEqual([low, high])
    } finally {
      await cleanUp(page, [low, high])
    }
  })
})

test.describe('Dashboard modes · project chips and All', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('the chips sit above Filters and narrow every mode; All lists every row, never folded or capped', async ({
    authenticatedPage: page,
  }) => {
    const mine = await create(page, {
      title: uniqueTitle('MD mine'),
      due_at: new Date(Date.now() - HOUR).toISOString(),
    })
    // More than a project group's preview (6 by default) holds.
    const more: number[] = []
    for (let i = 0; i < 9; i++)
      more.push(await create(page, { title: uniqueTitle(`MD many ${i}`) }))
    try {
      await page.goto('/?mode=today')
      // Above the Filters row, shown without opening it.
      const chips = page.locator('[data-project-row]')
      await expect(chips).toBeVisible()
      const filters = page.getByRole('button', { name: /Filters/ }).first()
      expect((await chips.boundingBox())!.y).toBeLessThan((await filters.boundingBox())!.y)
      // Narrowed to the project, Today shows its row only.
      await chips.locator(`[data-project-chip="${(await projectFor(page)).id}"]`).click()
      await expect(page.locator('[data-lean-row]')).toHaveCount(1)
      await expect(page.locator(`[data-lean-row="${mine}"]`)).toBeVisible()

      // All: every task — no Now folds, no On deck section, no group capped
      // ("Show all N"), in both of its views.
      await page.locator('[data-mode="all"]').click()
      // The view is a SERVER preference (`default_grouping`): end on Now,
      // and put it back below whatever happens, for the specs after this one.
      for (const view of ['Newest', 'Now']) {
        await page
          .getByRole('group', { name: 'View mode' })
          .getByRole('button', { name: view })
          .click()
        await expect(page.locator('[data-lean-row]')).toHaveCount(10)
        await expect(page.locator(`[data-lean-row="${mine}"]`)).toBeVisible()
        await expect(page.getByRole('button', { name: /^Show all \d+/ })).toHaveCount(0)
        await expect(page.locator('[data-now-fold]')).toHaveCount(0)
        await expect(page.locator('[data-deck-section]')).toHaveCount(0)
      }
    } finally {
      await page.request.patch('/api/user/preferences', { data: { default_grouping: 'project' } })
      await cleanUp(page, [mine, ...more])
    }
  })
})

for (const width of [375, 402]) {
  test.describe(`Dashboard modes · phone ${width}`, () => {
    test.use({ viewport: { width, height: 812 }, hasTouch: true, isMobile: true })

    test('the dock (P2): switch and sort fit, clear of the tab bar and the FABs, at 100% and 119% text', async ({
      authenticatedPage: page,
    }) => {
      const id = await create(page, { title: uniqueTitle('MD phone'), horizon: 'weeks' })
      try {
        await open(page, 'pick-mode')
        for (const root of ['16px', '19.04px']) {
          await page.evaluate((size) => (document.documentElement.style.fontSize = size), root)
          const dock = (await page.locator('[data-mode-dock]').boundingBox())!
          expect(dock.x, root).toBeGreaterThanOrEqual(0)
          expect(dock.x + dock.width, root).toBeLessThanOrEqual(width)
          await expect(page.locator('[data-mode-dock] [data-sort-button]')).toBeVisible()
          const tabs = (await page.locator('nav.fixed').boundingBox())!
          expect(dock.y + dock.height, root).toBeLessThanOrEqual(tabs.y)
          const fabs = (await page.locator('[data-fab-stack]').boundingBox())!
          const overlaps =
            dock.x < fabs.x + fabs.width &&
            dock.x + dock.width > fabs.x &&
            dock.y < fabs.y + fabs.height &&
            dock.y + dock.height > fabs.y
          expect(overlaps, `${root}: the dock and the FAB column`).toBe(false)
        }
        // The sort menu keeps the 16px gutter from both edges (2026-10-30).
        await page.locator('[data-sort-button]').click()
        const menu = page.getByRole('menu')
        await expect(menu).toBeVisible()
        const m = (await menu.boundingBox())!
        expect(m.x).toBeGreaterThanOrEqual(16)
        expect(m.x + m.width).toBeLessThanOrEqual(width - 16)
        await page.keyboard.press('Escape')
        // The page never scrolls sideways.
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          width,
        )
      } finally {
        await cleanUp(page, [id])
      }
    })
  })
}

test.describe('Today · Late, then Today', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  // Trent, 2026-10-29 (O3): a passed DEADLINE is Late, above Today, under its
  // own heading; over target alone stays in Today.
  test('a passed deadline is Late, above Today; over target alone is Today', async ({
    authenticatedPage: page,
  }) => {
    const now = Date.now()
    const ids = {
      late: await create(page, {
        title: uniqueTitle('MD late'),
        deadline_at: new Date(now - 3 * HOUR).toISOString(),
      }),
      over: await create(page, {
        title: uniqueTitle('MD over'),
        due_at: new Date(now - 2 * HOUR).toISOString(),
      }),
    }
    try {
      await open(page, 'today')
      const late = section(page, 'late')
      await expect(late.locator('[data-section-heading]')).toContainText('Late')
      expect(await idsIn(late)).toEqual([ids.late])
      expect(await idsIn(section(page, 'today'))).toEqual([ids.over])
      // Late sits above Today.
      const order = await page
        .locator('section[data-mode-section]')
        .evaluateAll((s) => s.map((e) => e.getAttribute('data-mode-section')))
      expect(order.indexOf('late')).toBeLessThan(order.indexOf('today'))
    } finally {
      await cleanUp(page, Object.values(ids))
    }
  })
})

test.describe('Scan · plain squares, the horizon dot', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  // Trent, 2026-10-29: "fully consistent checkboxes everywhere" — the square
  // is plain in the Horizon sections too; the horizon is the meta line's dot,
  // unset drawn as the Weeks dot.
  test('every square in Scan is plain, the Horizon sections included; each one-off wears its dot', async ({
    authenticatedPage: page,
  }) => {
    const made = {
      weeks: await create(page, { title: uniqueTitle('MD hz weeks'), horizon: 'weeks' }),
      months: await create(page, { title: uniqueTitle('MD hz months'), horizon: 'months' }),
      unset: await create(page, { title: uniqueTitle('MD hz unset') }),
    }
    try {
      await open(page, 'pick-mode')
      for (const [id, task] of [
        ['horizon-weeks', made.weeks],
        ['horizon-months', made.months],
        ['horizon-unset', made.unset],
        ['newest', made.months],
      ] as const) {
        const r = rowIn(section(page, id), task)
        await expect(r.locator('[data-lean-done] [data-horizon-border]')).toHaveCount(0)
        await expect(r.locator('[data-lean-meta] [data-horizon-dot]')).toHaveCount(1)
        // Scan's age step (GS2, 2026-10-29): made today, so the Today step,
        // the page itself — on the row's swipe foreground.
        await expect(r.locator('xpath=..')).toHaveAttribute('data-age-step', 'today')
      }
      const r = (id: string, task: number) =>
        rowIn(section(page, id), task).locator('[data-lean-meta] [data-horizon-dot] circle')
      expect(await r('horizon-unset', made.unset).getAttribute('r')).toBe(
        await r('horizon-weeks', made.weeks).getAttribute('r'),
      )
      expect(await r('horizon-unset', made.unset).getAttribute('fill')).toBe('currentColor')
    } finally {
      await cleanUp(page, Object.values(made))
    }
  })
})
