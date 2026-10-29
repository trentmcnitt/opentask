/**
 * The lean task row (`src/components/lean-row/LeanRow.tsx`): the dashboard
 * list's row when Settings → Theme → Task rows says Lean. The build default
 * here is the card (CI builds without NEXT_PUBLIC_DEFAULT_TASK_ROWS), so this
 * file sets the device setting itself before each page load — every other
 * spec keeps seeing the card rows.
 *
 * Covers: the row's look (later today: a faint blue; over target: the blue
 * tint and the slate title; a passed deadline: the red tint, the title
 * unchanged, winning over the blue — in both themes; no bar; the target chip
 * still the blue target chip; the red flag; the created date; no "ago"), its
 * buttons (done, On deck, the clock, each with Undo; the clock's defer and
 * menu on a targeted row; hidden at rest with a mouse and shown on hover or
 * focus, a decked row's lit icon parked right; always shown and thumb-sized
 * on a touch screen; still with reduced motion), details on double-click, a
 * swipe to done, and the setting itself. The task-queue switch is on for the file (On deck
 * needs it) and off after it.
 */
import { DateTime } from 'luxon'
import { test, expect, holdUntil, openTaskDay, uniqueTitle } from './fixtures'
import type { Locator, Page } from '@playwright/test'

const HOUR = 60 * 60 * 1000
const LEAN = () => window.localStorage.setItem('opentask_task_rows', 'lean')

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ request }) => {
  const res = await request.post('/api/test/task-queue', { data: { enabled: true } })
  expect(res.ok()).toBeTruthy()
})
test.afterAll(async ({ request }) => {
  await request.post('/api/test/task-queue', { data: { enabled: false } })
})

/** Each test's tasks in a project of their own, so its group holds them all. */
const projects = new Map<string, { id: number; name: string }>()
async function projectFor(page: Page): Promise<{ id: number; name: string }> {
  const key = test.info().testId
  const known = projects.get(key)
  if (known) return known
  const name = uniqueTitle('LR')
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

async function stateOf(page: Page, id: number): Promise<Record<string, unknown>> {
  return (await (await page.request.get(`/api/tasks/${id}`)).json()).data
}

async function cleanUp(page: Page, ids: number[]) {
  if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
  const project = projects.get(test.info().testId)
  if (project) {
    await page.request.delete(`/api/projects/${project.id}`)
    projects.delete(test.info().testId)
  }
}

/** The dashboard, with the test's project fold open so every row is on screen. */
async function gotoDashboard(page: Page) {
  await page.goto('/')
  const { name } = await projectFor(page)
  const group = page.locator('section[data-task-group]', {
    has: page.getByRole('button', { name: `Collapse ${name}`, exact: true }),
  })
  await expect(group).toBeVisible()
  const shut = group.locator('[data-now-fold="shut"]')
  if ((await shut.count()) > 0) await shut.click()
  await expect(shut).toHaveCount(0)
}

const row = (page: Page, id: number): Locator => page.locator(`[data-lean-row="${id}"]`)

/** A tint's colour and alpha (an opaque `rgb()` reads as alpha 1), to two decimals. */
function expectTint(bg: string, [r, g, b, a]: [number, number, number, number]) {
  const m = bg.match(/^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)$/)
  expect(m, bg).not.toBeNull()
  expect(m!.slice(1, 4).map(Number)).toEqual([r, g, b])
  expect(Number(m![4] ?? 1)).toBeCloseTo(a, 2)
}

/**
 * A moment later today whatever the hour: 40 minutes out, but before the
 * OpenTask day ends (the next day start, the server's own rule).
 */
async function laterToday(page: Page): Promise<Date> {
  const tz = process.env.E2E_TZ || 'America/Chicago'
  const { rollover_time } = (await (await page.request.get('/api/user/preferences')).json())
    .data as { rollover_time: string }
  const dayEnd = DateTime.fromISO(`${await openTaskDay(page, 1)}T${rollover_time}`, { zone: tz })
  return new Date(Math.min(Date.now() + 40 * 60 * 1000, dayEnd.toMillis() - 2 * 60 * 1000))
}

const deferMenu = (page: Page) => page.getByRole('menu', { name: 'Defer options' })

/**
 * Escape, re-sent until the menu goes: it registers its keydown listener a
 * tick after opening (snooze.spec.ts), so a first Escape can arrive early.
 */
async function dismissMenu(page: Page) {
  await expect(async () => {
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await expect(deferMenu(page)).not.toBeVisible({ timeout: 500 })
  }).toPass({ timeout: 5000 })
}

const opacity = (l: Locator) => l.evaluate((el) => Number(getComputedStyle(el).opacity))

async function undoFromToast(page: Page, text: string | RegExp) {
  const toast = page.locator('[data-sonner-toast]', { hasText: text }).first()
  await expect(toast).toBeVisible()
  await toast.getByRole('button', { name: 'Undo' }).click()
  await page.mouse.move(0, 0)
}

test.describe('Lean row · look', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test.describe(scheme, () => {
      test.use({ viewport: { width: 1280, height: 800 }, colorScheme: scheme })

      test('later today faint blue, over target blue, a passed deadline red (red wins), no bar; the chip stays the blue target chip', async ({
        authenticatedPage: page,
      }) => {
        await page.addInitScript(LEAN)
        const now = Date.now()
        const soonAt = await laterToday(page)
        const ids = [
          await create(page, {
            title: uniqueTitle('LR over'),
            priority: 3,
            due_at: new Date(now - 2 * HOUR).toISOString(),
            notes: 'A note.',
          }),
          await create(page, {
            title: uniqueTitle('LR passed'),
            deadline_at: new Date(now - 24 * HOUR).toISOString(),
          }),
          await create(page, { title: uniqueTitle('LR plain'), horizon: 'weeks', priority: 1 }),
          // Both over target and past its deadline: the red wins.
          await create(page, {
            title: uniqueTitle('LR both'),
            due_at: new Date(now - 30 * HOUR).toISOString(),
            deadline_at: new Date(now - 2 * HOUR).toISOString(),
          }),
          // A target later today, not yet over: the faint blue.
          await create(page, { title: uniqueTitle('LR soon'), due_at: soonAt.toISOString() }),
        ]
        const [over, passed, plain, both, soon] = ids
        try {
          await gotoDashboard(page)
          for (const id of ids) await expect(row(page, id)).toBeVisible()

          // Over target: the row marked, the blue tint, the slate title, no bar.
          const o = row(page, over)
          await expect(o).toHaveAttribute('data-over-target', '')
          await expect(o).toHaveAttribute('data-row-state', 'over')
          const tint = (r: Locator) =>
            r.evaluate((el) => {
              const s = getComputedStyle(el, '::before')
              return { bg: s.backgroundColor, shadow: s.boxShadow }
            })
          const blue = await tint(o)
          // Light: Trent's E2 (2026-10-29), an opaque sky-leaning blue.
          expectTint(blue.bg, scheme === 'light' ? [214, 238, 255, 1] : [81, 162, 255, 0.125])
          expect(blue.shadow).toBe('none')
          const plainTitle = await row(page, plain)
            .locator('[data-lean-title]')
            .evaluate((el) => getComputedStyle(el).color)
          // The over-target title keeps the normal ink (Trent, 2026-10-29:
          // "just leave it full black"; it was a slate).
          await expect(o.locator('[data-lean-title]')).toHaveCSS('color', plainTitle)

          // A passed deadline: the red counterpart (x1.4), the title unchanged, no bar.
          const p = row(page, passed)
          await expect(p).toHaveAttribute('data-row-state', 'passed')
          await expect(p.locator('[data-lean-title]')).toHaveCSS('color', plainTitle)
          const red = await tint(p)
          expectTint(red.bg, scheme === 'light' ? [200, 20, 10, 0.098] : [255, 100, 103, 0.14])
          expect(red.shadow).toBe('none')

          // Later today: no tint for now (Trent, 2026-10-29) — the state is
          // kept, the row draws plain.
          const u = row(page, soon)
          await expect(u).toHaveAttribute('data-row-state', 'soon')
          await expect(u.locator('[data-lean-title]')).toHaveCSS('color', plainTitle)
          expect((await tint(u)).bg).toBe('rgba(0, 0, 0, 0)')
          // The title's weight (Trent, 2026-10-29): 600 on a tinted row (over
          // target, a passed deadline), 500 on a plain or later-today one.
          const weightOf = (id: number) =>
            row(page, id)
              .locator('[data-lean-title]')
              .evaluate((el) => getComputedStyle(el).fontWeight)
          expect(await weightOf(over)).toBe('600')
          expect(await weightOf(passed)).toBe('600')
          expect(await weightOf(soon)).toBe('500')
          expect(await weightOf(plain)).toBe('500')
          // Both over target and past its deadline: red, not blue — 1.75× the
          // passed-deadline red (Trent, 2026-10-29).
          await expect(row(page, both)).toHaveAttribute('data-over-target', '')
          await expect(row(page, both)).toHaveAttribute('data-row-state', 'passed')
          await expect(row(page, both)).toHaveAttribute('data-both-passed', '')
          expectTint(
            (await tint(row(page, both))).bg,
            scheme === 'light' ? [200, 20, 10, 0.1715] : [255, 100, 103, 0.245],
          )
          // A passed deadline with no target passed: the normal red.
          await expect(row(page, passed)).not.toHaveAttribute('data-both-passed', '')
          // The future target chip stays blue.
          await expect(u.locator('[data-time-chip="target"]')).toBeVisible()
          // The target chip: pale plum once the target has passed (M1,
          // 2026-10-29), the moment alone (no "ago").
          const chip = o.locator('[data-time-chip]')
          await expect(chip).toHaveAttribute('data-time-chip', 'over')
          await expect(chip).not.toContainText('ago')
          // The attempts badge right after it, in neutral grey (no plum).
          const badge = o.locator('[data-attempts]')
          await expect(badge).toHaveText(/^\d+×$/)
          const badgeColor = await badge.evaluate((el) => getComputedStyle(el).color)
          expect(['rgb(142, 56, 155)', 'rgb(201, 124, 213)', 'rgb(161, 75, 174)']).not.toContain(
            badgeColor,
          )
          expect(
            await chip.evaluate(
              (c, b) => c.compareDocumentPosition(b!) & Node.DOCUMENT_POSITION_FOLLOWING,
              await badge.elementHandle(),
            ),
          ).toBeTruthy()
          // One gap between every meta item (Trent, 2026-10-29): each box on
          // the meta line sits 6px after the one before (no hidden ✕ box).
          const gaps = await o.locator('[data-lean-meta]').evaluate((meta) => {
            const boxes: DOMRect[] = []
            const walk = (el: Element) => {
              for (const c of el.children) {
                if (getComputedStyle(c).display === 'contents') walk(c)
                else boxes.push(c.getBoundingClientRect())
              }
            }
            walk(meta)
            return boxes.slice(1).map((b, k) => Math.round(b.left - boxes[k].right))
          })
          expect(gaps.length).toBeGreaterThan(2)
          expect(new Set(gaps)).toEqual(new Set([6]))
          // The created date is the line's last item (2026-10-29).
          expect(
            await o
              .locator('[data-lean-meta]')
              .evaluate((m) => !!m.lastElementChild?.querySelector('[data-created]')),
          ).toBe(true)
          // Every "·" shares one box with the item after it, so a wrap never
          // leaves a dot at a line's end (2026-10-29).
          expect(
            await o.locator('[data-lean-meta]').evaluate((m) =>
              [...m.querySelectorAll('span[aria-hidden]')]
                .filter((d) => d.textContent?.trim() === '·')
                .every((d) => {
                  const box = d.parentElement!
                  return (
                    getComputedStyle(box).whiteSpace === 'nowrap' && d.nextElementSibling !== null
                  )
                }),
            ),
          ).toBe(true)
          // The tint covers the row's bottom border: no seam between two
          // tinted rows (Trent, 2026-10-29).
          expect(await o.evaluate((el) => getComputedStyle(el, '::before').bottom)).toBe('-1px')
          // "!" after the title, the notes mark, the created date.
          await expect(o.locator('[data-priority-tab]')).toHaveText('!')
          await expect(o.locator('[data-lean-notes]')).toBeVisible()
          await expect(o.locator('[data-created]')).toHaveText(/^today \d{1,2}:\d{2} [AP]M$/)

          // A passed deadline: red, with its flag.
          await expect(row(page, passed).locator('[data-deadline-chip]')).toHaveAttribute(
            'data-deadline-chip',
            'passed',
          )
          // A plain row: no state look, "Low" as a word, the horizon mark.
          await expect(row(page, plain)).not.toHaveAttribute('data-over-target', '')
          await expect(row(page, plain)).not.toHaveAttribute('data-row-state', /.+/)
          await expect(row(page, plain).locator('[data-lean-low]')).toHaveText('Low')
          await expect(row(page, plain).locator('[data-attempts]')).toHaveCount(0)
          // Its horizon is the done square's border (Weeks: long dashes).
          await expect(row(page, plain).locator('[data-lean-done]')).toHaveAttribute(
            'data-horizon-square',
            'weeks',
          )
        } finally {
          await cleanUp(page, ids)
        }
      })
    })
  }
})

test.describe('Lean row · the horizon done square', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  // Trent, 2026-10-29: "my eye doesn't like that the task checkbox is
  // changing shape" — outside Scan's Horizon sections (where the modes draw
  // it, `horizonLook`) every square is plain, yet each one-off still names
  // its horizon: the attribute, the tooltip, the accessible name.
  test('every square on the dashboard is plain, each one-off names its horizon, and the dot shows it', async ({
    authenticatedPage: page,
  }) => {
    await page.addInitScript(LEAN)
    const made = {
      weeks: await create(page, { title: uniqueTitle('LR weeks'), horizon: 'weeks' }),
      months: await create(page, { title: uniqueTitle('LR months'), horizon: 'months' }),
      unset: await create(page, { title: uniqueTitle('LR unset') }),
      dated: await create(page, {
        title: uniqueTitle('LR dated'),
        horizon: 'eventually',
        due_at: new Date(Date.now() + 48 * HOUR).toISOString(),
      }),
      deadline: await create(page, {
        title: uniqueTitle('LR deadline'),
        horizon: 'months',
        deadline_at: new Date(Date.now() + 48 * HOUR).toISOString(),
      }),
      repeating: await create(page, {
        title: uniqueTitle('LR repeat'),
        rrule: 'FREQ=DAILY',
        due_at: new Date(Date.now() + 48 * HOUR).toISOString(),
      }),
    }
    try {
      await gotoDashboard(page)
      const square = (id: number) => row(page, id).locator('[data-lean-done]')
      for (const id of Object.values(made)) {
        await expect(square(id).locator('[data-horizon-border]')).toHaveCount(0)
      }
      // The SET horizon, targeted and deadline rows too; unset as UNSET_HORIZON.
      await expect(square(made.weeks)).toHaveAttribute('data-horizon-square', 'weeks')
      await expect(square(made.unset)).toHaveAttribute('data-horizon-square', 'weeks')
      await expect(square(made.dated)).toHaveAttribute('data-horizon-square', 'eventually')
      await expect(square(made.deadline)).toHaveAttribute('data-horizon-square', 'months')
      await expect(square(made.months)).toHaveAttribute(
        'title',
        'Done · Horizon: Months. Hold to change.',
      )
      await expect(square(made.unset)).toHaveAttribute(
        'title',
        'Done · Horizon: unset (Weeks). Hold to change.',
      )
      await expect(square(made.unset)).toHaveAccessibleName(
        /^Done: ".+" · Horizon: unset \(Weeks\)\. Hold to change\.$/,
      )

      // The horizon DOT on the meta line (2026-10-29), main's perspective
      // dot: every one-off; unset draws as the Weeks dot, no hollow ring.
      const dot = (id: number) => row(page, id).locator('[data-lean-meta] [data-horizon-dot]')
      const circle = (id: number) =>
        dot(id)
          .locator('circle')
          .evaluate((c) => [c.getAttribute('r'), c.getAttribute('opacity'), c.getAttribute('fill')])
      expect(await circle(made.weeks)).toEqual(['3', '0.7', 'currentColor'])
      expect(await circle(made.unset)).toEqual(await circle(made.weeks))
      expect(await circle(made.months)).toEqual(['2.5', '0.55', 'currentColor'])
      expect(await circle(made.dated)).toEqual(['2.25', '0.42', 'currentColor'])
      await expect(dot(made.deadline)).toHaveCount(1)
      // A repeating task: no dot.
      await expect(dot(made.repeating)).toHaveCount(0)
      // No two dots in a row (Trent, 2026-10-29): with nothing between, the
      // created date follows the horizon dot with no "·".
      const afterDot = await row(page, made.weeks)
        .locator('[data-lean-meta]')
        .evaluate((m) => {
          const next = m.querySelector('[data-horizon-dot]')?.nextElementSibling
          return { created: !!next?.querySelector('[data-created]'), text: next?.textContent }
        })
      expect(afterDot.created).toBe(true)
      expect(afterDot.text).not.toContain('·')
      // With no chips, the dot leads the line (2026-10-29).
      expect(
        await row(page, made.weeks)
          .locator('[data-lean-meta]')
          .evaluate((m) => m.firstElementChild?.hasAttribute('data-horizon-dot')),
      ).toBe(true)
      // After a chip, right after it, with no "·" (a targeted one-off).
      expect(
        await row(page, made.dated)
          .locator('[data-lean-meta]')
          .evaluate((m) => {
            const chip = m.querySelector('[data-time-chip]')!
            let box: Element | null = chip
            while (box && box.parentElement !== m) box = box.parentElement
            return box?.nextElementSibling?.hasAttribute('data-horizon-dot')
          }),
      ).toBe(true)
      // Its own menu.
      await dot(made.weeks).click()
      await expect(page.getByRole('menuitemradio', { name: /^Months/ })).toBeVisible()
      await page.keyboard.press('Escape')
    } finally {
      await cleanUp(page, Object.values(made))
    }
  })
})

test.describe('Lean row · changing the horizon from the square', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('a right-click or a hold on a horizon square opens the horizon menu, targeted and deadline rows too; a repeating square has none', async ({
    authenticatedPage: page,
  }) => {
    await page.addInitScript(LEAN)
    const governed = await create(page, { title: uniqueTitle('LR hz'), horizon: 'weeks' })
    const dated = await create(page, {
      title: uniqueTitle('LR hz dated'),
      due_at: new Date(Date.now() + 48 * HOUR).toISOString(),
    })
    const deadline = await create(page, {
      title: uniqueTitle('LR hz deadline'),
      deadline_at: new Date(Date.now() + 48 * HOUR).toISOString(),
    })
    const repeating = await create(page, {
      title: uniqueTitle('LR hz repeat'),
      rrule: 'FREQ=DAILY',
      due_at: new Date(Date.now() + 48 * HOUR).toISOString(),
    })
    try {
      await gotoDashboard(page)
      const square = row(page, governed).locator('[data-lean-done]')
      const menu = page.getByRole('menu')

      // Right-click: the menu; pick Months; the square follows; Undo.
      await square.click({ button: 'right' })
      await expect(menu).toBeVisible()
      await page.getByRole('menuitemradio', { name: /^Months/ }).click()
      await expect.poll(async () => (await stateOf(page, governed)).horizon).toBe('months')
      await expect(square).toHaveAttribute('data-horizon-square', 'months')
      await undoFromToast(page, /.+/)
      await expect.poll(async () => (await stateOf(page, governed)).horizon).toBe('weeks')

      // A hold opens it too, and completes nothing.
      await holdUntil(square, () => expect(menu).toBeVisible())
      await page.keyboard.press('Escape')
      await expect(menu).toHaveCount(0)
      expect((await stateOf(page, governed)).done).toBe(false)

      // A targeted row's square has the menu too.
      await row(page, dated).locator('[data-lean-done]').click({ button: 'right' })
      await expect(menu).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(menu).toHaveCount(0)

      // A deadline row's square has it too.
      await row(page, deadline).locator('[data-lean-done]').click({ button: 'right' })
      await expect(menu).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(menu).toHaveCount(0)

      // A repeating row's square: no horizon menu.
      await row(page, repeating).locator('[data-lean-done]').click({ button: 'right' })
      await expect(menu).toHaveCount(0)
    } finally {
      await cleanUp(page, [governed, dated, deadline, repeating])
    }
  })
})

test.describe('Lean row · the deadline countdown', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('a deadline later today counts down in whole hours, lighter, after a single space', async ({
    authenticatedPage: page,
  }) => {
    await page.addInitScript(LEAN)
    const id = await create(page, {
      title: uniqueTitle('LR countdown'),
      deadline_at: (await laterToday(page)).toISOString(),
    })
    try {
      await gotoDashboard(page)
      const chip = row(page, id).locator('[data-deadline-chip]')
      const countdown = chip.locator('[data-countdown]')
      await expect(countdown).toHaveText(/^in (<1 hr|1 hr|\d+ hrs)$/)
      // "Today 9:00 PM in 5 hrs": one normal space between the time and the count.
      await expect(chip).toHaveText(/^(Today|Tonight) \d{1,2}:\d{2} [AP]M in (<1 hr|1 hr|\d+ hrs)$/)
      // The count is lighter than the time, in the chip's own colour.
      await expect(countdown).toHaveCSS('font-weight', '400')
      await expect(chip).toHaveCSS('font-weight', '600')
      expect(await countdown.evaluate((el) => getComputedStyle(el).color)).toBe(
        await chip.evaluate((el) => getComputedStyle(el).color),
      )
    } finally {
      await cleanUp(page, [id])
    }
  })
})

test.describe('Lean row · actions', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('done, On deck and the clock (Today on an untargeted row), each with Undo; double-click opens details', async ({
    authenticatedPage: page,
  }) => {
    await page.addInitScript(LEAN)
    const id = await create(page, { title: uniqueTitle('LR act'), horizon: 'weeks' })
    try {
      await gotoDashboard(page)
      const r = row(page, id)
      await expect(r).toBeVisible()

      await r.locator('[data-lean-done]').click()
      await expect.poll(async () => (await stateOf(page, id)).done).toBe(true)
      await undoFromToast(page, /.+/)
      await expect.poll(async () => (await stateOf(page, id)).done).toBe(false)

      await r.locator('[data-on-deck]').click()
      await expect.poll(async () => (await stateOf(page, id)).on_deck_day).not.toBeNull()
      await undoFromToast(page, /.+/)
      await expect.poll(async () => (await stateOf(page, id)).on_deck_day).toBeNull()

      // The clock, no word, no sun: on an untargeted row a tap targets today.
      const clock = r.locator('[data-lean-buttons] [data-target-today]')
      await expect(clock.locator('svg.lucide-clock-3')).toHaveCount(1)
      await expect(clock).toHaveText('')
      await clock.click()
      await expect.poll(async () => (await stateOf(page, id)).target_at).not.toBeNull()
      await undoFromToast(page, /Targeted/)
      await expect.poll(async () => (await stateOf(page, id)).target_at).toBeNull()

      await r.locator('[data-lean-title]').dblclick()
      await expect(page.getByRole('dialog')).toBeVisible()
      await page.keyboard.press('Escape')
    } finally {
      await cleanUp(page, [id])
    }
  })
})

test.describe('Lean row · the clock on a targeted row', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('a due target: a tap defers it; a target not yet due: a tap opens the time menu', async ({
    authenticatedPage: page,
  }) => {
    await page.addInitScript(LEAN)
    const now = Date.now()
    const due = await create(page, {
      title: uniqueTitle('LR due'),
      due_at: new Date(now - 2 * HOUR).toISOString(),
    })
    const later = await create(page, {
      title: uniqueTitle('LR later'),
      due_at: new Date(now + 26 * HOUR).toISOString(),
    })
    try {
      await gotoDashboard(page)
      // Already due: a tap defers by the default — the target moves ahead.
      await row(page, due).locator('[data-lean-defer]').click()
      await expect
        .poll(async () => Date.parse((await stateOf(page, due)).target_at as string))
        .toBeGreaterThan(now)
      await undoFromToast(page, /.+/)
      await expect
        .poll(async () => Date.parse((await stateOf(page, due)).target_at as string))
        .toBeLessThan(now)

      // Not yet due: a tap opens the menu and moves nothing.
      const before = (await stateOf(page, later)).target_at
      await row(page, later).locator('[data-lean-defer]').click()
      await expect(deferMenu(page)).toBeVisible()
      await dismissMenu(page)
      expect((await stateOf(page, later)).target_at).toBe(before)

      // A hold opens it too.
      await row(page, due).hover()
      await holdUntil(row(page, due).locator('[data-lean-defer]'), () =>
        expect(deferMenu(page)).toBeVisible(),
      )
      await dismissMenu(page)
    } finally {
      await cleanUp(page, [due, later])
    }
  })
})

test.describe('Lean row · buttons with a mouse', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('hidden at rest, shown on hover and on focus; a decked row keeps its lit icon, parked right, and slides it home on hover', async ({
    authenticatedPage: page,
  }) => {
    await page.addInitScript(LEAN)
    const plain = await create(page, { title: uniqueTitle('LR rest'), horizon: 'weeks' })
    const decked = await create(page, { title: uniqueTitle('LR decked'), horizon: 'weeks' })
    try {
      const res = await page.request.patch(`/api/tasks/${decked}`, {
        data: { on_deck_day: await openTaskDay(page) },
      })
      expect(res.ok(), await res.text()).toBeTruthy()
      await gotoDashboard(page)
      await page.mouse.move(0, 0)
      const p = row(page, plain)
      const clock = p.locator('[data-target-today]')
      // At rest: nothing.
      await expect.poll(() => opacity(clock)).toBe(0)
      await expect.poll(() => opacity(p.locator('[data-on-deck]'))).toBe(0)
      // Hover: all three.
      await p.locator('[data-lean-title]').hover()
      await expect.poll(() => opacity(clock)).toBe(1)
      await expect.poll(() => opacity(p.locator('[data-deck-tomorrow]'))).toBe(1)
      await expect.poll(() => opacity(p.locator('[data-on-deck]'))).toBe(1)
      // Keyboard focus shows them too.
      await page.mouse.move(0, 0)
      await expect.poll(() => opacity(clock)).toBe(0)
      await p.focus()
      await expect.poll(() => opacity(clock)).toBe(1)
      await p.evaluate((el) => (el as HTMLElement).blur())

      // A decked row at rest: the lit icon alone, in the clock's slot.
      const d = row(page, decked)
      const deck = d.locator('[data-on-deck]')
      const dClock = d.locator('[data-target-today]')
      await expect(deck).toHaveAttribute('data-on-deck-active', '')
      await expect.poll(() => opacity(deck)).toBe(1)
      await expect.poll(() => opacity(dClock)).toBe(0)
      const x = async (l: Locator) => (await l.boundingBox())!.x
      await expect.poll(async () => Math.round((await x(deck)) - (await x(dClock)))).toBe(0)
      // Hover: it slides home, left of deck-tomorrow and the clock.
      await d.locator('[data-lean-title]').hover()
      await expect.poll(() => opacity(dClock)).toBe(1)
      await expect
        .poll(async () =>
          Math.round((await x(d.locator('[data-deck-tomorrow]'))) - (await x(deck))),
        )
        .toBe(34)
      expect(await x(dClock)).toBeGreaterThan(await x(d.locator('[data-deck-tomorrow]')))
    } finally {
      await cleanUp(page, [plain, decked])
    }
  })
})

test.describe('Lean row · buttons with reduced motion', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('nothing slides or fades: no transitions', async ({ authenticatedPage: page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.addInitScript(LEAN)
    const id = await create(page, { title: uniqueTitle('LR still'), horizon: 'weeks' })
    try {
      await gotoDashboard(page)
      for (const sel of ['[data-on-deck]', '[data-deck-tomorrow]', '[data-target-today]']) {
        await expect(row(page, id).locator(sel)).toHaveCSS('transition-property', 'none')
      }
    } finally {
      await cleanUp(page, [id])
    }
  })
})

test.describe('Lean row · buttons on a touch screen', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true })

  test('deck, deck tomorrow and the clock always shown, 44px targets, clear of the title', async ({
    authenticatedPage: page,
  }) => {
    await page.addInitScript(LEAN)
    const id = await create(page, {
      title: uniqueTitle('LR thumbs with a title long enough to wrap onto a second line'),
      horizon: 'weeks',
    })
    try {
      await gotoDashboard(page)
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
      const r = row(page, id)
      const buttons = ['[data-on-deck]', '[data-deck-tomorrow]', '[data-target-today]'].map((sel) =>
        r.locator(sel),
      )
      for (const b of buttons) {
        expect(await opacity(b)).toBe(1)
        const box = (await b.boundingBox())!
        expect(box.width).toBeGreaterThanOrEqual(44)
        expect(box.height).toBeGreaterThanOrEqual(44)
      }
      // No line of the title runs under them.
      const first = (await buttons[0].boundingBox())!
      const lines = await r.locator('[data-lean-title]').evaluate((el) => {
        const range = document.createRange()
        range.selectNodeContents(el)
        return [...range.getClientRects()].map((q) => ({
          right: q.right,
          top: q.top,
          bottom: q.bottom,
        }))
      })
      const beside = lines.filter((l) => l.bottom > first.y && l.top < first.y + first.height)
      expect(beside.length).toBeGreaterThan(0)
      for (const line of beside) expect(line.right).toBeLessThanOrEqual(first.x + 0.5)
    } finally {
      await cleanUp(page, [id])
    }
  })
})

test.describe('Lean row · swipe with a mouse', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  // Trent, 2026-10-29 ("some visual glitches"): mid-swipe the focus outline
  // rode along on the moving row, and the tint lost its 4px bleed on each
  // side (the swipe container, sized to the row, clipped it).
  test('mid-swipe every tint keeps its full width and no outline rides along', async ({
    authenticatedPage: page,
  }) => {
    await page.addInitScript(LEAN)
    const now = Date.now()
    const ids = {
      passed: await create(page, {
        title: uniqueTitle('LR sw passed'),
        deadline_at: new Date(now - 24 * HOUR).toISOString(),
      }),
      over: await create(page, {
        title: uniqueTitle('LR sw over'),
        due_at: new Date(now - 2 * HOUR).toISOString(),
      }),
      soon: await create(page, {
        title: uniqueTitle('LR sw soon'),
        due_at: (await laterToday(page)).toISOString(),
      }),
      none: await create(page, { title: uniqueTitle('LR sw plain'), horizon: 'weeks' }),
    }
    const ring = (r: Locator) => r.evaluate((el) => getComputedStyle(el).boxShadow)
    // Any box-shadow with a non-zero spread draws an outline.
    const drawsOutline = (shadow: string) => /\s[1-9][\d.]*px(\s+inset)?(,|$)/.test(shadow)
    try {
      await gotoDashboard(page)
      for (const [state, id] of Object.entries(ids)) {
        const r = row(page, id)
        await expect(r).toBeVisible()
        if (state === 'none') await expect(r).not.toHaveAttribute('data-row-state')
        else await expect(r).toHaveAttribute('data-row-state', state)
        // SwipeableRow: its container, then the moving layer, then the row.
        const swipe = r.locator('xpath=../..')

        // Keyboard focus on the row (its focus outline): Ctrl+Up to the
        // list's first row (Control: the app reads Cmd or Ctrl from the user
        // agent, and the Desktop Chrome device reports Windows), then down
        // until it is this one, each press landing before the next.
        // A first arrow switches the keyboard on (it may land on the row under
        // the mouse); Ctrl+Up then takes the list's first row.
        const focusedId = () => page.evaluate(() => document.activeElement?.id ?? '')
        await page.keyboard.press('ArrowDown')
        await expect.poll(focusedId).toMatch(/^task-row-\d+$/)
        const firstId = await page.locator('[role="option"]').first().getAttribute('id')
        await page.keyboard.press('Control+ArrowUp')
        await expect.poll(focusedId).toBe(firstId)
        const rowCount = await page.locator('[role="option"]').count()
        for (let i = 0; i < rowCount && (await focusedId()) !== `task-row-${id}`; i++) {
          const before = await focusedId()
          await page.keyboard.press('ArrowDown')
          await expect.poll(focusedId).not.toBe(before)
        }
        await expect(r).toBeFocused()
        await expect(r).toHaveAttribute('aria-selected', 'false')
        await expect.poll(async () => drawsOutline(await ring(r)), `${state} at rest`).toBe(true)
        const title = (await r.locator('[data-lean-title]').boundingBox())!

        // Hold a swipe left, short of the threshold.
        const y = title.y + 8
        const x0 = title.x + 300
        const restX = (await r.boundingBox())!.x
        await page.mouse.move(x0, y)
        await page.mouse.down()
        for (let x = x0; x >= x0 - 120; x -= 15) await page.mouse.move(x, y)
        await expect.poll(async () => (await r.boundingBox())!.x).toBeLessThan(restX - 60)
        expect(drawsOutline(await ring(r)), `${state} mid-swipe`).toBe(false)
        // The clipping container is the tint's width: 4px past the row each side.
        const box = (await swipe.boundingBox())!
        const rowBox = (await r.boundingBox())!
        expect(box.width, state).toBeCloseTo(rowBox.width + 8, 0)
        const tintInset = await r.evaluate((el) => getComputedStyle(el, '::before').left)
        // A tinted row's tint box; later today has no tint for now (2026-10-29).
        if (state === 'passed' || state === 'over') expect(tintInset, state).toBe('-4px')

        await page.mouse.move(x0, y)
        await page.mouse.up()
        await expect.poll(async () => drawsOutline(await ring(r)), `${state} back`).toBe(true)
        await page.mouse.move(0, 0)
      }
    } finally {
      await cleanUp(page, Object.values(ids))
    }
  })
})

test.describe('Lean row · phone', () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test('a swipe right past the threshold completes the task', async ({
    authenticatedPage: page,
  }) => {
    await page.addInitScript(LEAN)
    const id = await create(page, { title: uniqueTitle('LR swipe'), horizon: 'weeks' })
    try {
      await gotoDashboard(page)
      const r = row(page, id)
      await expect(r).toBeVisible()
      // The buttons float right and the title wraps beside them: on a phone
      // they sit inside the row's body.
      await expect(r.locator('[data-lean-buttons]')).toBeVisible()

      // Swipe on the title, as a thumb would: the meta line's horizon dot is
      // its own control (its press opens the horizon menu, never a swipe).
      const title = (await r.locator('[data-lean-title]').boundingBox())!
      const y = title.y + 12
      const x0 = title.x + 8
      // The drag ends over the defer-overdue FAB: releasing there is not a tap
      // on it (it once deferred every overdue task, 2026-10-28).
      const overdue = async () =>
        (await (await page.request.get('/api/tasks/counts')).json()).data.overdue as number
      const overdueBefore = await overdue()
      await page.mouse.move(x0, y)
      await page.mouse.down()
      for (let x = x0; x <= x0 + 270; x += 15) await page.mouse.move(x, y)
      await page.mouse.up()
      await expect.poll(async () => (await stateOf(page, id)).done).toBe(true)
      expect(await overdue()).toBe(overdueBefore)
    } finally {
      await cleanUp(page, [id])
    }
  })
})

test.describe('Lean row · the setting', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('Settings → Task rows switches the dashboard between lean rows and cards', async ({
    authenticatedPage: page,
  }) => {
    const id = await create(page, { title: uniqueTitle('LR setting'), horizon: 'weeks' })
    try {
      // The build default (CI): cards.
      await gotoDashboard(page)
      await expect(page.locator(`#task-row-${id}`)).toBeVisible()
      await expect(row(page, id)).toHaveCount(0)

      await page.goto('/settings')
      await page.locator('[data-task-rows-setting]').selectOption('lean')
      await gotoDashboard(page)
      await expect(row(page, id)).toBeVisible()

      await page.goto('/settings')
      await page.locator('[data-task-rows-setting]').selectOption('card')
      await gotoDashboard(page)
      await expect(row(page, id)).toHaveCount(0)
      await expect(page.locator(`#task-row-${id}`)).toBeVisible()
    } finally {
      await cleanUp(page, [id])
    }
  })
})
