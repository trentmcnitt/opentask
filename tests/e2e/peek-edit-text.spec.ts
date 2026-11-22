/**
 * A HOLD BUBBLE'S TITLE AND NOTE, EDITED IN PLACE (2026-11-22, Trent via the
 * design session: "as the task selection bubble is", #497). The dashboard
 * Reminders card's reminder and quota-prompt bubbles, and the Quotas tab's
 * chip bubble: click the title or the note line to type, Enter (or leaving
 * the field, or closing the bubble) saves, Escape puts it back and keeps the
 * bubble, a note takes a new line with Shift+Enter, Undo on the toast.
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

async function read(page: Page, id: number): Promise<{ title: string; notes: string | null }> {
  const res = await page.request.get(`/api/tasks/${id}`)
  return (await res.json()).data
}

async function trash(page: Page, ids: number[]) {
  for (const id of ids) await page.request.delete(`/api/tasks/${id}`)
}

const panel = (page: Page) => page.locator('section[data-reminders-panel]')
const toast = (page: Page, text: string) =>
  page.locator('[data-sonner-toast]').filter({ hasText: text })

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

test.beforeEach(async ({ authenticatedPage: page }) => {
  await page.request.patch('/api/user/preferences', { data: { quota_prompts_enabled: true } })
})

test("a reminder's bubble: rename with Enter, Undo, Escape keeps the bubble, a two-line note", async ({
  authenticatedPage: page,
}) => {
  const [early] = await slots(page)
  const title = uniqueTitle('PE reminder')
  const [h, m] = early.start_time.split(':').map(Number)
  const id = await create(page, {
    title,
    is_reminder: true,
    rrule: `FREQ=DAILY;BYHOUR=${h};BYMINUTE=${m}`,
  })
  try {
    await page.goto('/')
    const card = await cardOn(page, early.id)
    const row = card.locator(`li[data-reminder-id="${id}"]`)
    const bubble = page.locator(`[data-reminder-popover="${id}"]`)
    await hold(page, row, bubble)

    // The title: click, type, Enter.
    await bubble.locator('[data-peek-edit="title"]').click()
    const field = bubble.locator('[data-peek-edit-field="title"]')
    await expect(field).toBeFocused()
    await field.fill(`${title} renamed`)
    await field.press('Enter')
    await expect(toast(page, 'Renamed')).toBeVisible()
    await expect(bubble.locator('[data-peek-edit="title"]')).toHaveText(`${title} renamed`)
    await expect.poll(async () => (await read(page, id)).title).toBe(`${title} renamed`)
    await expect(row).toContainText(`${title} renamed`)

    // Undo puts the old title back. The toast is outside the bubble, so the
    // press closes it.
    await toast(page, 'Renamed').getByRole('button', { name: 'Undo' }).click()
    await expect.poll(async () => (await read(page, id)).title).toBe(title)
    await expect(bubble).toBeHidden()

    // Escape: the field reverts and the bubble stays.
    await expect(row).toContainText(title)
    await hold(page, row, bubble)
    await bubble.locator('[data-peek-edit="title"]').click()
    await bubble.locator('[data-peek-edit-field="title"]').fill('Never saved')
    await page.keyboard.press('Escape')
    await expect(bubble).toBeVisible()
    await expect(bubble.locator('[data-peek-edit="title"]')).toHaveText(title)
    expect((await read(page, id)).title).toBe(title)

    // The note: the empty line is a button; Shift+Enter is a new line,
    // leaving the field saves.
    const note = bubble.locator('[data-peek-edit="note"]')
    await expect(note).toContainText('No note yet — click to say')
    await note.click()
    const noteField = bubble.locator('[data-peek-edit-field="note"]')
    await noteField.pressSequentially('First line')
    await noteField.press('Shift+Enter')
    await noteField.pressSequentially('Second line')
    await page.screenshot({ path: '.tmp/screens/peek-edit-reminder-note.png' })
    await bubble.locator('[data-peek-edit="title"]').click()
    await expect.poll(async () => (await read(page, id)).notes).toBe('First line\nSecond line')
    // The reminder editor's own toast (the server's description), with Undo.
    await expect(
      page.locator('[data-sonner-toast]').getByRole('button', { name: 'Undo' }).last(),
    ).toBeVisible()
  } finally {
    await trash(page, [id])
  }
})

test("a quota prompt's bubble: the title by Enter, the note saved by closing the bubble", async ({
  authenticatedPage: page,
}) => {
  const [early] = await slots(page)
  const title = uniqueTitle('PE quota')
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

    await bubble.locator('[data-peek-edit="title"]').click()
    await bubble.locator('[data-peek-edit-field="title"]').fill(`${title} renamed`)
    await page.keyboard.press('Enter')
    await expect(toast(page, 'Renamed')).toBeVisible()
    await expect.poll(async () => (await read(page, id)).title).toBe(`${title} renamed`)
    await expect(bubble).toBeVisible()

    // A press outside the bubble closes it with the note field open: saved.
    await bubble.locator('[data-peek-edit="note"]').click()
    await bubble.locator('[data-peek-edit-field="note"]').fill('Why this one counts')
    await page.screenshot({ path: '.tmp/screens/peek-edit-quota-note.png' })
    await page.mouse.click(5, 5)
    await expect(bubble).toBeHidden()
    await expect.poll(async () => (await read(page, id)).notes).toBe('Why this one counts')
  } finally {
    await trash(page, [id])
  }
})

test("the Quotas tab's chip bubble: rename, and clearing the note removes it", async ({
  authenticatedPage: page,
}) => {
  const title = uniqueTitle('PE chip')
  const id = await create(page, {
    title,
    rrule: 'FREQ=WEEKLY',
    progress_target: 2,
    is_tracked: true,
    notes: 'An old note',
  })
  try {
    await page.goto(`/quotas?quota=${id}`)
    const chip = page.locator(`[data-track-chip="${id}"]`)
    await expect(chip).toBeVisible()
    await chip.click({ delay: 500 })
    await page
      .locator('[data-quota-selection-bar]')
      .getByRole('button', { name: 'Details', exact: true })
      .click()
    const bubble = page.locator(`[data-track-popover="${id}"]`)
    await expect(bubble.getByRole('button', { name: 'Open' })).toBeVisible()

    await bubble.locator('[data-peek-edit="title"]').click()
    await bubble.locator('[data-peek-edit-field="title"]').fill(`${title} renamed`)
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await read(page, id)).title).toBe(`${title} renamed`)

    await bubble.locator('[data-peek-edit="note"]').click()
    await bubble.locator('[data-peek-edit-field="note"]').fill('')
    await page.keyboard.press('Enter')
    await expect(toast(page, 'Note removed')).toBeVisible()
    await expect.poll(async () => (await read(page, id)).notes).toBeNull()
  } finally {
    await trash(page, [id])
  }
})
