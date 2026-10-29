/**
 * The lean task row (`src/components/lean-row/LeanRow.tsx`): the dashboard
 * list's row when Settings → Theme → Task rows says Lean. The build default
 * here is the card (CI builds without NEXT_PUBLIC_DEFAULT_TASK_ROWS), so this
 * file sets the device setting itself before each page load — every other
 * spec keeps seeing the card rows.
 *
 * Covers: the row's look (over target: the blue tint and the slate title in
 * both themes; a passed deadline: the red tint and title, winning over the
 * blue; no bar; the target chip still the blue target chip; the red flag; the created date; no "ago"), its buttons (done,
 * On deck, Today, each with Undo), details on double-click, a swipe to done,
 * and the setting itself. The task-queue switch is on for the file (On deck
 * needs it) and off after it.
 */
import { test, expect, uniqueTitle } from './fixtures'
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

      test('over target blue, a passed deadline red (red wins), no bar; the chip stays the blue target chip', async ({
        authenticatedPage: page,
      }) => {
        await page.addInitScript(LEAN)
        const now = Date.now()
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
        ]
        const [over, passed, plain, both] = ids
        try {
          await gotoDashboard(page)
          for (const id of ids) await expect(row(page, id)).toBeVisible()

          // Over target: the row marked, the blue tint, the slate title, no bar.
          const o = row(page, over)
          await expect(o).toHaveAttribute('data-over-target', '')
          await expect(o).toHaveAttribute('data-row-state', 'over')
          await expect(o.locator('[data-lean-title]')).toHaveCSS(
            'color',
            scheme === 'light' ? 'rgb(38, 51, 77)' : 'rgb(211, 220, 236)',
          )
          const tint = (r: Locator) =>
            r.evaluate((el) => {
              const s = getComputedStyle(el, '::before')
              return { bg: s.backgroundColor, shadow: s.boxShadow }
            })
          const blue = await tint(o)
          expect(blue.bg).not.toBe('rgba(0, 0, 0, 0)')
          expect(blue.shadow).toBe('none')

          // A passed deadline: the red counterpart, its own title colour, no bar.
          const p = row(page, passed)
          await expect(p).toHaveAttribute('data-row-state', 'passed')
          await expect(p.locator('[data-lean-title]')).toHaveCSS(
            'color',
            scheme === 'light' ? 'rgb(77, 38, 41)' : 'rgb(236, 211, 212)',
          )
          const red = await tint(p)
          expect(red.bg).not.toBe(blue.bg)
          expect(red.shadow).toBe('none')
          // Both over target and past its deadline: red, not blue.
          await expect(row(page, both)).toHaveAttribute('data-over-target', '')
          await expect(row(page, both)).toHaveAttribute('data-row-state', 'passed')
          // The target chip: the blue target tone, the moment alone (no "ago").
          const chip = o.locator('[data-time-chip]')
          await expect(chip).toHaveAttribute('data-time-chip', 'target')
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
  for (const [scheme, scale] of [
    ['light', 1],
    ['dark', 2],
  ] as const) {
    test.describe(`${scheme} at ${scale}x`, () => {
      test.use({
        viewport: { width: 1280, height: 800 },
        colorScheme: scheme,
        deviceScaleFactor: scale,
      })

      test('Days plain, Weeks / Months / Eventually patterned, unset as UNSET_HORIZON; a dated row plain', async ({
        authenticatedPage: page,
      }) => {
        await page.addInitScript(LEAN)
        const made = {
          days: await create(page, { title: uniqueTitle('LR days'), horizon: 'days' }),
          weeks: await create(page, { title: uniqueTitle('LR weeks'), horizon: 'weeks' }),
          months: await create(page, { title: uniqueTitle('LR months'), horizon: 'months' }),
          eventually: await create(page, { title: uniqueTitle('LR ev'), horizon: 'eventually' }),
          unset: await create(page, { title: uniqueTitle('LR unset') }),
          dated: await create(page, {
            title: uniqueTitle('LR dated'),
            horizon: 'months',
            due_at: new Date(Date.now() + 48 * HOUR).toISOString(),
          }),
        }
        try {
          await gotoDashboard(page)
          const square = (id: number) => row(page, id).locator('[data-lean-done]')
          const border = (id: number) => square(id).locator('[data-horizon-border]')

          // Days: governed, drawn as the plain checkbox itself.
          await expect(square(made.days)).toHaveAttribute('data-horizon-square', 'days')
          await expect(border(made.days)).toHaveCount(0)
          // The patterned steps draw their border.
          for (const h of ['weeks', 'months', 'eventually'] as const) {
            await expect(square(made[h])).toHaveAttribute('data-horizon-square', h)
            await expect(border(made[h])).toHaveCount(1)
          }
          // Unset looks like UNSET_HORIZON (weeks today): the same pattern.
          await expect(square(made.unset)).toHaveAttribute('data-horizon-square', 'weeks')
          expect(await border(made.unset).innerHTML()).toBe(await border(made.weeks).innerHTML())
          // A picked target: the horizon doesn't govern, so the plain checkbox.
          await expect(square(made.dated)).not.toHaveAttribute('data-horizon-square', /.+/)
          await expect(border(made.dated)).toHaveCount(0)

          // Each density draws its own stroke: 1px at 1x, 1.5px at 2x.
          const shown = await border(made.weeks).evaluate((svg) =>
            [...svg.querySelectorAll('g')]
              .filter((g) => getComputedStyle(g).display !== 'none')
              .map((g) => g.getAttribute('stroke-width')),
          )
          expect(shown).toEqual([scale === 1 ? '1' : '1.5'])
        } finally {
          await cleanUp(page, Object.values(made))
        }
      })
    })
  }
})

test.describe('Lean row · actions', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('done, On deck and Today, each with Undo; double-click opens details', async ({
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

      await r.locator('[data-target-today]').click()
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
      await page.mouse.move(x0, y)
      await page.mouse.down()
      for (let x = x0; x <= x0 + 270; x += 15) await page.mouse.move(x, y)
      await page.mouse.up()
      await expect.poll(async () => (await stateOf(page, id)).done).toBe(true)
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
