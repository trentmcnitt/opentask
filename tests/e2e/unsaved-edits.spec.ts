/**
 * Don't lose the user's edits (cleanup batch X2).
 *
 * Three ways a staged edit used to vanish without a word:
 *
 * - **Escape right after an edit.** The dashboard's quick-action dialog read
 *   its "is the panel dirty?" guard from React state, which trails the panel's
 *   report by a render. Radix hands the Escape to whichever `onOpenChange` it
 *   captured last, so an Escape straight after a chip tap reached a guard that
 *   still thought the panel was clean, and the dialog closed. The guard now
 *   reads a ref written the moment the panel reports (`useEditorHost`).
 *   Playwright's own gap between actions may let the render land first, so
 *   this one guards against a regression more than it reproduces the race.
 * - **A refused save.** The popover closed as soon as Save was pressed, before
 *   the PATCH answered; a 400 then cost the edit. It now closes only once the
 *   save lands, and a refusal keeps it open with the edit and the server's
 *   reason in a toast.
 * - **A failed create.** The add form cleared its title whether or not the
 *   POST worked. It now keeps it and says why.
 *
 * Every task is created here with a unique title and trashed in `finally`.
 * The dashboard runs in the Unified flat list (`'unified'`) so a new row is on
 * the page: no preview cap can put it behind "Show all".
 */
import { test, expect, uniqueTitle, withPreferences } from './fixtures'
import type { Locator, Page } from '@playwright/test'

/** Due in two hours: on the flat list at any time of day. */
async function createTask(page: Page, title: string): Promise<{ id: number; due: string }> {
  const due = new Date(Date.now() + 2 * 3600_000).toISOString()
  const res = await page.request.post('/api/tasks', { data: { title, due_at: due } })
  expect(res.ok()).toBeTruthy()
  const data = (await res.json()).data
  return { id: data.id as number, due: data.due_at as string }
}

async function dueAt(page: Page, id: number): Promise<string | null> {
  const res = await page.request.get(`/api/tasks/${id}`)
  return (await res.json()).data.due_at as string | null
}

/** Double-click the row's own padding (not the title link, not the Done circle). */
async function openQuickPanel(page: Page, id: number): Promise<Locator> {
  await page.goto('/')
  const row = page.locator(`#task-row-${id}`)
  await row.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  const box = await row.boundingBox()
  if (!box) throw new Error('row not on screen')
  await row.dblclick({ position: { x: 56, y: box.height - 6 } })
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeVisible()
  return dialog
}

test.describe('Unsaved edits survive', () => {
  test('Escape straight after a chip asks before discarding', async ({
    authenticatedPage: page,
  }) => {
    const { id, due } = await createTask(page, uniqueTitle('Escape-guard probe'))
    try {
      await withPreferences(page, { default_grouping: 'unified' }, async () => {
        const dialog = await openQuickPanel(page, id)
        await dialog.getByRole('button', { name: '+1 day', exact: true }).click()
        await page.keyboard.press('Escape')

        const unsaved = page.getByRole('alertdialog', { name: 'Unsaved Changes' })
        await expect(unsaved).toBeVisible()

        await unsaved.getByRole('button', { name: "Don't Save" }).click()
        await expect(page.getByRole('dialog')).toHaveCount(0)
        expect(await dueAt(page, id)).toBe(due)
      })
    } finally {
      await page.request.delete(`/api/tasks/${id}`)
    }
  })

  test('a refused save keeps the popover open with the edit', async ({
    authenticatedPage: page,
  }) => {
    const { id, due } = await createTask(page, uniqueTitle('Refused-save probe'))
    try {
      await withPreferences(page, { default_grouping: 'unified' }, async () => {
        const dialog = await openQuickPanel(page, id)
        await dialog.getByRole('button', { name: '+1 day', exact: true }).click()

        await page.route(`**/api/tasks/${id}`, (route) =>
          route.request().method() === 'PATCH'
            ? route.fulfill({
                status: 400,
                contentType: 'application/json',
                body: JSON.stringify({ error: 'Refused by the test', code: 'VALIDATION_ERROR' }),
              })
            : route.fallback(),
        )
        const save = dialog.getByRole('button', { name: 'Save', exact: true })
        await save.click()

        await expect(page.getByText('Refused by the test')).toBeVisible()
        await expect(save).toBeVisible()
        await expect(save).toBeEnabled()
        expect(await dueAt(page, id)).toBe(due)

        // The edit is still staged: Save again, unrefused, stores it and closes.
        await page.unroute(`**/api/tasks/${id}`)
        await save.click()
        await expect(page.getByRole('dialog')).toHaveCount(0)
        await expect.poll(() => dueAt(page, id)).not.toBe(due)
      })
    } finally {
      await page.request.delete(`/api/tasks/${id}`)
    }
  })

  test('a failed create keeps the title and says why', async ({ authenticatedPage: page }) => {
    // The full add form, reached the way a phone reaches it: `+` → quick add →
    // "Add manually" carries the typed title over.
    await page.setViewportSize({ width: 375, height: 812 })
    await page.reload()
    await page.waitForSelector('[id^="task-row-"], .text-4xl', { timeout: 10_000 })
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    const quick = page.getByRole('dialog', { name: 'Quick add' })
    const title = uniqueTitle('Failed-create probe')
    await quick.getByRole('textbox', { name: 'Quick add task' }).fill(title)
    await quick.getByRole('button', { name: 'Add manually' }).click()
    const form = page.getByRole('dialog', { name: 'New Task' })
    await expect(form.getByLabel('Task title')).toHaveValue(title)

    await page.route('**/api/tasks', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'The server said no', code: 'INTERNAL_ERROR' }),
          })
        : route.fallback(),
    )
    await form.getByRole('button', { name: 'Create Task' }).click()

    await expect(page.getByText('The server said no')).toBeVisible()
    await expect(form).toBeVisible()
    await expect(form.getByLabel('Task title')).toHaveValue(title)

    // Retry, unrefused: the task is created from the kept title.
    await page.unroute('**/api/tasks')
    await form.getByRole('button', { name: 'Create Task' }).click()
    await expect(form).toHaveCount(0)
    const found = await page.request.get(`/api/tasks?search=${encodeURIComponent(title)}`)
    const tasks = (await found.json()).data.tasks as { id: number; title: string }[]
    expect(tasks.map((t) => t.title)).toEqual([title])
    for (const t of tasks) await page.request.delete(`/api/tasks/${t.id}`)
  })
})
