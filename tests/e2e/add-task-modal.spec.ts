/**
 * The phone tab bar's `+` (Trent, 2026-09-29): a quick-add sheet at thumb
 * level — one field, focused on open, submitting through the dashboard's own
 * quick add (so the new task shows in the Just added card) — with an "Add
 * manually" link to the full add-task form `+` used to open.
 */
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

async function openPhoneDashboard(page: Page) {
  // Mobile viewport: the bottom tabs (and their `+`) only exist below `md`.
  await page.setViewportSize({ width: 375, height: 812 })
  // Reload so the mobile layout renders. Wait for task rows to confirm React
  // hydrated and data loaded. Do NOT use networkidle — the SSE sync stream
  // keeps a connection open.
  await page.reload()
  await page.waitForSelector('[id^="task-row-"], .text-4xl', { timeout: 10_000 })
  // Exact match: "Open full add form" also contains "add".
  const addButton = page.getByRole('button', { name: 'Add', exact: true })
  await expect(addButton).toBeVisible({ timeout: 5000 })
  return addButton
}

test.describe('Add task (mobile + tab)', () => {
  test('plus opens the quick-add sheet with its field focused; Enter adds the task and closes it', async ({
    authenticatedPage: page,
  }) => {
    const addButton = await openPhoneDashboard(page)
    await addButton.click()

    const sheet = page.getByRole('dialog', { name: 'Quick add' })
    await expect(sheet).toBeVisible({ timeout: 5000 })
    const field = sheet.getByRole('textbox', { name: 'Quick add task' })
    await expect(field).toBeFocused()
    // It comes to rest at the bottom of the screen, where the thumb (and the
    // keyboard) is — polled, because it slides in.
    await expect
      .poll(async () => {
        const box = (await sheet.boundingBox())!
        return Math.round(box.y + box.height)
      })
      .toBe(812)

    const taskTitle = `E2E quick sheet task ${Date.now()}`
    await field.fill(taskTitle)
    await field.press('Enter')

    await expect(sheet).toBeHidden({ timeout: 5000 })
    // Same path as the top field: the Just added card lists it, and its real
    // row appears in the list.
    await expect(page.locator('[data-just-added-card]').getByText(taskTitle)).toBeVisible({
      timeout: 5000,
    })
    await expect(page.getByRole('link', { name: taskTitle })).toBeVisible({ timeout: 5000 })
  })

  test('Escape closes the sheet without adding', async ({ authenticatedPage: page }) => {
    const addButton = await openPhoneDashboard(page)
    await addButton.click()
    const sheet = page.getByRole('dialog', { name: 'Quick add' })
    await expect(sheet).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(sheet).toBeHidden()
  })

  test('"Add manually" opens the full form, carrying what was typed', async ({
    authenticatedPage: page,
  }) => {
    const addButton = await openPhoneDashboard(page)
    await addButton.click()
    const sheet = page.getByRole('dialog', { name: 'Quick add' })
    await expect(sheet).toBeVisible({ timeout: 5000 })
    const taskTitle = `E2E modal task ${Date.now()}`
    await sheet.getByRole('textbox', { name: 'Quick add task' }).fill(taskTitle)
    await sheet.getByRole('button', { name: 'Add manually' }).click()
    await expect(sheet).toBeHidden()

    // The full form: QuickActionPanel in create mode, a Sheet on mobile with a
    // visually-hidden title "New Task".
    const dialog = page.getByRole('dialog', { name: 'New Task' })
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await expect(dialog.getByLabel('Task title')).toHaveValue(taskTitle)
    // Priority shows as "None" by default in the QuickActionPanel picker
    await expect(dialog.getByText('None')).toBeVisible()
    // Project shows as "Inbox" badge in create mode
    await expect(dialog.getByText('Inbox')).toBeVisible()

    await dialog.getByRole('button', { name: 'Create Task' }).click()

    // Dialog should close and task should appear in the list (its row's title
    // link — the just-added preview above the list shows the title as text)
    await expect(dialog).not.toBeVisible({ timeout: 5000 })
    await expect(page.getByRole('link', { name: taskTitle })).toBeVisible({ timeout: 5000 })
  })

  test('from another page, plus goes to the dashboard and opens the sheet', async ({
    authenticatedPage: page,
  }) => {
    await openPhoneDashboard(page)
    await page.goto('/history')
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await page.waitForURL('/')
    const sheet = page.getByRole('dialog', { name: 'Quick add' })
    await expect(sheet).toBeVisible({ timeout: 5000 })
    await expect(sheet.getByRole('textbox', { name: 'Quick add task' })).toBeFocused()
  })
})
