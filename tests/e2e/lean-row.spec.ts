/**
 * The lean task row (`src/components/lean-row/LeanRow.tsx`): the dashboard
 * list's row when Settings → Theme → Task rows says Lean. The build default
 * here is the card (CI builds without NEXT_PUBLIC_DEFAULT_TASK_ROWS), so this
 * file sets the device setting itself before each page load — every other
 * spec keeps seeing the card rows.
 *
 * Covers: the row's look (over target: the blue tint, its bar and the slate
 * title in both themes, the target chip still the blue target chip; a passed
 * deadline red with its flag; the created date; no "ago"), its buttons (done,
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

      test('over target: the tint, its bar and the slate title; the chip stays the blue target chip', async ({
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
        ]
        const [over, passed, plain] = ids
        try {
          await gotoDashboard(page)
          for (const id of ids) await expect(row(page, id)).toBeVisible()

          // Over target: the row marked, the slate title, the tint and the bar.
          const o = row(page, over)
          await expect(o).toHaveAttribute('data-over-target', '')
          await expect(o.locator('[data-lean-title]')).toHaveCSS(
            'color',
            scheme === 'light' ? 'rgb(38, 51, 77)' : 'rgb(211, 220, 236)',
          )
          const before = await o.evaluate((el) => {
            const s = getComputedStyle(el, '::before')
            return { bg: s.backgroundColor, shadow: s.boxShadow }
          })
          expect(before.bg).not.toBe('rgba(0, 0, 0, 0)')
          expect(before.shadow).toContain('inset')
          // The target chip: the blue target tone, the moment alone (no "ago").
          const chip = o.locator('[data-time-chip]')
          await expect(chip).toHaveAttribute('data-time-chip', 'target')
          await expect(chip).not.toContainText('ago')
          // "!" after the title, the notes mark, the created date.
          await expect(o.locator('[data-priority-tab]')).toHaveText('!')
          await expect(o.locator('[data-lean-notes]')).toBeVisible()
          await expect(o.locator('[data-created]')).toHaveText(/^today \d{1,2}:\d{2} [AP]M$/)

          // A passed deadline: red, with its flag.
          await expect(row(page, passed).locator('[data-deadline-chip]')).toHaveAttribute(
            'data-deadline-chip',
            'passed',
          )
          // A plain row: not over target, "Low" as a word, the horizon mark.
          await expect(row(page, plain)).not.toHaveAttribute('data-over-target', '')
          await expect(row(page, plain).locator('[data-lean-low]')).toHaveText('Low')
          await expect(row(page, plain).locator('[data-horizon-dot]')).toBeVisible()
        } finally {
          await cleanUp(page, ids)
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

      const box = (await r.boundingBox())!
      const y = box.y + box.height / 2
      await page.mouse.move(box.x + 30, y)
      await page.mouse.down()
      for (let x = box.x + 30; x <= box.x + 300; x += 15) await page.mouse.move(x, y)
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
