/**
 * The task row's corner and target time (2026-10-14, `src/lib/row-corner.ts`):
 *
 * - the priority tab (E2b): Urgent red, High orange; Medium, Low and None
 *   show nothing (2026-10-15), and the old priority word under the title is gone;
 * - the horizon dot (R1): a size per horizon, a hollow ring when unset, a
 *   tooltip saying when it comes back, hidden on a row with a picked target;
 *   the corner reads dot · attempts · priority;
 * - the target time's menu (Remove target / Move… — a deadline task's too
 *   since 2026-10-22, "Back to auto" gone) and the desktop hover ×, each
 *   with Undo;
 * - the deadline chip at the start of the row's second line (2026-10-22);
 * - the action bar's More sheet: Remove target for the whole selection;
 * - the segment rows' dot (it replaced the chevron) and its menu, with Undo;
 * - the hover Today and the dot's menu on the DASHBOARD rows (the dashboard
 *   passes `onTargetAt` / `onSetHorizon` to its TaskList), checked on rows
 *   inside an open Now fold.
 *
 * At 1280×800 and 375×812, in light and dark. Screenshots go to `.tmp/`.
 * Isolation: every task is made here under a unique title and trashed after.
 */
import { DateTime } from 'luxon'
import { test, expect, backdateCreated, cmdClickRow, holdUntil, uniqueTitle } from './fixtures'
import type { Locator, Page } from '@playwright/test'

const DAY = 24 * 60 * 60 * 1000
const SHOTS = '.tmp/row-corner'

/**
 * Each test's tasks go in a project of their own, so its group holds them all.
 * The dashboard's Now view folds a project's rows that aren't relevant now
 * behind "+ N more in <Project>"; `gotoDashboard` opens that fold, so every
 * row of the test is on screen (most of them from inside the open fold).
 */
const projects = new Map<string, { id: number; name: string }>()
async function projectFor(page: Page): Promise<number> {
  const key = test.info().testId
  const known = projects.get(key)
  if (known !== undefined) return known.id
  const name = uniqueTitle('RC')
  const res = await page.request.post('/api/projects', { data: { name } })
  expect(res.ok()).toBeTruthy()
  const id = (await res.json()).data.id as number
  projects.set(key, { id, name })
  return id
}

/** The test's project group on the dashboard. */
function projectGroup(page: Page): Locator {
  const project = projects.get(test.info().testId)!
  return page.locator('section[data-task-group]', {
    has: page.getByRole('button', { name: `Collapse ${project.name}`, exact: true }),
  })
}

/** Load the dashboard and open the test's project fold, if it has one. */
async function gotoDashboard(page: Page) {
  await page.goto('/')
  const group = projectGroup(page)
  await expect(group).toBeVisible()
  const shut = group.locator('[data-now-fold="shut"]')
  if ((await shut.count()) > 0) await shut.click()
  await expect(shut).toHaveCount(0)
}

async function create(page: Page, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', {
    data: { project_id: await projectFor(page), ...data },
  })
  expect(res.ok(), `create ${JSON.stringify(data)}`).toBeTruthy()
  return (await res.json()).data.id as number
}

async function stateOf(page: Page, id: number): Promise<Record<string, unknown>> {
  const res = await page.request.get(`/api/tasks/${id}`)
  return (await res.json()).data as Record<string, unknown>
}

async function trash(page: Page, ids: number[]) {
  if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
  const key = test.info().testId
  const project = projects.get(key)
  if (project !== undefined) {
    await page.request.delete(`/api/projects/${project.id}`)
    projects.delete(key)
  }
}

const taskRow = (page: Page, id: number) => page.locator(`#task-row-${id}`)

/** Tomorrow at 10:00 local — a picked target well ahead of now. */
function tomorrowAt10(): string {
  const tz = process.env.E2E_TZ || 'America/Chicago'
  return DateTime.now().setZone(tz).plus({ days: 1 }).set({ hour: 10, minute: 0 }).toUTC().toISO()!
}

/** Undo on the newest matching toast (Sonner's front one, `data-index` 0). */
async function undoFromToast(page: Page, text: string | RegExp) {
  const toast = page.locator('[data-sonner-toast]', { hasText: text }).first()
  await expect(toast).toBeVisible()
  await toast.getByRole('button', { name: 'Undo' }).click()
  // Off the toasts, so the stack folds back down instead of staying fanned
  // out over the rows near the bottom of the screen.
  await page.mouse.move(0, 0)
}

/** A row's target time, scrolled to the middle of the screen (clear of the toasts). */
async function timeOf(page: Page, id: number): Promise<Locator> {
  await taskRow(page, id).evaluate((el) => el.scrollIntoView({ block: 'center' }))
  return taskRow(page, id).locator('[data-target-time]')
}

async function themes(page: Page, run: (theme: 'light' | 'dark') => Promise<void>) {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*dark)/)
    await run(theme)
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

/** A Tailwind palette colour as the browser computes it (`--color-<name>`). */
async function cssColor(page: Page, name: string): Promise<string> {
  return page.evaluate((n) => {
    const probe = document.createElement('div')
    probe.style.backgroundColor = `var(--color-${n})`
    document.body.appendChild(probe)
    const value = getComputedStyle(probe).backgroundColor
    probe.remove()
    return value
  }, name)
}

async function rgb(el: Locator, prop: 'backgroundColor' | 'color'): Promise<string> {
  return el.evaluate((node, p) => getComputedStyle(node)[p], prop)
}

test.describe('Row corner · desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('priority tab: Urgent red, High orange; Medium, Low and None nothing', async ({
    authenticatedPage: page,
  }) => {
    const ids: Record<number, number> = {}
    for (const p of [0, 1, 2, 3, 4]) {
      ids[p] = await create(page, { title: uniqueTitle(`RC prio ${p}`), priority: p })
    }
    try {
      await gotoDashboard(page)
      for (const p of [0, 1, 2, 3, 4]) await expect(taskRow(page, ids[p])).toBeVisible()
      await themes(page, async (theme) => {
        const tab = (p: number) => taskRow(page, ids[p]).locator('[data-priority-tab]')
        await expect(tab(0)).toHaveCount(0)
        await expect(tab(1)).toHaveCount(0)
        await expect(tab(2)).toHaveCount(0)
        await expect(tab(3)).toHaveText('High')
        await expect(tab(4)).toHaveText('Urgent')
        // Accessible names.
        await expect(
          taskRow(page, ids[3]).getByRole('img', { name: 'High priority' }),
        ).toBeVisible()
        await expect(
          taskRow(page, ids[4]).getByRole('img', { name: 'Urgent priority' }),
        ).toBeVisible()
        // Solid fills in the app's priority hues (Tailwind 500s), both themes.
        expect(await rgb(tab(3), 'backgroundColor')).toBe(await cssColor(page, 'orange-500'))
        expect(await rgb(tab(4), 'backgroundColor')).toBe(await cssColor(page, 'red-500'))
        // The tab sits flush in the top-right corner of the row.
        const rowBox = (await taskRow(page, ids[4]).boundingBox())!
        const tabBox = (await tab(4).boundingBox())!
        expect(Math.round(rowBox.x + rowBox.width - (tabBox.x + tabBox.width))).toBe(0)
        expect(Math.round(tabBox.y - rowBox.y)).toBe(0)
        // The old word under the title is gone (the tab replaced it).
        await expect(taskRow(page, ids[3]).getByText('High', { exact: true })).toHaveCount(1)
        await taskRow(page, ids[4]).screenshot({
          path: `${SHOTS}/priority-urgent-desktop-${theme}.png`,
        })
        await taskRow(page, ids[2]).screenshot({
          path: `${SHOTS}/priority-medium-desktop-${theme}.png`,
        })
      })
    } finally {
      await trash(page, Object.values(ids))
    }
  })

  test('horizon dot: a size per horizon, a closed ring when unset, tooltip, hidden on a picked target', async ({
    authenticatedPage: page,
  }) => {
    const horizons = ['days', 'weeks', 'months', 'eventually', null] as const
    const ids = new Map<string, number>()
    for (const h of horizons) {
      ids.set(String(h), await create(page, { title: uniqueTitle(`RC dot ${h}`), horizon: h }))
    }
    const targeted = await create(page, {
      title: uniqueTitle('RC dot targeted'),
      horizon: 'weeks',
      target_at: tomorrowAt10(),
    })
    try {
      await gotoDashboard(page)
      const dot = (h: string) => taskRow(page, ids.get(h)!).locator('[data-horizon-dot]')
      await expect(dot('days')).toHaveAttribute('data-horizon-dot', 'days')
      const radius = async (h: string) => Number(await dot(h).locator('circle').getAttribute('r'))
      // Days 8px, Weeks 6px, Months 5px, Eventually smallest (diameters).
      expect(await radius('days')).toBe(4)
      expect(await radius('weeks')).toBe(3)
      expect(await radius('months')).toBe(2.5)
      expect(await radius('eventually')).toBeLessThan(2.5)
      const opacity = async (h: string) =>
        Number(await dot(h).locator('circle').getAttribute('opacity'))
      expect(await opacity('eventually')).toBeLessThan(await opacity('months'))
      expect(await opacity('eventually')).toBeGreaterThanOrEqual(0.4)
      // Unset: a CLOSED hollow ring the Weeks dot's size (2026-10-28; it was
      // dashed, and broke up at 1x) — r 2.5 + a 1px stroke = 6px, no dashes.
      await expect(dot('null')).toHaveAttribute('data-horizon-dot', 'unset')
      const ring = dot('null').locator('circle')
      await expect(ring).not.toHaveAttribute('stroke-dasharray')
      await expect(ring).toHaveAttribute('fill', 'none')
      await expect(ring).toHaveAttribute('stroke-width', '1')
      expect(await radius('null')).toBe(2.5)
      // Quieter than any set dot (2026-10-28): it reads as "nothing set".
      expect(await opacity('null')).toBeLessThan(await opacity('eventually'))
      // Tooltips (the test user's check-in day is the default, Saturday).
      await expect(dot('weeks')).toHaveAttribute('title', 'Weeks · comes back Saturdays')
      await expect(dot('days')).toHaveAttribute('title', 'Days · comes back daily')
      await expect(dot('eventually')).toHaveAttribute('title', 'Eventually · comes back quarterly')
      await expect(dot('null')).toHaveAttribute(
        'title',
        'Unset (counts as Weeks) · comes back Saturdays',
      )
      // A picked target: the horizon decides nothing until it is removed.
      await expect(taskRow(page, targeted)).toBeVisible()
      await expect(taskRow(page, targeted).locator('[data-horizon-dot]')).toHaveCount(0)

      await themes(page, async (theme) => {
        for (const h of ['days', 'weeks', 'months', 'eventually', 'null']) {
          await taskRow(page, ids.get(h)!)
            .locator('[data-row-corner]')
            .screenshot({ path: `${SHOTS}/dot-${h}-1x-${theme}.png` })
        }
      })
    } finally {
      await trash(page, [...ids.values(), targeted])
    }
  })

  test('the corner reads dot · attempts · priority', async ({ authenticatedPage: page }) => {
    // A deadline an hour ago: its automatic target is the deadline itself,
    // so it is over target at once — one attempt, whatever the time of day.
    const id = await create(page, {
      title: uniqueTitle('RC order'),
      priority: 3,
      horizon: 'months',
      deadline_at: new Date(Date.now() - DAY / 24).toISOString(),
    })
    try {
      await gotoDashboard(page)
      const corner = taskRow(page, id).locator('[data-row-corner]')
      await expect(corner.locator('[data-attempts]')).toHaveText('1×')
      const order = await corner.evaluate((el) =>
        [...el.children].map((c) =>
          c.hasAttribute('data-horizon-dot')
            ? 'dot'
            : c.hasAttribute('data-attempts')
              ? 'attempts'
              : c.hasAttribute('data-priority-tab')
                ? 'priority'
                : 'other',
        ),
      )
      expect(order).toEqual(['dot', 'attempts', 'priority'])
      await themes(page, async (theme) => {
        await taskRow(page, id).screenshot({ path: `${SHOTS}/order-desktop-${theme}.png` })
      })
    } finally {
      await trash(page, [id])
    }
  })

  // The focus ring (a click focuses a row) is ONE ring (2026-10-28, Trent):
  // drawn on the row it sat under the corner tabs, which broke it at the
  // top-right. It is an overlay above them now.
  test('a focused row’s ring is drawn above the corner, unbroken', async ({
    authenticatedPage: page,
  }) => {
    const id = await create(page, {
      title: uniqueTitle('RC focus ring'),
      priority: 3,
      horizon: 'weeks',
    })
    try {
      await gotoDashboard(page)
      const row = taskRow(page, id)
      await expect(row.locator('[data-row-corner] [data-horizon-dot]')).toBeVisible()
      await cmdClickRow(row)
      const ring = await row.evaluate((el) => {
        const after = getComputedStyle(el, '::after')
        const corner = el.querySelector('[data-row-corner]')!
        return {
          shadow: after.boxShadow,
          ringZ: Number(after.zIndex),
          cornerZ: Number(getComputedStyle(corner).zIndex),
          pointer: after.pointerEvents,
        }
      })
      expect(ring.shadow).toContain('inset')
      expect(ring.ringZ).toBeGreaterThan(ring.cornerZ)
      expect(ring.pointer).toBe('none')
      await themes(page, async (theme) => {
        await row.screenshot({ path: `${SHOTS}/focus-ring-${theme}.png` })
      })
    } finally {
      await trash(page, [id])
    }
  })
})

test.describe('Row corner · target time and segments', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('target time: Remove target with Undo (a deadline task too), Move…, and the hover ×', async ({
    authenticatedPage: page,
  }) => {
    const plain = await create(page, {
      title: uniqueTitle('RC time plain'),
      target_at: tomorrowAt10(),
    })
    const withDeadline = await create(page, {
      title: uniqueTitle('RC time deadline'),
      target_at: tomorrowAt10(),
      deadline_at: new Date(Date.now() + 10 * DAY).toISOString(),
    })
    const hover = await create(page, {
      title: uniqueTitle('RC time hover'),
      target_at: tomorrowAt10(),
    })
    const moved = await create(page, {
      title: uniqueTitle('RC time move'),
      target_at: tomorrowAt10(),
    })
    try {
      await gotoDashboard(page)
      // Remove target → no target; Undo puts it back.
      const before = (await stateOf(page, plain)).target_at
      await (await timeOf(page, plain)).click()
      await expect(page.getByRole('menuitem', { name: 'Move…' })).toBeVisible()
      await page.getByRole('menuitem', { name: 'Remove target' }).click()
      await expect.poll(async () => (await stateOf(page, plain)).target_at).toBeNull()
      // The row did not open the editor or select itself.
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await undoFromToast(page, /.+/)
      await expect.poll(async () => (await stateOf(page, plain)).target_at).toBe(before)

      // A deadline task: Remove target too, never "Back to auto" (2026-10-22).
      // (With the task queue off, as here, the server still keeps an
      // automatic target, A1; with it on the deadlines page holds the task.)
      await (await timeOf(page, withDeadline)).click()
      await expect(page.getByRole('menuitem', { name: 'Back to auto' })).toHaveCount(0)
      await page.getByRole('menuitem', { name: 'Remove target' }).click()
      await expect.poll(async () => (await stateOf(page, withDeadline)).target_auto).toBe(true)
      // Its row's second line opens with the deadline chip.
      const chip = taskRow(page, withDeadline).locator('[data-deadline-chip]')
      await expect(chip).toHaveAttribute('data-deadline-chip', 'ahead')
      await expect(chip).toHaveText(/^Deadline /)

      // The hover ×: invisible until the row is hovered; one click removes.
      const x = taskRow(page, hover).locator('[data-remove-target-x]')
      await timeOf(page, hover)
      await expect(x).toHaveCSS('opacity', '0')
      await taskRow(page, hover).hover()
      await expect(x).toHaveAttribute('title', 'Remove target')
      await expect(x).toHaveCSS('opacity', '1')
      await taskRow(page, hover).screenshot({ path: `${SHOTS}/time-hover-desktop.png` })
      await x.click()
      await expect.poll(async () => (await stateOf(page, hover)).target_at).toBeNull()
      await undoFromToast(page, /.+/)
      await expect.poll(async () => (await stateOf(page, hover)).target_at).not.toBeNull()

      // Move… → the Target menu, anchored on the time.
      await (await timeOf(page, moved)).click()
      await page.getByRole('menuitem', { name: 'Move…' }).click()
      const menu = page.getByRole('menu', { name: 'Target options' })
      await expect(menu).toBeVisible()
      await menu.getByRole('menuitem', { name: '2 hours' }).click()
      await expect
        .poll(async () => Date.parse((await stateOf(page, moved)).target_at as string))
        .toBeLessThan(Date.now() + 3 * 60 * 60 * 1000)
    } finally {
      await trash(page, [plain, withDeadline, hover, moved])
    }
  })

  test('More sheet: Remove target for the selection, one Undo', async ({
    authenticatedPage: page,
  }) => {
    const a = await create(page, {
      title: uniqueTitle('RC bulk a'),
      target_at: tomorrowAt10(),
      priority: 4,
    })
    const b = await create(page, {
      title: uniqueTitle('RC bulk b'),
      target_at: tomorrowAt10(),
      deadline_at: new Date(Date.now() + 10 * DAY).toISOString(),
    })
    const c = await create(page, { title: uniqueTitle('RC bulk none') })
    try {
      await gotoDashboard(page)
      for (const id of [a, b, c]) await cmdClickRow(taskRow(page, id))
      await page.getByRole('button', { name: 'More', exact: true }).click()
      const remove = page.locator('[data-bulk-remove-target]')
      // Two of the three have a picked target.
      await expect(remove).toHaveText('Remove target (2)')
      await page.screenshot({ path: `${SHOTS}/bulk-sheet-desktop.png`, animations: 'disabled' })
      await remove.click()
      await expect.poll(async () => (await stateOf(page, a)).target_at).toBeNull()
      await expect.poll(async () => (await stateOf(page, b)).target_auto).toBe(true)
      await undoFromToast(page, /.+/)
      await expect.poll(async () => (await stateOf(page, a)).target_at).not.toBeNull()
      await expect.poll(async () => (await stateOf(page, b)).target_auto).toBe(false)
    } finally {
      await trash(page, [a, b, c])
    }
  })

  test('segment rows: the dot replaced the chevron; its menu changes the horizon, Undo restores', async ({
    authenticatedPage: page,
  }) => {
    const id = await create(page, { title: uniqueTitle('RC seg dot'), horizon: 'days' })
    backdateCreated([id], { inSegments: true })
    try {
      await page.goto('/reminders')
      const row = page.locator('[data-task-segments]').locator(`[data-segment-task="${id}"]`)
      const dot = row.locator('[data-horizon-dot]')
      await expect(dot).toHaveAttribute('data-horizon-dot', 'days')
      await expect(row.locator('svg.lucide-chevron-down')).toHaveCount(0)
      // At least 32px to press with a mouse, without growing the row.
      const box = (await dot.boundingBox())!
      expect(box.width).toBeGreaterThanOrEqual(32)
      expect(box.height).toBeGreaterThanOrEqual(32)
      await dot.click()
      // Each option carries its dot.
      for (const h of ['days', 'weeks', 'months', 'eventually']) {
        await expect(
          page.locator(`[data-horizon-option="${h}"] [data-horizon-mark="${h}"]`),
        ).toBeVisible()
      }
      await page.screenshot({ path: `${SHOTS}/segment-menu-desktop.png`, animations: 'disabled' })
      await page.getByRole('menuitemradio', { name: /^Months/ }).click()
      await expect.poll(async () => (await stateOf(page, id)).horizon).toBe('months')
      await undoFromToast(page, 'Moved to Monthly')
      await expect.poll(async () => (await stateOf(page, id)).horizon).toBe('days')
    } finally {
      await trash(page, [id])
    }
  })
})

test.describe('Row corner · desktop at 2x', () => {
  test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })

  test('every horizon dot is visible at 2x, light and dark', async ({
    authenticatedPage: page,
  }) => {
    const ids = new Map<string, number>()
    for (const h of ['days', 'weeks', 'months', 'eventually', null] as const) {
      ids.set(String(h), await create(page, { title: uniqueTitle(`RC 2x ${h}`), horizon: h }))
    }
    try {
      await gotoDashboard(page)
      await themes(page, async (theme) => {
        for (const [h, id] of ids) {
          const corner = taskRow(page, id).locator('[data-row-corner]')
          await expect(corner).toBeVisible()
          await corner.screenshot({ path: `${SHOTS}/dot-${h}-2x-${theme}.png` })
        }
      })
    } finally {
      await trash(page, [...ids.values()])
    }
  })
})

/**
 * The dashboard rows' horizon menu and hover Today (the dashboard passes
 * `onSetHorizon` / `onTargetAt` to its TaskList, so the dot is a button). The
 * three tasks are undated with no priority — not relevant now — so their rows
 * are inside the project's open Now fold: the fold renders ordinary rows,
 * actions included.
 */
test.describe('Row corner · dashboard actions', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('dot menu changes the horizon with Undo; Today taps and holds', async ({
    authenticatedPage: page,
  }) => {
    const dotTask = await create(page, { title: uniqueTitle('RC dash dot'), horizon: 'weeks' })
    const tapTask = await create(page, { title: uniqueTitle('RC dash today') })
    const holdTask = await create(page, { title: uniqueTitle('RC dash hold') })
    try {
      await gotoDashboard(page)
      // All three rows are behind the fold, now open.
      const group = projectGroup(page)
      await expect(group.locator('[data-now-count]')).toHaveText('0 of 3')
      await expect(group.locator('[data-now-fold="open"]')).toBeVisible()
      const dot = taskRow(page, dotTask).locator('[data-horizon-dot]')
      await expect(dot).toBeVisible()
      expect(await dot.evaluate((el) => el.tagName)).toBe('BUTTON')

      // The corner dot's hit box is 32×32 though the tab is 24×18: a press
      // 12px below the tab and 6px left of it still lands on the dot.
      const box = (await dot.boundingBox())!
      const hit = await page.evaluate(
        ([x, y]) => document.elementFromPoint(x, y)?.closest('[data-horizon-dot]') !== null,
        [box.x - 6, box.y + box.height + 12],
      )
      expect(hit).toBe(true)

      await dot.click()
      await page.getByRole('menuitemradio', { name: /^Eventually/ }).click()
      await expect.poll(async () => (await stateOf(page, dotTask)).horizon).toBe('eventually')
      await undoFromToast(page, /.+/)
      await expect.poll(async () => (await stateOf(page, dotTask)).horizon).toBe('weeks')

      // Today: hidden until the row is hovered, then a tap targets today.
      const today = taskRow(page, tapTask).locator('[data-target-today]')
      await taskRow(page, tapTask).hover()
      await expect(today).toHaveCSS('opacity', '1')
      await taskRow(page, tapTask).screenshot({ path: `${SHOTS}/today-hover-desktop.png` })
      await today.click()
      await expect.poll(async () => (await stateOf(page, tapTask)).target_at).not.toBeNull()
      await expect(taskRow(page, tapTask)).not.toHaveAttribute('aria-selected', 'true')
      await undoFromToast(page, /Targeted/)
      await expect.poll(async () => (await stateOf(page, tapTask)).target_at).toBeNull()

      // A hold opens the Target menu; it does not select the row.
      await taskRow(page, holdTask).hover()
      const holdButton = taskRow(page, holdTask).locator('[data-target-today]')
      const menu = page.getByRole('menu', { name: 'Target options' })
      await holdUntil(holdButton, () => expect(menu).toBeVisible())
      await expect(taskRow(page, holdTask)).toHaveAttribute('aria-selected', 'false')
      await menu.getByRole('menuitem', { name: '2 hours' }).click()
      await expect.poll(async () => (await stateOf(page, holdTask)).target_at).not.toBeNull()
    } finally {
      await trash(page, [dotTask, tapTask, holdTask])
    }
  })
})

test.describe('Row corner · phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true })

  test('tabs and dot at 375; the time opens its menu, not the editor; no hover buttons', async ({
    authenticatedPage: page,
  }) => {
    const urgent = await create(page, {
      title: uniqueTitle('RC phone a rather long title that has to wrap around the corner'),
      priority: 4,
      horizon: 'days',
    })
    const timed = await create(page, {
      title: uniqueTitle('RC phone timed'),
      // High, so the row has a corner (a Medium row has none since 10-15) for
      // the "New" tag check below.
      priority: 3,
      target_at: tomorrowAt10(),
    })
    try {
      await gotoDashboard(page)
      await expect(taskRow(page, urgent).locator('[data-priority-tab]')).toHaveText('Urgent')
      await expect(taskRow(page, urgent).locator('[data-horizon-dot]')).toHaveAttribute(
        'data-horizon-dot',
        'days',
      )
      // The title wraps around the corner instead of running under it.
      const title = taskRow(page, urgent).getByRole('link')
      const corner = taskRow(page, urgent).locator('[data-row-corner]')
      const titleBox = (await title.boundingBox())!
      const cornerBox = (await corner.boundingBox())!
      // Measured on the title's TEXT (the invisible float spacer itself sits
      // under the corner on purpose).
      const overlap = await title.evaluate((el, c) => {
        // The title's text node, inside the clamp box's one block (`ClampedTitle`).
        const text = [...el.firstElementChild!.childNodes].find(
          (n) => n.nodeType === Node.TEXT_NODE,
        )!
        const range = document.createRange()
        range.selectNodeContents(text)
        return [...range.getClientRects()].some(
          (r) =>
            r.right > c.x && r.left < c.x + c.width && r.top < c.y + c.height && r.bottom > c.y,
        )
      }, cornerBox)
      expect(overlap, JSON.stringify({ titleBox, cornerBox })).toBe(false)
      // So does the "New" tag after a just-added title (both rows have one).
      for (const id of [urgent, timed]) {
        const tag = (await taskRow(page, id).locator('[data-just-added-badge]').boundingBox())!
        const tabs = (await taskRow(page, id).locator('[data-row-corner]').boundingBox())!
        expect(tag.x + tag.width, `row ${id}`).toBeLessThanOrEqual(tabs.x)
      }
      // No hover-only buttons on a phone.
      await expect(taskRow(page, urgent).locator('[data-target-today]')).toBeHidden()
      await expect(taskRow(page, timed).locator('[data-remove-target-x]')).toBeHidden()

      // The dashboard wires the dot (see 'dashboard actions'): it is a 44px
      // target for a finger: a tap 20px below the tab and 16px to its left
      // opens the horizon menu, not the editor.
      const dot = taskRow(page, urgent).locator('[data-horizon-dot]')
      expect(await dot.evaluate((el) => el.tagName)).toBe('BUTTON')
      await dot.evaluate((el) => el.scrollIntoView({ block: 'center' }))
      const box = (await dot.boundingBox())!
      await page.touchscreen.tap(box.x - 16, box.y + box.height + 20)
      await expect(page.getByRole('menuitemradio', { name: /^Weeks/ })).toBeVisible()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await page.screenshot({ path: `${SHOTS}/phone-dot-menu.png`, animations: 'disabled' })
      await page.keyboard.press('Escape')

      await themes(page, async (theme) => {
        await taskRow(page, urgent).screenshot({ path: `${SHOTS}/phone-urgent-${theme}.png` })
        await taskRow(page, timed).screenshot({ path: `${SHOTS}/phone-timed-${theme}.png` })
      })

      // Tapping the time opens its menu — not the quick editor.
      await taskRow(page, timed).locator('[data-target-time]').tap()
      await expect(page.getByRole('menuitem', { name: 'Move…' })).toBeVisible()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await page.screenshot({ path: `${SHOTS}/phone-time-menu.png`, animations: 'disabled' })
      await page.getByRole('menuitem', { name: 'Remove target' }).tap()
      await expect.poll(async () => (await stateOf(page, timed)).target_at).toBeNull()
      await undoFromToast(page, /.+/)
      await expect.poll(async () => (await stateOf(page, timed)).target_at).not.toBeNull()
    } finally {
      await trash(page, [urgent, timed])
    }
  })

  // A finger's target: 44 tall, and 34 wide like every action in the row's
  // button group (the compact row buttons, 2026-10-26; 44 wide before).
  test('segment row dot is a 34×44 target on a phone', async ({ authenticatedPage: page }) => {
    const id = await create(page, { title: uniqueTitle('RC seg phone'), horizon: 'days' })
    backdateCreated([id], { inSegments: true })
    try {
      await page.goto('/reminders')
      const dot = page
        .locator('[data-task-segments]')
        .locator(`[data-segment-task="${id}"] [data-horizon-dot]`)
      const box = (await dot.boundingBox())!
      expect(box.width).toBeGreaterThanOrEqual(34)
      expect(box.height).toBeGreaterThanOrEqual(44)
    } finally {
      await trash(page, [id])
    }
  })
})
