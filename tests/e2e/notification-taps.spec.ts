/**
 * NOTIFICATION TAPS LAND ON THE DASHBOARD (Trent, 2026-11-09;
 * src/lib/panel-lift.ts). A named reminder push, a quota push and a period
 * push open the dashboard; its Reminders card pages to the item's period and
 * lifts a reminder or quota prompt to the top of it, flashed once, without
 * opening "Show more". Old builds' `/reminders?prompt=` and the widget's
 * `/reminders?reminder=` are redirected there (`next.config.ts`).
 *
 * Time-agnostic: every row is made in a period read from `/api/time-slots`
 * and shows today whatever the hour (the card pages through every period of
 * the day), and every prompt key is read from `GET /api/reminders`.
 */
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

const created: number[] = []

async function userSlots(page: Page): Promise<{ id: number; start_time: string }[]> {
  const res = await page.request.get('/api/time-slots')
  const slots = (await res.json()).data.time_slots as { id: number; start_time: string }[]
  return [...slots].sort((a, b) => a.start_time.localeCompare(b.start_time))
}

/** A daily reminder at the start of this period. */
async function makeReminder(page: Page, title: string, slot: { start_time: string }) {
  const [h, m] = slot.start_time.split(':').map(Number)
  const res = await page.request.post('/api/tasks', {
    data: { title, is_reminder: true, rrule: `FREQ=DAILY;BYHOUR=${h};BYMINUTE=${m}` },
  })
  expect(res.ok()).toBeTruthy()
  const id = (await res.json()).data.id as number
  created.push(id)
  return id
}

/** A daily quota of one, its prompt in this period; returns its prompt key. */
async function makePromptIn(page: Page, title: string, slot: { id: number }) {
  const res = await page.request.post('/api/tasks', {
    data: { title, rrule: 'FREQ=DAILY', progress_target: 1, is_tracked: true },
  })
  expect(res.ok()).toBeTruthy()
  const id = (await res.json()).data.id as number
  created.push(id)
  const placed = await page.request.patch(`/api/tasks/${id}`, {
    data: { quota_prompt_config: { slot_id: slot.id } },
  })
  expect(placed.ok()).toBeTruthy()
  const groups = (await (await page.request.get('/api/reminders')).json()).data.groups as {
    prompts: { prompt_key: string; task_id: number }[]
  }[]
  const key = groups.flatMap((g) => g.prompts).find((p) => p.task_id === id)?.prompt_key
  expect(key).toBeTruthy()
  return key!
}

const card = (page: Page) => page.locator('[data-reminders-panel]:visible')
/** The first row of the card's period list. */
const firstRow = (page: Page) => card(page).locator('ul').first().locator('> li').first()

test.describe('Notification taps land on the dashboard', () => {
  test.afterEach(async ({ authenticatedPage: page }) => {
    if (created.length > 0) {
      await page.request.post('/api/tasks/bulk/delete', { data: { ids: [...created] } })
      created.length = 0
    }
  })

  test('a reminder past the fold is lifted to the top of its period and flashed (phone)', async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    const slots = await userSlots(page)
    const last = slots[slots.length - 1]
    // Six ahead of it: past the phone's cap of five, behind "Show more".
    for (let i = 1; i <= 6; i++) await makeReminder(page, `E2E tap filler ${i}`, last)
    const target = await makeReminder(page, 'E2E tap the pushed reminder', last)
    const row = card(page).locator(`li[data-reminder-id="${target}"]`)

    // Its period, unlifted: the row is there but hidden past the cap.
    await page.goto(`/?slot=${last.id}`)
    await expect(card(page)).toHaveAttribute('data-reminders-slot', String(last.id))
    await expect(row).toHaveCount(1)
    await expect(row).toBeHidden()

    // The push's tap (`/?task=<id>`, native and Web Push alike).
    await page.goto(`/?task=${target}`)
    await expect(card(page)).toHaveAttribute('data-reminders-slot', String(last.id))
    await expect(firstRow(page)).toHaveAttribute('data-reminder-id', String(target))
    await expect(row).toHaveAttribute('data-reminder-highlight', '')
    await expect(row).toBeInViewport()
    // Lifted, not expanded: "Show more" is still there, and nothing opened.
    await expect(card(page).getByRole('button', { name: /Show .*more/ })).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page).toHaveURL('/')
    // The flash plays once; the row stays first while it waits.
    await expect(row).not.toHaveAttribute('data-reminder-highlight', '')
    await expect(firstRow(page)).toHaveAttribute('data-reminder-id', String(target))

    // Considered: it leaves, and the period is back in its own order.
    await row.click()
    await expect(row).toHaveCount(0)
  })

  test('the widget’s /reminders?reminder= lands on the dashboard with the row lifted', async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const slots = await userSlots(page)
    const first = slots[0]
    await makeReminder(page, 'E2E tap filler', first)
    const target = await makeReminder(page, 'E2E tap the widget reminder', first)

    await page.goto(`/reminders?reminder=${target}`)
    await expect(page).toHaveURL('/')
    await expect(card(page)).toHaveAttribute('data-reminders-slot', String(first.id))
    await expect(firstRow(page)).toHaveAttribute('data-reminder-id', String(target))
  })

  test('a quota push lifts its prompt above the period’s reminders, old link included', async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const slots = await userSlots(page)
    const last = slots[slots.length - 1]
    await makeReminder(page, 'E2E tap reminder above the prompt', last)
    const key = await makePromptIn(page, 'E2E tap the pushed quota', last)
    const row = card(page).locator(`li[data-prompt-key="${key}"]`)

    // What a build from before 2026-11-09 loads: redirected, then lifted.
    await page.goto(`/reminders?prompt=${encodeURIComponent(key)}`)
    await expect(page).toHaveURL('/')
    await expect(card(page)).toHaveAttribute('data-reminders-slot', String(last.id))
    await expect(firstRow(page)).toHaveAttribute('data-prompt-key', key)
    await expect(row).toHaveAttribute('data-prompt-highlight', '')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // What this build loads.
    await page.goto(`/?prompt=${encodeURIComponent(key)}`)
    await expect(firstRow(page)).toHaveAttribute('data-prompt-key', key)
    await expect(page).toHaveURL('/')
  })

  test('a period push pages the card to its period', async ({ authenticatedPage: page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const slots = await userSlots(page)
    expect(slots.length).toBeGreaterThan(1)
    const first = slots[0]
    const last = slots[slots.length - 1]
    await makeReminder(page, 'E2E tap something today', first)

    for (const slot of [first, last]) {
      await page.goto(`/?slot=${slot.id}`)
      await expect(card(page)).toHaveAttribute('data-reminders-slot', String(slot.id))
      await expect(page).toHaveURL('/')
    }
  })
})
