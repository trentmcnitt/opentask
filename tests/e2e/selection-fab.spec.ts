/**
 * Entering and leaving selection mode on the dashboard, and the floating bar
 * that comes with it.
 *
 * Rewritten in the testing pass (WP6): the old tests held the mouse for a
 * hand-timed 500ms, returned early (and passed) when a row had no bounding
 * box, and only asserted that the row was still visible afterwards — true
 * whether or not anything had been selected. These assert the selection
 * itself (`aria-selected`, the bar and its count) and the positive facts
 * around it: the hold selected rather than navigated, and the click the
 * browser synthesises on release did not complete the task.
 *
 * Each test makes its own task under a unique title and trashes it again, and
 * runs in the Unified view so the row is on the page whatever grouping the
 * earlier specs left behind (see selection-tasks.spec.ts).
 */

import {
  test,
  expect,
  cmdClickRow,
  expectClearOnFirstRow,
  holdUntil,
  uniqueTitle,
  waitForPrefsLoaded,
  withPreferences,
} from './fixtures'
import type { Page } from '@playwright/test'

async function createTask(page: Page, title: string): Promise<number> {
  const res = await page.request.post('/api/tasks', { data: { title, priority: 1 } })
  expect(res.ok()).toBeTruthy()
  return (await res.json()).data.id as number
}

async function isDone(page: Page, id: number): Promise<boolean> {
  const res = await page.request.get(`/api/tasks/${id}`)
  return (await res.json()).data.done as boolean
}

const row = (page: Page, id: number) => page.locator(`#task-row-${id}`)
const bar = (page: Page) => page.locator('[data-selection-sheet]')

/** Create `n` tasks, open the dashboard on them, run `body`, trash them. */
async function withTasks(
  page: Page,
  n: number,
  body: (ids: number[], titles: string[]) => Promise<void>,
): Promise<void> {
  const titles = Array.from({ length: n }, (_, i) => uniqueTitle(`Fab task ${i + 1}`))
  const ids: number[] = []
  try {
    for (const title of titles) ids.push(await createTask(page, title))
    await withPreferences(page, { default_grouping: 'unified' }, async () => {
      await waitForPrefsLoaded(page, () => page.goto('/'), row(page, ids[0]))
      // Nothing selected yet: the control for everything below.
      await expect(bar(page)).toHaveCount(0)
      for (const id of ids) await expect(row(page, id)).toHaveAttribute('aria-selected', 'false')
      await body(ids, titles)
    })
  } finally {
    if (ids.length > 0) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
  }
}

test.describe('Selection and the floating bar', () => {
  test('press and hold selects the row and brings up the bar; Escape clears it', async ({
    authenticatedPage: page,
  }) => {
    await withTasks(page, 1, async ([id], [title]) => {
      // Held on the title, not the row's edge (the Done circle is there). The
      // hold ends when the row is selected — no timer to tune.
      await holdUntil(row(page, id).getByText(title, { exact: true }), () =>
        expect(row(page, id)).toHaveAttribute('aria-selected', 'true'),
      )
      await expect(bar(page)).toBeVisible()
      await expect(bar(page).getByRole('button', { name: 'Done', exact: true })).toBeVisible()
      await expect(bar(page).getByRole('button', { name: 'Delete 1 task' })).toBeVisible()
      // The hold selected; the click released after it was swallowed — no
      // navigation, and the task is still open on the server.
      await expect(page).toHaveURL('/')
      expect(await isDone(page, id)).toBe(false)
      await expect(row(page, id)).toHaveAttribute('aria-selected', 'true')

      await page.keyboard.press('Escape')
      await expect(row(page, id)).toHaveAttribute('aria-selected', 'false')
      await expect(bar(page)).toHaveCount(0)
      await expect(row(page, id)).toBeVisible()
    })
  })

  test('Cmd/Ctrl-click adds rows to the selection, and the bar counts them', async ({
    authenticatedPage: page,
  }) => {
    await withTasks(page, 3, async (ids) => {
      await cmdClickRow(row(page, ids[0]))
      await expect(row(page, ids[0])).toHaveAttribute('aria-selected', 'true')
      await expect(bar(page)).toBeVisible()
      // One row: no count, but Details (the single-task link) is offered.
      await expect(bar(page)).not.toContainText('selected')
      await expect(bar(page).getByRole('button', { name: 'Details' })).toBeVisible()

      await cmdClickRow(row(page, ids[1]))
      await expect(bar(page)).toContainText('2 selected')
      await expect(bar(page).getByRole('button', { name: 'Delete 2 tasks' })).toBeVisible()
      await expect(bar(page).getByRole('button', { name: 'Details' })).toHaveCount(0)
      await expect(row(page, ids[2])).toHaveAttribute('aria-selected', 'false')

      // Cmd/Ctrl-click again takes one back out.
      await cmdClickRow(row(page, ids[0]))
      await expect(row(page, ids[0])).toHaveAttribute('aria-selected', 'false')
      await expect(row(page, ids[1])).toHaveAttribute('aria-selected', 'true')
      await expect(bar(page).getByRole('button', { name: 'Delete 1 task' })).toBeVisible()
    })
  })

  test("the bar's X clears the selection and nothing is changed", async ({
    authenticatedPage: page,
  }) => {
    await withTasks(page, 2, async (ids) => {
      for (const id of ids) await cmdClickRow(row(page, id))
      await expect(bar(page)).toContainText('2 selected')

      await bar(page).getByRole('button', { name: 'Clear selection' }).click()
      await expect(bar(page)).toHaveCount(0)
      for (const id of ids) {
        await expect(row(page, id)).toHaveAttribute('aria-selected', 'false')
        await expect(row(page, id)).toBeVisible()
        expect(await isDone(page, id)).toBe(false)
      }
    })
  })
})

test.describe('The floating bar on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test('every verb and Clear stay on screen, at a larger text size too', async ({
    authenticatedPage: page,
  }) => {
    // The bar used to run off the right edge on an iPhone at a larger text
    // size, with Trash cut off and Clear out of reach (2026-10-14).
    await withTasks(page, 1, async ([id]) => {
      for (const rootSize of ['16px', '20px']) {
        await page.evaluate((size) => (document.documentElement.style.fontSize = size), rootSize)
        await cmdClickRow(row(page, id))
        await expect(bar(page)).toBeVisible()
        const buttons = bar(page).getByRole('button')
        await expect(buttons.filter({ hasText: 'Done' })).toBeVisible()
        const width = page.viewportSize()!.width
        for (const button of await buttons.all()) {
          const box = (await button.boundingBox())!
          expect(box.x).toBeGreaterThanOrEqual(0)
          expect(box.x + box.width).toBeLessThanOrEqual(width)
        }
        await bar(page).getByRole('button', { name: 'Clear selection' }).click()
        await expect(bar(page)).toHaveCount(0)
      }
    })
  })

  test('with three selected, Clear stays level with the first row of verbs', async ({
    authenticatedPage: page,
  }) => {
    // At the iOS app's 119% text (19.04px root, ios/OpenTask/WebView.swift)
    // "3 selected · Done · More · trash" fills a 375 bar, and Clear, the last
    // item of the wrapping row, fell to a row of its own (2026-10-26).
    await withTasks(page, 3, async (ids) => {
      for (const rootSize of ['16px', '19.04px', '20px']) {
        await page.evaluate((size) => (document.documentElement.style.fontSize = size), rootSize)
        for (const id of ids) await cmdClickRow(row(page, id))
        await expect(bar(page)).toContainText('3 selected')
        await expectClearOnFirstRow(page, `root ${rootSize}`, { oneRow: rootSize !== '20px' })
        await bar(page).getByRole('button', { name: 'Clear selection' }).click()
        await expect(bar(page)).toHaveCount(0)
      }
    })
  })
})
