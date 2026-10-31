/**
 * SHOW IN LIST, EVERY ROW BUBBLE (Trent, 2026-10-31, src/lib/show-in-list.ts):
 * the dashboard Reminders card's bubbles carry "Show in list" beside Open, as
 * a task row's does, and land where the item lives with the same scroll and
 * flash:
 * - a reminder → its row in its period on the Reminders tab;
 * - a quota prompt → its quota's chip on the Quotas tab.
 * The Quotas tab's own chip bubble has none (the chip is right there).
 *
 * And the card's header keeps "EARLY MORNING · 7:00 AM" on one line on an
 * iPhone 16 Pro (402) at the app's 119% text — the TASK QUEUE fix (`compact`).
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
  for (const id of ids) await page.request.delete(`/api/tasks/${id}`)
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

/** Press and hold a row until `bubble` opens. */
async function hold(page: Page, row: Locator, bubble: Locator) {
  const box = (await row.boundingBox())!
  await page.mouse.move(box.x + Math.min(120, box.width / 2), box.y + box.height / 2)
  await page.mouse.down()
  await expect(bubble).toBeVisible()
  await page.mouse.up()
}

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 402, height: 874 } })

test.beforeEach(async ({ authenticatedPage: page }) => {
  await page.request.patch('/api/user/preferences', { data: { quota_prompts_enabled: true } })
})

test("a reminder's bubble: Show in list lands on its row on the Reminders tab", async ({
  authenticatedPage: page,
}) => {
  const [early] = await slots(page)
  const title = uniqueTitle('SIL reminder')
  const id = await reminderIn(page, title, early)
  try {
    await page.goto('/')
    const card = await cardOn(page, early.id)
    const bubble = page.locator(`[data-reminder-popover="${id}"]`)
    await hold(page, card.locator(`li[data-reminder-id="${id}"]`), bubble)
    await expect(bubble.getByRole('button', { name: 'Open' })).toBeVisible()
    await page.screenshot({
      path: '.tmp/screens/sil-reminder-bubble-402.png',
      animations: 'disabled',
    })
    await bubble.locator('[data-show-in-list]').click()
    await page.waitForURL(/\/reminders/)
    const row = page.locator(`li[data-reminder-id="${id}"]`)
    await expect(row).toHaveAttribute('data-reminder-highlight', '')
    await expect(row).toBeInViewport()
    await expect(
      page.locator(`[data-slot-group="${early.label}"] li[data-reminder-id="${id}"]`),
    ).toBeVisible()
  } finally {
    await trash(page, [id])
  }
})

test("a quota prompt's bubble: Show in list lands on its chip on the Quotas tab", async ({
  authenticatedPage: page,
}) => {
  const [early] = await slots(page)
  const title = uniqueTitle('SIL quota')
  const id = await create(page, {
    title,
    rrule: 'FREQ=WEEKLY',
    progress_target: 3,
    is_tracked: true,
  })
  try {
    const placed = await page.request.patch(`/api/tasks/${id}`, {
      data: { quota_prompt_config: { enabled: true, slot_id: early.id } },
    })
    expect(placed.ok()).toBeTruthy()
    await page.goto('/')
    const card = await cardOn(page, early.id)
    const bubble = page.locator(`[data-track-popover="${id}"]`)
    await hold(page, card.locator('li[data-prompt-key]', { hasText: title }), bubble)
    await expect(bubble.locator('[data-show-in-list]')).toBeVisible()
    await page.screenshot({ path: '.tmp/screens/sil-quota-bubble-402.png', animations: 'disabled' })
    await bubble.locator('[data-show-in-list]').click()
    await page.waitForURL(/\/quotas/)
    const chip = page.locator(`[data-track-chip="${id}"]`)
    await expect(chip).toHaveAttribute('data-quota-highlight', '')
    await expect(chip).toBeInViewport()
    await page.screenshot({ path: '.tmp/screens/sil-quota-landed-402.png', animations: 'disabled' })

    // The Quotas tab's own chip bubble (a hold selects the chip there; the
    // bubble is the bar's Details): no Show in list, the chip is right here.
    await chip.click({ delay: 500 })
    await page
      .locator('[data-quota-selection-bar]')
      .getByRole('button', { name: 'Details', exact: true })
      .click()
    const own = page.locator(`[data-track-popover="${id}"]`)
    await expect(own.getByRole('button', { name: 'Open' })).toBeVisible()
    await expect(own.locator('[data-show-in-list]')).toHaveCount(0)
  } finally {
    await trash(page, [id])
  }
})

test("the card's header keeps EARLY MORNING · 7:00 AM on one line at 402 and 119% text", async ({
  authenticatedPage: page,
}) => {
  const [early] = await slots(page)
  const id = await reminderIn(page, uniqueTitle('SIL header'), early)
  try {
    await page.goto('/')
    // An iPhone 16 Pro at the app's 119% text (ios/OpenTask/WebView.swift).
    await page.evaluate(() => (document.documentElement.style.fontSize = '19.04px'))
    const card = await cardOn(page, early.id)
    const title = card.locator('[data-slot-header-toggle] > span')
    await expect(title).toContainText(early.label)
    const lines = await title.evaluate((el) => {
      const range = document.createRange()
      range.selectNodeContents(el)
      return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size
    })
    expect(lines).toBe(1)
    await page.screenshot({ path: '.tmp/screens/sil-header-402.png', animations: 'disabled' })
  } finally {
    await trash(page, [id])
  }
})
