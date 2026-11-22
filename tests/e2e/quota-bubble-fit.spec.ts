/**
 * THE QUOTA BUBBLE AT A PHONE'S WIDTH (2026-11-22, the design session): its
 * spacing is tight enough that a quota with its period chips fits at 375 in
 * the common case, and when it doesn't (a short screen, a tall daily quota)
 * a faint fade at the bottom says there is more, gone once scrolled to the
 * end (`useMoreBelow` in TrackChipPopover.tsx).
 *
 * The shared test user, quota reminders on; a unique title, trashed in
 * `finally`.
 */
import { test, expect, uniqueTitle } from './fixtures'
import type { Locator, Page } from '@playwright/test'

interface Slot {
  id: number
  start_time: string
}

async function firstSlot(page: Page): Promise<Slot> {
  const res = await page.request.get('/api/time-slots')
  const slots = (await res.json()).data.time_slots as Slot[]
  return [...slots].sort((a, b) => a.start_time.localeCompare(b.start_time))[0]
}

/** The Reminders card on `slotId`'s page, its rows all shown. */
async function cardOn(page: Page, slotId: number): Promise<Locator> {
  const card = page.locator('section[data-reminders-panel]')
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

async function hold(page: Page, row: Locator, bubble: Locator) {
  await row.scrollIntoViewIfNeeded()
  const box = (await row.boundingBox())!
  await page.mouse.move(box.x + Math.min(120, box.width / 2), box.y + box.height / 2)
  await page.mouse.down()
  await expect(bubble).toBeVisible()
  await page.mouse.up()
}

async function withQuotaBubble(page: Page, run: (bubble: Locator) => Promise<void>) {
  await page.request.patch('/api/user/preferences', { data: { quota_prompts_enabled: true } })
  const slot = await firstSlot(page)
  const title = uniqueTitle('Fit quota')
  const res = await page.request.post('/api/tasks', {
    data: { title, rrule: 'FREQ=WEEKLY', progress_target: 3, is_tracked: true },
  })
  const id = (await res.json()).data.id as number
  try {
    const placed = await page.request.patch(`/api/tasks/${id}`, {
      data: { quota_prompt_config: { enabled: true, slot_id: slot.id } },
    })
    expect(placed.ok()).toBeTruthy()
    await page.goto('/')
    const card = await cardOn(page, slot.id)
    const bubble = page.locator(`[data-track-popover="${id}"]`)
    await hold(page, card.locator('li[data-prompt-key]', { hasText: title }), bubble)
    await run(bubble)
  } finally {
    await page.request.delete(`/api/tasks/${id}`)
  }
}

test.describe.configure({ mode: 'serial' })

test('at 375×812 the bubble fits, or shows the fade while there is more', async ({
  authenticatedPage: page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await withQuotaBubble(page, async (bubble) => {
    await expect(bubble.getByRole('button', { name: 'Open' })).toBeAttached()
    const { scroll, client } = await bubble.evaluate((el) => ({
      scroll: el.scrollHeight,
      client: el.clientHeight,
    }))
    console.log(`quota bubble at 375: content ${scroll}px, room ${client}px`)
    await page.screenshot({ path: '.tmp/screens/quota-bubble-375.png' })
    if (scroll > client + 1) await expect(bubble.locator('[data-bubble-more]')).toBeVisible()
    else await expect(bubble.locator('[data-bubble-more]')).toHaveCount(0)
  })
})

test('on a short screen the fade shows, and goes once scrolled to the end', async ({
  authenticatedPage: page,
}) => {
  await page.setViewportSize({ width: 375, height: 520 })
  await withQuotaBubble(page, async (bubble) => {
    const fade = bubble.locator('[data-bubble-more]')
    await expect(fade).toBeVisible()
    await page.screenshot({ path: '.tmp/screens/quota-bubble-375-short.png' })
    await bubble.evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
    await expect(fade).toHaveCount(0)
    await expect(bubble.getByRole('button', { name: 'Open' })).toBeInViewport()
    await page.screenshot({ path: '.tmp/screens/quota-bubble-375-short-end.png' })
  })
})
