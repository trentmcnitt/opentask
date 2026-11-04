/**
 * A POPOVER INSIDE THE DETAILS DIALOG SCROLLS WITH THE WHEEL (Trent, 11-04,
 * Mac app): the Target picker of a task with a deadline (Before the deadline,
 * the period buttons, the calendar) is taller than the room below the Target
 * row, so it scrolls inside. Dragging its scrollbar worked; the wheel did
 * nothing.
 *
 * The cause: the dialog's scroll lock (Radix Dialog → react-remove-scroll)
 * cancels every wheel event outside the dialog's own content, and a Popover
 * is portaled to <body>, outside it. A scrollbar drag is not a wheel event,
 * so it got through. `PopoverContent` (src/components/ui/popover.tsx) now
 * takes its own lock while it is open inside a dialog or sheet.
 *
 * At 1280 × 800 (the details dialog, the wheel) and 375 × 812 (the details
 * sheet, a finger: the same lock cancelled touchmove).
 */
import { DateTime } from 'luxon'
import { test, expect, uniqueTitle, waitForPrefsLoaded, withPreferences } from './fixtures'
import type { Locator, Page } from '@playwright/test'

const TZ = process.env.E2E_TZ || 'America/Chicago'
test.use({ timezoneId: TZ })

/** A one-off with a deadline six days out: its picker has Before the deadline. */
async function deadlineTask(page: Page, title: string): Promise<number> {
  const deadline = DateTime.now()
    .setZone(TZ)
    .plus({ days: 6 })
    .set({ hour: 8, minute: 30, second: 0, millisecond: 0 })
  const res = await page.request.post('/api/tasks', {
    data: { title: uniqueTitle(title), deadline_at: deadline.toUTC().toISO() },
  })
  expect(res.ok(), await res.text()).toBeTruthy()
  return (await res.json()).data.id as number
}

/** Every running animation (the picker opening) has finished. */
async function settle(page: Page) {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))
}

const scrollTop = (el: Locator) => el.evaluate((n) => n.scrollTop)
const overflow = (el: Locator) => el.evaluate((n) => n.scrollHeight - n.clientHeight)

/** The open Target picker (the popover holding Before the deadline). */
function targetPicker(page: Page) {
  return page.locator('[data-slot="popover-content"]', {
    has: page.locator('[data-before-deadline]'),
  })
}

test('the Target picker in task details scrolls with the mouse wheel', async ({
  authenticatedPage: page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const id = await deadlineTask(page, 'Return the borrowed ladder')
  try {
    await withPreferences(page, { default_grouping: 'unified' }, async () => {
      const row = page.locator(`#task-row-${id}`)
      await waitForPrefsLoaded(page, () => page.goto('/'), row)
      await row.evaluate((el) => el.scrollIntoView({ block: 'center' }))
      await row.dblclick()
      const dialog = page.getByRole('dialog')
      await expect(dialog.locator('[data-this-one]')).toBeVisible()
      await dialog.getByRole('button', { name: 'Target: change' }).click()

      const picker = targetPicker(page)
      await expect(picker).toBeVisible()
      await settle(page)
      // Taller than its room: it scrolls inside (the premise of the bug).
      const room = await overflow(picker)
      expect(room).toBeGreaterThan(0)
      expect(await scrollTop(picker)).toBe(0)

      const box = (await picker.boundingBox())!
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.wheel(0, 200)
      await expect.poll(() => scrollTop(picker)).toBeGreaterThan(0)

      // And back up.
      await page.mouse.wheel(0, -1000)
      await expect.poll(() => scrollTop(picker)).toBe(0)

      // Closing the picker leaves the dialog open.
      await page.keyboard.press('Escape')
      await expect(picker).toHaveCount(0)
      await expect(dialog).toBeVisible()
    })
  } finally {
    await page.request.post('/api/tasks/bulk/delete', { data: { ids: [id] } })
  }
})

test.describe('phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true })
  // The swipe is Chromium's gesture synthesis (CDP); WebKit has none.
  test.skip(({ browserName }) => browserName !== 'chromium', 'CDP touch gesture: Chromium only')

  test('the Target picker in the details sheet scrolls with a finger', async ({
    authenticatedPage: page,
  }) => {
    const id = await deadlineTask(page, 'Drop off the spare keys')
    try {
      await withPreferences(page, { default_grouping: 'unified' }, async () => {
        const row = page.locator(`#task-row-${id}`)
        await waitForPrefsLoaded(page, () => page.goto('/'), row)
        await row.evaluate((el) => el.scrollIntoView({ block: 'center' }))
        const rowBox = (await row.boundingBox())!
        // The row's own padding (not the title link, not the Done circle).
        await row.tap({ position: { x: 56, y: rowBox.height - 6 } })
        const sheet = page.locator('[data-slot="sheet-content"]')
        await expect(sheet.getByRole('button', { name: 'Save' })).toBeVisible()
        await sheet.getByRole('button', { name: 'Target: change' }).tap()

        const picker = targetPicker(page)
        await expect(picker).toBeVisible()
        await settle(page)
        expect(await overflow(picker)).toBeGreaterThan(0)
        expect(await scrollTop(picker)).toBe(0)

        // A real touch swipe up inside the picker (Chromium's gesture
        // synthesis: touchstart, touchmoves, touchend, as a finger sends).
        const box = (await picker.boundingBox())!
        const cdp = await page.context().newCDPSession(page)
        await cdp.send('Input.synthesizeScrollGesture', {
          x: Math.round(box.x + box.width / 2),
          y: Math.round(box.y + box.height * 0.7),
          yDistance: -200,
          gestureSourceType: 'touch',
          speed: 800,
        })
        await expect.poll(() => scrollTop(picker)).toBeGreaterThan(0)
      })
    } finally {
      await page.request.post('/api/tasks/bulk/delete', { data: { ids: [id] } })
    }
  })
})
