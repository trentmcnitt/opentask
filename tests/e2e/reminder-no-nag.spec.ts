/**
 * Reminders have no Nag option (Trent, 2026-10-26: "Turn off every
 * nag-specific option for reminders"). Priority is the one dial: it alone
 * decides whether a reminder is pushed by name, and how often. Tasks keep
 * their Nag picker unchanged.
 *
 * - The quick panel (`/tasks/<id>`, a task): the Nag trigger is there; with
 *   the Reminder switch on it is gone, and back when the switch is off. The
 *   task's stored value is never rewritten by making it a reminder.
 * - The new-reminder form (Reminders → Add): no Nag row.
 *
 * At 1280×800 and 375×812. Invented data, trashed after. Screenshots go to
 * `.tmp/reminder-no-nag/`.
 */
import { test, expect, uniqueTitle } from './fixtures'
import type { Locator, Page } from '@playwright/test'

const SHOTS = '.tmp/reminder-no-nag'

async function create(page: Page, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data })
  expect(res.ok(), await res.text()).toBeTruthy()
  return (await res.json()).data.id as number
}

async function savedOf(page: Page, id: number) {
  const { is_reminder, auto_snooze_minutes } = (
    await (await page.request.get(`/api/tasks/${id}`)).json()
  ).data as { is_reminder: boolean; auto_snooze_minutes: number | null }
  return { is_reminder, auto_snooze_minutes }
}

async function trash(page: Page, ids: number[]) {
  if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
}

/** Flip the quick panel's Reminder switch (More options → Reminder). */
async function toggleReminder(page: Page) {
  await page.getByRole('button', { name: 'More options' }).click()
  await page.getByRole('menuitemcheckbox', { name: 'Reminder' }).click()
  await page.keyboard.press('Escape')
}

/** Every form the Nag trigger takes: a cadence ("Nag every 30m"), "Nag off", "Nag: mixed". */
function nagTriggers(scope: Page | Locator) {
  return scope.locator('button[title^="Nag"]')
}

for (const [name, viewport] of [
  ['desktop', { width: 1280, height: 800 }],
  ['mobile', { width: 375, height: 812 }],
] as const) {
  test(`${name}: the quick panel's Reminder switch takes the Nag row away`, async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize(viewport)
    const plain = await create(page, { title: uniqueTitle('Water the ferns'), priority: 3 })
    const nagOff = await create(page, {
      title: uniqueTitle('Return the library book'),
      priority: 2,
      auto_snooze_minutes: 0,
    })
    try {
      // A task: its Nag trigger; the Reminder switch on: none; off: back.
      await page.goto(`/tasks/${plain}`)
      await expect(page.locator('button[title^="Nag every"]')).toBeVisible()
      await toggleReminder(page)
      await expect(nagTriggers(page)).toHaveCount(0)
      await page.screenshot({ path: `${SHOTS}/${name}-convert.png` })
      await toggleReminder(page)
      await expect(page.locator('button[title^="Nag every"]')).toBeVisible()

      // A task with Nag off: the switch on hides it too, and saving the
      // conversion keeps the stored value as it was.
      await page.goto(`/tasks/${nagOff}`)
      await expect(page.getByRole('button', { name: 'Nag off' })).toBeVisible()
      await toggleReminder(page)
      await expect(nagTriggers(page)).toHaveCount(0)
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect
        .poll(() => savedOf(page, nagOff))
        .toEqual({ is_reminder: true, auto_snooze_minutes: 0 })
    } finally {
      await trash(page, [plain, nagOff])
    }
  })

  test(`${name}: the new-reminder form has no Nag row`, async ({ authenticatedPage: page }) => {
    await page.setViewportSize(viewport)
    await page.goto('/reminders')
    await expect(
      page.getByRole('region', { name: 'Reminders' }).getByRole('heading').first(),
    ).toBeVisible()
    await page
      .getByRole('button', { name: name === 'desktop' ? 'Add Reminder' : 'Add', exact: true })
      .filter({ visible: true })
      .first()
      .click()
    const dialog = page.getByRole('dialog', { name: 'New reminder' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('textbox', { name: 'Reminder text' })).toBeVisible()
    // The whole form is there (so "no Nag" is not vacuous): its rows end at
    // Priority and Notes.
    await expect(dialog.getByRole('button', { name: 'High', exact: true })).toBeVisible()
    await expect(dialog.getByText('Notes', { exact: true })).toBeVisible()
    await expect(nagTriggers(dialog)).toHaveCount(0)
    await expect(dialog.getByRole('heading', { name: /nag/i })).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: /^nag/i })).toHaveCount(0)
    // Past the open animation, for the screenshot.
    await expect(dialog).toHaveCSS('opacity', '1')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click({ trial: true })
    await page.screenshot({ path: `${SHOTS}/${name}-create.png` })
  })
}
