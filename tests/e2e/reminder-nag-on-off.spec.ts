/**
 * A REMINDER's Nag is On / Off only (coordinator ruling, 2026-10-26, #368):
 * its pace comes from its priority (the named reminder push, the period nag),
 * so the editor offers no cadence for it. Tasks keep the full picker.
 *
 * Where it shows: the quick panel (`QuickActionPanel`) with its Reminder
 * switch on — a task being made a reminder. (A saved reminder opens
 * `ReminderDetail`, which has no Nag row.)
 *
 * - The trigger reads "On" (title "Nag on"), or the "Nag off" icon.
 * - The picker lists On and Off, nothing else.
 * - Off saves `auto_snooze_minutes: 0`; On from Off saves null (the default).
 * - A stored non-zero value (an old custom cadence) reads as On and is left
 *   alone; the Reminder switch off again shows the task's full picker.
 *
 * At 1280×800 and 375×812, on the task page (`/tasks/<id>`). Invented data,
 * trashed after. Screenshots go to `.tmp/reminder-nag/`.
 */
import { test, expect, uniqueTitle } from './fixtures'
import type { Page } from '@playwright/test'

const SHOTS = '.tmp/reminder-nag'

interface Saved {
  is_reminder: boolean
  auto_snooze_minutes: number | null
}

async function create(page: Page, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data })
  expect(res.ok(), await res.text()).toBeTruthy()
  return (await res.json()).data.id as number
}

async function savedOf(page: Page, id: number): Promise<Saved> {
  const { is_reminder, auto_snooze_minutes } = (
    await (await page.request.get(`/api/tasks/${id}`)).json()
  ).data as Saved
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

const picker = (page: Page) => page.getByTestId('reminder-nag-picker')
const onTrigger = (page: Page) => page.locator('button[title="Nag on"]')

for (const [name, viewport] of [
  ['desktop', { width: 1280, height: 800 }],
  ['mobile', { width: 375, height: 812 }],
] as const) {
  test(`${name}: a reminder's Nag is On / Off only, and toggles`, async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize(viewport)
    const turnOff = await create(page, { title: uniqueTitle('Water the ferns'), priority: 3 })
    const turnOn = await create(page, {
      title: uniqueTitle('Stretch before lunch'),
      priority: 3,
      auto_snooze_minutes: 0,
    })
    const custom = await create(page, {
      title: uniqueTitle('Call the plumber'),
      priority: 3,
      auto_snooze_minutes: 45,
    })
    try {
      const save = page.getByRole('button', { name: 'Save', exact: true })

      // A task: the full picker.
      await page.goto(`/tasks/${turnOff}`)
      await page.locator('button[title^="Nag every"]').click()
      await expect(page.getByText('Custom...')).toBeVisible()
      await page.keyboard.press('Escape')

      // Made a reminder: "On", and the picker holds On and Off only. Off → 0.
      await toggleReminder(page)
      await expect(onTrigger(page)).toHaveText('On')
      await onTrigger(page).click()
      await expect(picker(page).getByRole('menuitemradio')).toHaveText(['On', 'Off'])
      await expect(picker(page).getByRole('menuitemradio', { name: 'On' })).toHaveAttribute(
        'aria-checked',
        'true',
      )
      await expect(page.getByText('Custom...')).toHaveCount(0)
      await page.screenshot({ path: `${SHOTS}/${name}-picker.png` })
      await picker(page).getByRole('menuitemradio', { name: 'Off' }).click()
      await expect(picker(page)).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Nag off' })).toBeVisible()
      await save.click()
      await expect
        .poll(() => savedOf(page, turnOff))
        .toEqual({ is_reminder: true, auto_snooze_minutes: 0 })

      // Nag off, made a reminder, On → null (the default).
      await page.goto(`/tasks/${turnOn}`)
      await toggleReminder(page)
      await page.getByRole('button', { name: 'Nag off' }).click()
      await expect(picker(page).getByRole('menuitemradio', { name: 'Off' })).toHaveAttribute(
        'aria-checked',
        'true',
      )
      await picker(page).getByRole('menuitemradio', { name: 'On' }).click()
      await expect(onTrigger(page)).toHaveText('On')
      await page.screenshot({ path: `${SHOTS}/${name}-on.png` })
      await save.click()
      await expect
        .poll(() => savedOf(page, turnOn))
        .toEqual({ is_reminder: true, auto_snooze_minutes: null })

      // An old custom cadence reads as On, and On leaves it as stored; the
      // switch off again shows the task's own cadence.
      await page.goto(`/tasks/${custom}`)
      await toggleReminder(page)
      await expect(onTrigger(page)).toHaveText('On')
      await onTrigger(page).click()
      await expect(picker(page).getByRole('menuitemradio', { name: 'On' })).toHaveAttribute(
        'aria-checked',
        'true',
      )
      await picker(page).getByRole('menuitemradio', { name: 'On' }).click()
      await expect(picker(page)).toHaveCount(0)
      await toggleReminder(page)
      await expect(page.locator('button[title="Nag every 45m"]')).toBeVisible()
      await expect(save).toBeDisabled()
      expect(await savedOf(page, custom)).toEqual({ is_reminder: false, auto_snooze_minutes: 45 })
    } finally {
      await trash(page, [turnOff, turnOn, custom])
    }
  })
}
