/**
 * SELECT ON THE DASHBOARD'S REMINDERS CARD (2026-11-27, Trent: "Is there a
 * reason we never enabled multi-select on reminder panel items?"):
 * `ReminderCardSelection.tsx`. A "Select" pill in the card's header, where
 * the Task queue card has its own, turns the page's rows into checkboxes; a
 * tap picks a row (never considers it); /reminders' bar acts on the pick;
 * Select turns off when the card changes period.
 *
 * The shared test user, quota reminders on; unique titles, every item trashed
 * in `finally`.
 */
import { test, expect, uniqueTitle } from './fixtures'
import type { Locator, Page } from '@playwright/test'

interface Slot {
  id: number
  label: string
  start_time: string
}

async function slots(page: Page): Promise<Slot[]> {
  const res = await page.request.get('/api/time-slots')
  return [...((await res.json()).data.time_slots as Slot[])].sort((a, b) =>
    a.start_time.localeCompare(b.start_time),
  )
}

async function create(page: Page, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data })
  expect(res.ok(), JSON.stringify(data)).toBeTruthy()
  return (await res.json()).data.id as number
}

async function reminderIn(page: Page, title: string, slot: Slot): Promise<number> {
  const [h, m] = slot.start_time.split(':').map(Number)
  return create(page, { title, is_reminder: true, rrule: `FREQ=DAILY;BYHOUR=${h};BYMINUTE=${m}` })
}

async function trash(page: Page, ids: number[]) {
  if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
}

/** Whether a reminder was considered today, by the server. */
async function considered(page: Page, id: number): Promise<boolean> {
  const res = await page.request.get('/api/reminders')
  const groups = (await res.json()).data.groups as {
    reminders: { id: number }[]
    considered_items?: { id: number }[]
  }[]
  return groups.some((g) => (g.considered_items ?? []).some((r) => r.id === id))
}

const panel = (page: Page) => page.locator('section[data-reminders-panel]')

/** The card on the page of `slotId`, its rows all shown. */
async function cardOn(page: Page, slotId: number): Promise<Locator> {
  const card = panel(page)
  await expect(card).toBeVisible()
  for (let i = 0; i < 10; i++) {
    const at = Number(await card.getAttribute('data-reminders-slot'))
    if (at === slotId) break
    const prev = card.getByRole('button', { name: 'Previous time slot' })
    await (
      at > slotId && (await prev.isEnabled())
        ? prev
        : card.getByRole('button', { name: 'Next time slot' })
    ).click()
  }
  await expect(card).toHaveAttribute('data-reminders-slot', String(slotId))
  const more = card.getByRole('button', { name: /show more/i })
  if (await more.isVisible()) await more.click()
  return card
}

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ authenticatedPage: page }) => {
  await page.request.patch('/api/user/preferences', { data: { quota_prompts_enabled: true } })
})

for (const [name, viewport] of [
  ['phone', { width: 375, height: 812 }],
  ['desktop', { width: 1280, height: 800 }],
] as const) {
  test(`${name}: Select picks rows, Consider takes them in one go, Select stays on`, async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize(viewport)
    const [first] = await slots(page)
    const ids = [
      await reminderIn(page, uniqueTitle('Card select one'), first),
      await reminderIn(page, uniqueTitle('Card select two'), first),
      await reminderIn(page, uniqueTitle('Card select three'), first),
    ]
    try {
      await page.goto('/')
      const card = await cardOn(page, first.id)
      const row = (id: number) => card.locator(`li[data-reminder-id="${id}"]`)
      const pill = card.locator('[data-queue-select-toggle]:visible')
      await expect(pill).toHaveAttribute('aria-pressed', 'false')
      await pill.click()
      await expect(pill).toHaveAttribute('aria-pressed', 'true')
      // Checkboxes, and a tap picks a row instead of considering it.
      await expect(row(ids[0]).getByRole('checkbox')).toBeVisible()
      await row(ids[0]).click()
      await row(ids[1]).getByRole('checkbox').click()
      await expect(row(ids[0])).toHaveAttribute('aria-selected', 'true')
      const bar = page.locator('[data-selection-sheet]')
      await expect(bar).toContainText('2 selected')
      expect(await considered(page, ids[0])).toBe(false)
      await page.screenshot({
        path: `.tmp/screens/card-select-${name}.png`,
        animations: 'disabled',
      })

      await bar.getByRole('button', { name: 'Consider' }).click()
      await expect.poll(() => considered(page, ids[0])).toBe(true)
      await expect.poll(() => considered(page, ids[1])).toBe(true)
      expect(await considered(page, ids[2])).toBe(false)
      // Entered with the pill: still on, nothing picked.
      await expect(pill).toHaveAttribute('aria-pressed', 'true')
      await expect(bar).toHaveCount(0)

      // The pill turns it off: the circle considers again.
      await pill.click()
      await expect(row(ids[2]).getByRole('checkbox')).toHaveCount(0)
    } finally {
      await trash(page, ids)
    }
  })
}

test('Select turns off when the card changes period; a quota prompt in the pick asks before Delete', async ({
  authenticatedPage: page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const [first, second] = await slots(page)
  const quotaTitle = uniqueTitle('Card select quota')
  const ids = [await reminderIn(page, uniqueTitle('Card select r'), first)]
  ids.push(await reminderIn(page, uniqueTitle('Card select later'), second))
  const quotaId = await create(page, {
    title: quotaTitle,
    rrule: 'FREQ=WEEKLY',
    progress_target: 3,
    is_tracked: true,
  })
  ids.push(quotaId)
  try {
    const placed = await page.request.patch(`/api/tasks/${quotaId}`, {
      data: { quota_prompt_config: { enabled: true, slot_id: first.id } },
    })
    expect(placed.ok()).toBeTruthy()
    await page.goto('/')
    const card = await cardOn(page, first.id)
    const pill = card.locator('[data-queue-select-toggle]:visible')
    await pill.click()
    await card.locator(`li[data-reminder-id="${ids[0]}"]`).click()
    await card.locator('li[data-prompt-key]', { hasText: quotaTitle }).click()
    const bar = page.locator('[data-selection-sheet]')
    await expect(bar).toContainText('2 selected')

    // Delete with a prompt picked: the one confirmation; Cancel keeps it all.
    await bar.getByRole('button', { name: 'Move 2 to Trash' }).click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toContainText(quotaTitle)
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(bar).toContainText('2 selected')

    // Paging the card to another period turns Select off.
    await card.getByRole('button', { name: 'Next time slot' }).click()
    await expect(bar).toHaveCount(0)
    await expect(pill).toHaveAttribute('aria-pressed', 'false')
  } finally {
    await trash(page, ids)
  }
})

for (const [name, viewport, fontSize] of [
  ['phone-402-119', { width: 402, height: 874 }, '19.04px'],
  ['desktop', { width: 1280, height: 800 }, null],
] as const) {
  test(`${name}: Select sits left of Consider all; the header stays one line`, async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize(viewport)
    const [first] = await slots(page)
    const ids = [
      await reminderIn(page, uniqueTitle('Card select layout one'), first),
      await reminderIn(page, uniqueTitle('Card select layout two'), first),
    ]
    try {
      await page.goto('/')
      // An iPhone 16 Pro at the app's 119% text (ios/OpenTask/WebView.swift).
      if (fontSize)
        await page.evaluate((f) => (document.documentElement.style.fontSize = f), fontSize)
      const card = await cardOn(page, first.id)
      const title = card.locator('[data-slot-header-toggle] > span')
      const lines = await title.evaluate((el) => {
        const range = document.createRange()
        range.selectNodeContents(el)
        return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size
      })
      expect(lines).toBe(1)
      const pill = card.locator('[data-queue-select-toggle]:visible')
      const sweep = card.getByRole('button', { name: /^Consider all in / }).locator('visible=true')
      await expect(pill).toBeVisible()
      const [p, s] = [(await pill.boundingBox())!, (await sweep.boundingBox())!]
      expect(p.x + p.width).toBeLessThanOrEqual(s.x)
      expect(Math.abs(p.y + p.height / 2 - (s.y + s.height / 2))).toBeLessThan(4)
      await card.evaluate((el) => el.scrollIntoView({ block: 'center' }))
      await page.screenshot({
        path: `.tmp/screens/card-select-line-${name}.png`,
        animations: 'disabled',
      })
      await pill.click()
      await card.locator(`li[data-reminder-id="${ids[0]}"]`).click()
      await page.screenshot({
        path: `.tmp/screens/card-select-picked-${name}.png`,
        animations: 'disabled',
      })
    } finally {
      await trash(page, ids)
    }
  })
}
